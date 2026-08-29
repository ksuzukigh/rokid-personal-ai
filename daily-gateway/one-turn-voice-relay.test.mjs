import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createNewDocumentCoordinator } from './new-document-action.mjs';
import { createOneTurnVoiceProcessor, createOneTurnVoiceRelay } from './one-turn-voice-relay.mjs';

const recordConversation = async () => ({ recorded: true });

test('AIの聞き返しと利用者の返答を同じCodex作業へ渡す', async () => {
  const sent = [];
  const records = [];
  let transcriptCount = 0;
  let closeCount = 0;
  const conversation = {
    async send(request, { signal }) {
      sent.push({ request, signal });
      return sent.length === 1
        ? { message: 'どの文書を指していますか？', needsUserInput: true, effectProposal: null }
        : { message: '「旅行メモ」として承りました。', needsUserInput: false, effectProposal: null };
    },
    async close() { closeCount += 1; },
  };
  const processor = createOneTurnVoiceProcessor({
    conversation,
    async transcribe() {
      transcriptCount += 1;
      return { text: transcriptCount === 1 ? 'Obsidianの文書を見て' : '旅行メモのこと' };
    },
    async recordConversation(entry) {
      records.push(entry);
      return { recorded: true };
    },
  });
  const signal = new AbortController().signal;
  const first = await processor(Buffer.from([0, 0]), { signal });
  const second = await processor(Buffer.from([0, 0]), { signal });

  assert.equal(first.requestHandledAs, 'codex_conversation_turn');
  assert.equal(first.needsUserInput, true);
  assert.equal(first.usedPreviousTurn, false);
  assert.equal(first.completed, false);
  assert.equal(first.sessionScoped, true);
  assert.equal(first.effectProposal, null);
  assert.equal(first.operation, undefined);
  assert.equal(second.needsUserInput, false);
  assert.equal(second.usedPreviousTurn, true);
  assert.equal(second.completed, true);
  assert.deepEqual(sent.map(({ request }) => request), ['Obsidianの文書を見て', '旅行メモのこと']);
  assert.deepEqual(records.map(({ usedPreviousTurn, completed }) => ({ usedPreviousTurn, completed })), [
    { usedPreviousTurn: false, completed: false },
    { usedPreviousTurn: true, completed: true },
  ]);
  await processor.close();
  await processor.close();
  assert.equal(closeCount, 1);
});

test('Codexの自由な依頼を固定保存先の確認券へ結び付け、別確認後だけ実行する', async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), 'rokid-codex-effect-'));
  const allowedParent = path.join(fixture, 'vault');
  await mkdir(allowedParent);
  const root = path.join(allowedParent, '作成文書', '私のAI');
  const coordinator = createNewDocumentCoordinator({
    allowedParent,
    root,
    recordAction: async () => {},
  });
  const token = randomBytes(32).toString('hex');
  let closeCount = 0;
  const relay = createOneTurnVoiceRelay({
    token,
    ttlMs: 15_000,
    documentCoordinator: coordinator,
    recordConversation,
    async transcribe() { return { text: '安全検証メモをObsidianへ保存して' }; },
    conversation: {
      async send() {
        return {
          message: '保存する内容を確認してください。',
          needsUserInput: false,
          effectProposal: {
            action: 'create_obsidian_markdown',
            summary: '安全検証メモを保存',
            details: '固定保存先へ新規作成',
            title: '安全検証メモ',
            body: '共通境界の確認です。',
          },
        };
      },
      async close() { closeCount += 1; },
    },
  });
  const address = await relay.listen();
  const baseUrl = `http://${address.host}:${address.port}`;
  const authorization = `Bearer ${token}`;
  try {
    const response = await fetch(`${baseUrl}/v1/transcribe`, {
      method: 'POST',
      headers: {
        authorization,
        'content-type': 'application/octet-stream',
        'x-request-id': 'codex_effect_01',
        'x-audio-format': 'pcm_s16le',
        'x-sample-rate': '16000',
        'x-channels': '1',
      },
      body: Buffer.from([0, 0]),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.effectProposal.summary, '新規文書「安全検証メモ」を作成');
    assert.equal(body.effectProposal.targetHint, '私のAI 作成文書');
    assert.equal(body.effectProposal.title, '安全検証メモ');
    assert.equal(body.effectProposal.preview, '共通境界の確認です。');
    assert.equal(typeof body.effectProposal.ticketId, 'string');
    assert.equal(body.changed, false);
    assert.equal(body.operation, undefined);
    assert.equal(body.ticketId, undefined);
    await assert.rejects(() => readFile(path.join(root, '安全検証メモ.md')));

    const oldRoute = await fetch(`${baseUrl}/v1/confirm-document`, {
      method: 'POST', headers: { authorization, 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(oldRoute.status, 404);
    const ticket = {
      ticketId: body.effectProposal.ticketId,
      candidateId: body.effectProposal.candidateId,
      confirmationToken: body.effectProposal.confirmationToken,
    };
    const confirmed = await fetch(`${baseUrl}/v1/confirm-effect`, {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/json' },
      body: JSON.stringify(ticket),
    });
    assert.equal(confirmed.status, 200);
    const applied = await confirmed.json();
    assert.equal(applied.changed, true);
    assert.equal(await readFile(path.join(root, '安全検証メモ.md'), 'utf8'), '# 安全検証メモ\n\n共通境界の確認です。\n');
    const repeated = await fetch(`${baseUrl}/v1/confirm-effect`, {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/json' },
      body: JSON.stringify(ticket),
    });
    assert.equal(repeated.status, 409);
  } finally {
    await relay.close();
    await rm(fixture, { recursive: true, force: true });
  }
  assert.equal(closeCount, 1);
});

test('Codex会話経路でも確認後の対象変更と取消は実行しない', async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), 'rokid-codex-effect-negative-'));
  const vault = path.join(fixture, 'vault');
  const editDirectory = path.join(vault, '検証');
  const editFile = path.join(editDirectory, '検証台帳.md');
  await mkdir(editDirectory, { recursive: true });
  await writeFile(editFile, '# 検証台帳\n\n現在の文\n', { mode: 0o600 });
  let driveApplyCount = 0;
  const coordinator = createNewDocumentCoordinator({
    allowedParent: fixture,
    vaultRoot: vault,
    root: path.join(vault, '作成文書', '私のAI'),
    applyGoogleDrive: async () => {
      driveApplyCount += 1;
      return { applied: true, changed: true, state: 'saved_to_google_docs' };
    },
    recordAction: async () => {},
  });
  let turn = 0;
  const token = randomBytes(32).toString('hex');
  const relay = createOneTurnVoiceRelay({
    token,
    ttlMs: 15_000,
    documentCoordinator: coordinator,
    recordConversation,
    async transcribe() { return { text: turn === 0 ? '台帳を変更して' : 'Driveへ保存して' }; },
    conversation: {
      async send() {
        turn += 1;
        return turn === 1
          ? {
            message: '変更内容を確認してください。', needsUserInput: false,
            effectProposal: {
              action: 'replace_obsidian_text', summary: '台帳の一箇所を変更', details: '実文書を確認',
              title: '検証台帳', currentText: '現在の文', replacementText: '変更後の文',
              resolvedPath: '検証/検証台帳.md',
            },
          }
          : {
            message: '保存内容を確認してください。', needsUserInput: false,
            effectProposal: {
              action: 'create_google_doc', summary: 'Driveへ保存', details: '固定フォルダへ新規作成',
              title: '取消検証', body: 'この文書は作成しません。',
            },
          };
      },
      async close() {},
    },
  });
  const address = await relay.listen();
  const baseUrl = `http://${address.host}:${address.port}`;
  const authorization = `Bearer ${token}`;
  const audioHeaders = (requestId) => ({
    authorization,
    'content-type': 'application/octet-stream',
    'x-request-id': requestId,
    'x-audio-format': 'pcm_s16le',
    'x-sample-rate': '16000',
    'x-channels': '1',
  });
  const ticketFrom = (effect) => ({
    ticketId: effect.ticketId,
    candidateId: effect.candidateId,
    confirmationToken: effect.confirmationToken,
  });
  try {
    const editResponse = await fetch(`${baseUrl}/v1/transcribe`, {
      method: 'POST', headers: audioHeaders('codex_edit_01'), body: Buffer.from([0, 0]),
    });
    const editProposal = (await editResponse.json()).effectProposal;
    assert.equal(editProposal.targetHint, '検証/検証台帳.md');
    await writeFile(editFile, '# 検証台帳\n\n確認後に外部で変わった文\n', { mode: 0o600 });
    const stale = await fetch(`${baseUrl}/v1/confirm-effect`, {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/json' },
      body: JSON.stringify(ticketFrom(editProposal)),
    });
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).reason, 'document_changed');
    assert.equal(await readFile(editFile, 'utf8'), '# 検証台帳\n\n確認後に外部で変わった文\n');

    const driveResponse = await fetch(`${baseUrl}/v1/transcribe`, {
      method: 'POST', headers: audioHeaders('codex_drive_01'), body: Buffer.from([0, 0]),
    });
    const driveProposal = (await driveResponse.json()).effectProposal;
    assert.equal(driveProposal.targetHint, 'Google DriveのRokid/私のAI 保存文書(Googleドキュメント)');
    const cancelled = await fetch(`${baseUrl}/v1/cancel-effect`, {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/json' },
      body: JSON.stringify(ticketFrom(driveProposal)),
    });
    assert.equal(cancelled.status, 200);
    assert.equal((await cancelled.json()).changed, false);
    assert.equal(driveApplyCount, 0);
  } finally {
    await relay.close();
    await rm(fixture, { recursive: true, force: true });
  }
});

test('文字起こしした自由文を固定分類なしの一問一答へ渡す', async () => {
  const calls = [];
  const processor = createOneTurnVoiceProcessor({
    recordConversation,
    async transcribe(pcm, { signal }) {
      calls.push({ stage: 'transcribe', pcm: Buffer.from(pcm), signal });
      return { text: ' 最近の資料は読める？ ', elapsedMs: 1200 };
    },
    async agent(options) {
      calls.push({ stage: 'agent', options });
      return {
        answer: '最近の資料を読み取れる状態です。',
        completed: true,
        requestHandledAs: 'free_conversation_turn',
        usedPreviousTurn: false,
        changed: false,
        ephemeral: true,
      };
    },
  });
  const signal = new AbortController().signal;
  const result = await processor(Buffer.from([0, 0, 1, 0]), { signal });
  assert.equal(result.text, '最近の資料を読み取れる状態です。');
  assert.equal(result.requestText, '最近の資料は読める?');
  assert.equal(result.changed, false);
  assert.equal(result.ephemeral, true);
  assert.equal(result.conversationRecorded, true);
  assert.equal(calls[1].options.request, '最近の資料は読める?');
  assert.equal(calls[1].options.previousTurn, null);
  assert.equal(calls[1].options.signal, signal);
});

test('安全条件外の回答と不正な認識文をRokidへ返さない', async () => {
  const invalidTranscript = createOneTurnVoiceProcessor({
    recordConversation,
    async transcribe() { return { text: '質問\n二行目' }; },
    async agent() { assert.fail('agent must not run'); },
  });
  await assert.rejects(() => invalidTranscript(Buffer.from([0, 0])), /control characters/);

  const unsafeAgent = createOneTurnVoiceProcessor({
    recordConversation,
    async transcribe() { return { text: '質問' }; },
    async agent() {
      return { answer: '答え', completed: true, requestHandledAs: 'free_conversation_turn', usedPreviousTurn: false, changed: true, ephemeral: true };
    },
  });
  await assert.rejects(() => unsafeAgent(Buffer.from([0, 0])), /unsafe result/);
});

test('取消シグナルを文字起こしから一問一答まで引き継ぐ', async () => {
  const controller = new AbortController();
  const processor = createOneTurnVoiceProcessor({
    recordConversation,
    async transcribe(_pcm, { signal }) {
      assert.equal(signal, controller.signal);
      controller.abort();
      return { text: '進捗を教えて' };
    },
    async agent() { assert.fail('agent must not run after cancellation'); },
  });
  await assert.rejects(
    () => processor(Buffer.from([0, 0]), { signal: controller.signal }),
    { name: 'AbortError' },
  );
});

test('同じ画面の追加質問へ直前1往復だけを渡す', async () => {
  const token = randomBytes(32).toString('hex');
  let answerCount = 0;
  let transcriptCount = 0;
  const documentContext = {
    sources: [{
      path: '検証/資料.md', title: '資料', section: '本文', excerpt: '最新部分です。',
    }],
  };
  const relay = createOneTurnVoiceRelay({
    token,
    ttlMs: 15_000,
    recordConversation,
    async transcribe() {
      transcriptCount += 1;
      return { text: transcriptCount === 1 ? '資料は読める?' : 'その最新部分は?' };
    },
    async agent(input) {
      answerCount += 1;
      if (answerCount === 1) assert.equal(input.previousTurn, null);
      else assert.deepEqual(input.previousTurn, {
        request: '資料は読める?',
        answer: '資料を読み取れます。',
        documentContext,
      });
      return {
        answer: answerCount === 1 ? '資料を読み取れます。' : '直前の資料の最新部分です。',
        completed: true,
        requestHandledAs: 'free_conversation_turn',
        usedPreviousTurn: answerCount === 2,
        changed: false,
        ephemeral: true,
        ...(answerCount === 1 ? { documentContext } : {}),
      };
    },
  });
  const address = await relay.listen();
  const url = `http://${address.host}:${address.port}/v1/transcribe`;
  const headers = {
    authorization: `Bearer ${token}`,
    'content-type': 'application/octet-stream',
    'x-request-id': 'one_voice_01',
    'x-audio-format': 'pcm_s16le',
    'x-sample-rate': '16000',
    'x-channels': '1',
  };
  try {
    const accepted = await fetch(url, { method: 'POST', headers, body: Buffer.from([0, 0]) });
    assert.equal(accepted.status, 200);
    assert.deepEqual(await accepted.json(), {
      ok: true,
      requestId: 'one_voice_01',
      requestText: '資料は読める?',
      text: '資料を読み取れます。',
      completed: true,
      requestHandledAs: 'free_conversation_turn',
      usedPreviousTurn: false,
      conversationRecorded: true,
      changed: false,
      ephemeral: true,
      operation: 'none',
    });
    const second = await fetch(url, {
      method: 'POST', headers: { ...headers, 'x-request-id': 'one_voice_02' }, body: Buffer.from([0, 0]),
    });
    assert.equal(second.status, 200);
    assert.deepEqual(await second.json(), {
      ok: true,
      requestId: 'one_voice_02',
      requestText: 'その最新部分は?',
      text: '直前の資料の最新部分です。',
      completed: true,
      requestHandledAs: 'free_conversation_turn',
      usedPreviousTurn: true,
      conversationRecorded: true,
      changed: false,
      ephemeral: true,
      operation: 'none',
    });
    assert.equal(answerCount, 2);
  } finally {
    await relay.close();
  }
});

test('自由な依頼は保存前候補だけを返し、Rokidの別確認後に新規文書を一回作る', async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), 'rokid-voice-document-'));
  const allowedParent = path.join(fixture, 'vault');
  await mkdir(allowedParent);
  const root = path.join(allowedParent, '作成文書', '私のAI');
  const actions = [];
  const coordinator = createNewDocumentCoordinator({
    allowedParent,
    root,
    recordAction: async (entry) => { actions.push(entry); },
  });
  const token = randomBytes(32).toString('hex');
  const relay = createOneTurnVoiceRelay({
    token,
    ttlMs: 15_000,
    documentCoordinator: coordinator,
    recordConversation,
    async transcribe() {
      return { text: '私のAI 作成文書に新規文書を作って' };
    },
    async agent() {
      return {
        answer: '「第3段階テスト」を新規保存する前に確認してください。',
        completed: true,
        requestHandledAs: 'free_conversation_turn',
        usedPreviousTurn: false,
        changed: false,
        ephemeral: true,
        operation: 'create_new_document',
        documentProposal: {
          title: '第3段階テスト',
          body: 'Rokidから安全に作成できました。',
          targetHint: '私のAI 作成文書',
        },
      };
    },
  });
  const address = await relay.listen();
  const baseUrl = `http://${address.host}:${address.port}`;
  const authorization = `Bearer ${token}`;
  try {
    const proposalResponse = await fetch(`${baseUrl}/v1/transcribe`, {
      method: 'POST',
      headers: {
        authorization,
        'content-type': 'application/octet-stream',
        'x-request-id': 'document_voice_01',
        'x-audio-format': 'pcm_s16le',
        'x-sample-rate': '16000',
        'x-channels': '1',
      },
      body: Buffer.from([0, 0]),
    });
    assert.equal(proposalResponse.status, 200);
    const proposal = await proposalResponse.json();
    assert.equal(proposal.operation, 'create_new_document');
    assert.deepEqual(proposal.documentProposal, {
      title: '第3段階テスト',
      targetHint: '私のAI 作成文書',
      preview: 'Rokidから安全に作成できました。',
    });
    await assert.rejects(() => readFile(path.join(root, '第3段階テスト.md')));

    const ticket = {
      ticketId: proposal.ticketId,
      candidateId: proposal.candidateId,
      confirmationToken: proposal.confirmationToken,
    };
    const confirmed = await fetch(`${baseUrl}/v1/confirm-document`, {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/json' },
      body: JSON.stringify(ticket),
    });
    assert.equal(confirmed.status, 200);
    assert.equal((await confirmed.json()).text, '「第3段階テスト」を保存しました');
    assert.equal(
      await readFile(path.join(root, '第3段階テスト.md'), 'utf8'),
      '# 第3段階テスト\n\nRokidから安全に作成できました。\n',
    );
    assert.deepEqual(actions, [{ operation: 'create_new_document', title: '第3段階テスト', state: 'saved' }]);

    const repeated = await fetch(`${baseUrl}/v1/confirm-document`, {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/json' },
      body: JSON.stringify(ticket),
    });
    assert.equal(repeated.status, 409);
  } finally {
    await relay.close();
    await rm(fixture, { recursive: true, force: true });
  }
});

test('既存文書は候補表示中に変えず、Rokidの別確認後に追加本文だけを追記する', async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), 'rokid-voice-append-'));
  const allowedParent = path.join(fixture, 'vault');
  const root = path.join(allowedParent, '作成文書', '私のAI');
  await mkdir(root, { recursive: true });
  const target = path.join(root, '第3段階テスト.md');
  await (await import('node:fs/promises')).writeFile(target, '# 第3段階テスト\n\n最初の本文です。\n');
  const actions = [];
  const coordinator = createNewDocumentCoordinator({
    allowedParent,
    root,
    recordAction: async (entry) => { actions.push(entry); },
  });
  const token = randomBytes(32).toString('hex');
  const relay = createOneTurnVoiceRelay({
    token,
    ttlMs: 15_000,
    documentCoordinator: coordinator,
    recordConversation,
    async transcribe() { return { text: '第3段階テストへ一行追記して' }; },
    async agent() {
      return {
        answer: '「第3段階テスト」への追記候補を確認してください。',
        completed: true,
        requestHandledAs: 'free_conversation_turn',
        usedPreviousTurn: false,
        changed: false,
        ephemeral: true,
        operation: 'append_document',
        documentProposal: {
          title: '第3段階テスト', body: '追記できました。', targetHint: '私のAI 作成文書',
        },
      };
    },
  });
  const address = await relay.listen();
  const baseUrl = `http://${address.host}:${address.port}`;
  const authorization = `Bearer ${token}`;
  try {
    const response = await fetch(`${baseUrl}/v1/transcribe`, {
      method: 'POST',
      headers: {
        authorization,
        'content-type': 'application/octet-stream',
        'x-request-id': 'append_voice_01',
        'x-audio-format': 'pcm_s16le',
        'x-sample-rate': '16000',
        'x-channels': '1',
      },
      body: Buffer.from([0, 0]),
    });
    assert.equal(response.status, 200);
    const proposal = await response.json();
    assert.equal(proposal.operation, 'append_document');
    assert.deepEqual(proposal.documentProposal, {
      title: '第3段階テスト', targetHint: '私のAI 作成文書', preview: '追記できました。', action: 'append',
    });
    assert.equal(await readFile(target, 'utf8'), '# 第3段階テスト\n\n最初の本文です。\n');
    const confirmed = await fetch(`${baseUrl}/v1/confirm-document`, {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/json' },
      body: JSON.stringify({
        ticketId: proposal.ticketId,
        candidateId: proposal.candidateId,
        confirmationToken: proposal.confirmationToken,
      }),
    });
    assert.equal(confirmed.status, 200);
    assert.equal((await confirmed.json()).text, '「第3段階テスト」へ追記しました');
    assert.equal(
      await readFile(target, 'utf8'),
      '# 第3段階テスト\n\n最初の本文です。\n\n追記できました。\n',
    );
    assert.deepEqual(actions, [{ operation: 'append_document', title: '第3段階テスト', state: 'appended' }]);
  } finally {
    await relay.close();
    await rm(fixture, { recursive: true, force: true });
  }
});

test('Obsidianの既存文書はRokidで現在文と変更後文を確認後に一箇所だけ変更する', async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), 'rokid-voice-edit-'));
  const vaultRoot = path.join(fixture, '保管庫');
  const folder = path.join(vaultRoot, '検証');
  await mkdir(folder, { recursive: true });
  const target = path.join(folder, '検証台帳.md');
  await (await import('node:fs/promises')).writeFile(
    target, '# 検証台帳\n\n状態は未確認です。\n', { mode: 0o600 },
  );
  const actions = [];
  const coordinator = createNewDocumentCoordinator({
    vaultRoot,
    allowedParent: fixture,
    recordAction: async (entry) => { actions.push(entry); },
  });
  const token = randomBytes(32).toString('hex');
  const relay = createOneTurnVoiceRelay({
    token,
    ttlMs: 15_000,
    documentCoordinator: coordinator,
    async editPlanner({ initialProposal }) {
      return {
        proposal: { ...initialProposal, resolvedPath: '検証/検証台帳.md' },
        documentContext: {
          sources: [{
            path: '検証/検証台帳.md', title: '検証台帳', section: '検証台帳',
            excerpt: '状態は未確認です。',
          }],
        },
      };
    },
    recordConversation,
    async transcribe() { return { text: '検証台帳の未確認を実機合格に変えて' }; },
    async agent() {
      return {
        answer: '「検証台帳」の変更候補を確認してください。',
        completed: true,
        requestHandledAs: 'free_conversation_turn',
        usedPreviousTurn: false,
        changed: false,
        ephemeral: true,
        operation: 'replace_document_text',
        documentProposal: {
          title: '検証台帳',
          matchText: '状態は未確認です。',
          replacementText: '状態は実機合格です。',
          targetHint: 'Obsidianの既存文書',
        },
      };
    },
  });
  const address = await relay.listen();
  const baseUrl = `http://${address.host}:${address.port}`;
  const authorization = `Bearer ${token}`;
  try {
    const response = await fetch(`${baseUrl}/v1/transcribe`, {
      method: 'POST',
      headers: {
        authorization,
        'content-type': 'application/octet-stream',
        'x-request-id': 'edit_voice_01',
        'x-audio-format': 'pcm_s16le',
        'x-sample-rate': '16000',
        'x-channels': '1',
      },
      body: Buffer.from([0, 0]),
    });
    const proposal = await response.json();
    assert.equal(proposal.operation, 'replace_document_text');
    assert.equal(proposal.documentProposal.action, 'replace_text');
    assert.equal(proposal.documentProposal.targetHint, '検証/検証台帳.md');
    assert.equal(await readFile(target, 'utf8'), '# 検証台帳\n\n状態は未確認です。\n');
    const confirmed = await fetch(`${baseUrl}/v1/confirm-document`, {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/json' },
      body: JSON.stringify({
        ticketId: proposal.ticketId,
        candidateId: proposal.candidateId,
        confirmationToken: proposal.confirmationToken,
      }),
    });
    assert.equal(confirmed.status, 200);
    assert.equal((await confirmed.json()).text, '「検証台帳」の一箇所を変更しました');
    assert.equal(await readFile(target, 'utf8'), '# 検証台帳\n\n状態は実機合格です。\n');
    assert.deepEqual(actions, [{
      operation: 'replace_document_text', title: '検証台帳', state: 'text_replaced',
    }]);
  } finally {
    await relay.close();
    await rm(fixture, { recursive: true, force: true });
  }
});

test('Google Drive候補はRokidの別確認後だけ専用保存処理へ一回渡す', async () => {
  const actions = [];
  const driveWrites = [];
  const coordinator = createNewDocumentCoordinator({
    async applyGoogleDrive(candidate, authorization) {
      driveWrites.push({ candidate, authorization });
      return {
        applied: true, changed: true, state: 'saved_to_google_docs',
        title: 'Drive試験', fileId: 'drive_file_12345',
      };
    },
    recordAction: async (entry) => { actions.push(entry); },
  });
  const token = randomBytes(32).toString('hex');
  const relay = createOneTurnVoiceRelay({
    token,
    ttlMs: 15_000,
    documentCoordinator: coordinator,
    recordConversation,
    async transcribe() { return { text: 'Drive試験をGoogle Driveへ保存して' }; },
    async agent() {
      return {
        answer: '「Drive試験」のGoogle Docs保存候補を確認してください。',
        completed: true,
        requestHandledAs: 'free_conversation_turn',
        usedPreviousTurn: false,
        changed: false,
        ephemeral: true,
        operation: 'save_document_to_google_drive',
        documentProposal: {
          title: 'Drive試験',
          body: 'RokidからGoogle Driveへ保存できました。',
          targetHint: 'Google DriveのRokid/私のAI 保存文書(Googleドキュメント)',
        },
      };
    },
  });
  const address = await relay.listen();
  const baseUrl = `http://${address.host}:${address.port}`;
  const authorization = `Bearer ${token}`;
  try {
    const response = await fetch(`${baseUrl}/v1/transcribe`, {
      method: 'POST',
      headers: {
        authorization,
        'content-type': 'application/octet-stream',
        'x-request-id': 'drive_voice_01',
        'x-audio-format': 'pcm_s16le',
        'x-sample-rate': '16000',
        'x-channels': '1',
      },
      body: Buffer.from([0, 0]),
    });
    const proposal = await response.json();
    assert.equal(proposal.operation, 'save_document_to_google_drive');
    assert.deepEqual(proposal.documentProposal, {
      title: 'Drive試験',
      targetHint: 'Google DriveのRokid/私のAI 保存文書(Googleドキュメント)',
      preview: 'RokidからGoogle Driveへ保存できました。',
      action: 'save_to_google_docs',
    });
    assert.equal(driveWrites.length, 0);
    const confirmed = await fetch(`${baseUrl}/v1/confirm-document`, {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/json' },
      body: JSON.stringify({
        ticketId: proposal.ticketId,
        candidateId: proposal.candidateId,
        confirmationToken: proposal.confirmationToken,
      }),
    });
    assert.equal(confirmed.status, 200);
    assert.equal((await confirmed.json()).text, '「Drive試験」をGoogleドキュメントとして保存しました');
    assert.equal(driveWrites.length, 1);
    assert.equal(driveWrites[0].authorization.executionCapability, 'save_document_to_google_drive');
    assert.deepEqual(actions, [{
      operation: 'save_document_to_google_drive', title: 'Drive試験', state: 'saved_to_google_docs',
    }]);
  } finally {
    await relay.close();
  }
});

test('指定した既存文書がない場合は追記確認を出さず理由を回答する', async (t) => {
  const fixture = await mkdtemp(path.join(tmpdir(), 'rokid-voice-append-missing-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const processor = createOneTurnVoiceProcessor({
    recordConversation,
    documentCoordinator: createNewDocumentCoordinator({
      allowedParent: fixture,
      root: path.join(fixture, '作成文書', '私のAI'),
    }),
    async transcribe() { return { text: '見つからない文書へ追記して' }; },
    async agent() {
      return {
        answer: '追記候補を用意しました。', completed: true,
        requestHandledAs: 'free_conversation_turn', usedPreviousTurn: false,
        changed: false, ephemeral: true, operation: 'append_document',
        documentProposal: {
          title: '見つからない文書', body: '追加本文', targetHint: '私のAI 作成文書',
        },
      };
    },
  });
  const result = await processor(Buffer.from([0, 0]));
  assert.equal(result.operation, 'none');
  assert.equal(result.completed, false);
  assert.match(result.text, /見つからないため/);
  assert.equal(result.ticketId, undefined);
});

test('質問待機中に画面を閉じたら連続質問セッションも閉じる', async () => {
  const token = randomBytes(32).toString('hex');
  let closeCount = 0;
  const relay = createOneTurnVoiceRelay({
    token,
    ttlMs: 15_000,
    conversation: {
      async send() { throw new Error('must not send while idle'); },
      async close() { closeCount += 1; },
    },
  });
  const address = await relay.listen();
  const baseUrl = `http://${address.host}:${address.port}`;
  const authorization = `Bearer ${token}`;
  try {
    const cancelled = await fetch(`${baseUrl}/v1/cancel`, {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: 'close-idle-session' }),
    });
    assert.equal(cancelled.status, 200);
    assert.deepEqual(await cancelled.json(), {
      ok: true,
      requestId: 'close-idle-session',
      cancelled: true,
      idle: true,
    });

    const health = await fetch(`${baseUrl}/v1/health`, {
      method: 'POST', headers: { authorization },
    });
    assert.equal(health.status, 200);
    assert.equal((await health.json()).ready, false);
  } finally {
    await relay.close();
  }
  assert.equal(closeCount, 1);
});

test('60秒分のPCMは受け取り、上限を超えた音声は拒否する', async () => {
  async function makeRelay() {
    const token = randomBytes(32).toString('hex');
    const relay = createOneTurnVoiceRelay({
      token,
      ttlMs: 15_000,
      recordConversation,
      async transcribe() { return { text: '質問' }; },
      async agent() {
        return {
          answer: '回答', completed: true,
          requestHandledAs: 'free_conversation_turn', usedPreviousTurn: false, changed: false, ephemeral: true,
        };
      },
    });
    const address = await relay.listen();
    return { relay, token, url: `http://${address.host}:${address.port}/v1/transcribe` };
  }
  function audioHeaders(token, requestId) {
    return {
      authorization: `Bearer ${token}`,
      'content-type': 'application/octet-stream',
      'x-request-id': requestId,
      'x-audio-format': 'pcm_s16le',
      'x-sample-rate': '16000',
      'x-channels': '1',
    };
  }

  const within = await makeRelay();
  try {
    const response = await fetch(within.url, {
      method: 'POST', headers: audioHeaders(within.token, 'voice_limit_ok'), body: Buffer.alloc(1_920_000),
    });
    assert.equal(response.status, 200);
  } finally {
    await within.relay.close();
  }

  const over = await makeRelay();
  try {
    const response = await fetch(over.url, {
      method: 'POST', headers: audioHeaders(over.token, 'voice_limit_over'), body: Buffer.alloc(1_920_002),
    });
    assert.equal(response.status, 413);
    assert.equal((await response.json()).error, 'body_too_large');
  } finally {
    await over.relay.close();
  }
});

test('会話記録に失敗した回答を記録済みとしてRokidへ返さない', async () => {
  const processor = createOneTurnVoiceProcessor({
    async transcribe() { return { text: '記録して' }; },
    async agent() {
      return {
        answer: '回答', completed: true,
        requestHandledAs: 'free_conversation_turn', usedPreviousTurn: false,
        changed: false, ephemeral: true,
      };
    },
    async recordConversation() { throw new Error('disk unavailable'); },
  });
  await assert.rejects(() => processor(Buffer.from([0, 0])), /disk unavailable/);
});

test('音声入口は固定分類と直接ファイル操作を持たず記録器へ分離する', async () => {
  const source = await (await import('node:fs/promises')).readFile(new URL('./one-turn-voice-relay.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /intent|voice_note|web_research_note|personal_knowledge_question/);
  assert.doesNotMatch(source, /writeFile|appendFile|createWriteStream/);
  assert.doesNotMatch(source, /localStorage|setStorage|conversation\.json/);
});
