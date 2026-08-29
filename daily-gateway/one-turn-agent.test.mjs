import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

import {
  collectOneTurnToolUsage,
  createOneTurnAgent,
  DEFAULT_ONE_TURN_AGENT_TIMEOUT_MS,
  normalizeOneTurnRequest,
  normalizePreviousTurn,
} from './one-turn-agent.mjs';

test('自由文を固定分類へ変えず一回の依頼として受ける', () => {
  assert.equal(
    normalizeOneTurnRequest(' この内容を報告書にまとめるには、何が必要？ '),
    'この内容を報告書にまとめるには、何が必要?',
  );
  assert.throws(() => normalizeOneTurnRequest(''), /1 to 500/);
});

test('直前1往復だけを会話文脈として受ける', () => {
  assert.deepEqual(normalizePreviousTurn({
    request: 'Rokid Controlの最新版は?',
    answer: '最新版は1.3.0です。',
  }), {
    request: 'Rokid Controlの最新版は?',
    answer: '最新版は1.3.0です。',
  });
  assert.equal(normalizePreviousTurn(null), null);
  assert.throws(() => normalizePreviousTurn({ request: '質問', answer: '' }), /1 to 240/);
});

test('道具の選択をCodexへ委ね、アプリ側は利用記録だけを返す', () => {
  const tools = collectOneTurnToolUsage([
    {
      type: 'item.completed',
      item: {
        type: 'mcp_tool_call',
        server: 'codex_apps',
        tool: 'google_drive.search',
        status: 'completed',
      },
    },
  ]);
  assert.deepEqual(tools, ['codex_apps/google_drive.search']);
  assert.deepEqual(collectOneTurnToolUsage([
    {
      type: 'item.completed',
      item: {
        type: 'mcp_tool_call',
        server: 'playwright',
        tool: 'browser_navigate',
        status: 'completed',
      },
    },
  ]), ['playwright/browser_navigate']);
});

test('読み取り専用のWeb検索記録を現在と旧形式の両方で許可する', () => {
  assert.deepEqual(collectOneTurnToolUsage([
    { type: 'item.started', item: { type: 'web_search' } },
    { type: 'item.completed', item: { type: 'web_search' } },
    { type: 'item.completed', item: { type: 'web_search_call' } },
  ]), ['openai/web_search']);
});

test('一問一答の実行結果は変更なし・一時セッションとして返す', async () => {
  let processOptions;
  const agent = createOneTurnAgent({
    async runProcess(_command, args, options) {
      processOptions = options;
      assert.deepEqual(args.slice(0, 6), [
        '--search',
        '--config', 'mcp_servers.playwright.enabled=false',
        '--config', 'mcp_servers.node_repl.enabled=false',
        'exec',
      ]);
      const outputPath = args[args.indexOf('--output-last-message') + 1];
      await fs.writeFile(outputPath, JSON.stringify({
        answer: '一回の自由な質問として回答しました。',
        completed: true,
        unavailable_reason: '',
        used_previous_turn: false,
        operation: 'none', document_title: '', document_body: '', document_target: '',
      }));
      return {
        code: 0,
        stdout: [
          JSON.stringify({ type: 'turn.started' }),
          JSON.stringify({ type: 'item.completed', item: { type: 'agent_message' } }),
          JSON.stringify({ type: 'turn.completed' }),
        ].join('\n'),
        stderr: '',
      };
    },
  });
  const result = await agent({ request: '何ができるか一回で答えて' });
  assert.equal(result.completed, true);
  assert.equal(result.requestHandledAs, 'free_conversation_turn');
  assert.equal(result.usedPreviousTurn, false);
  assert.equal(result.changed, false);
  assert.equal(result.ephemeral, true);
  assert.deepEqual(result.tools, []);
  assert.equal(processOptions.timeoutMs, DEFAULT_ONE_TURN_AGENT_TIMEOUT_MS);
  assert.equal(processOptions.maximumBytes, 20_000_000);
  assert.equal(DEFAULT_ONE_TURN_AGENT_TIMEOUT_MS, 600_000);
});

test('OpenAI Web検索が未対応なら同じ質問を読み取り専用ブラウザで続ける', async () => {
  const calls = [];
  const agent = createOneTurnAgent({
    async runProcess(_command, args, options) {
      calls.push({ args, input: options.input });
      const outputPath = args[args.indexOf('--output-last-message') + 1];
      const fallback = calls.length === 2;
      await fs.writeFile(outputPath, JSON.stringify(fallback ? {
        answer: '代替ブラウザで現在情報を確認しました。',
        completed: true,
        unavailable_reason: '',
        used_previous_turn: false,
        operation: 'none', document_title: '', document_body: '', document_target: '',
      } : {
        answer: 'OpenAI Web検索は現在利用できません。',
        completed: false,
        unavailable_reason: 'Unsupported router route',
        used_previous_turn: false,
        operation: 'none', document_title: '', document_body: '', document_target: '',
      }));
      return {
        code: 0,
        stdout: fallback
          ? JSON.stringify({
            type: 'item.completed',
            item: { type: 'mcp_tool_call', server: 'playwright', tool: 'browser_navigate' },
          })
          : JSON.stringify({ type: 'turn.completed' }),
        stderr: '',
      };
    },
  });
  const result = await agent({ request: 'Webで調べて' });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].args.includes('mcp_servers.node_repl.enabled=false'), true);
  assert.deepEqual(calls[1].args.slice(0, 4), [
    '--search', '--config', 'mcp_servers.node_repl.enabled=false', 'exec',
  ]);
  assert.match(calls[1].input, /OpenAIのネイティブWeb検索は.*すでに失敗/);
  assert.equal(result.completed, true);
  assert.deepEqual(result.tools, ['playwright/browser_navigate']);
});

test('追加質問へ直前の1往復を渡し、新しい話題へ混ぜない規則を持つ', async () => {
  let prompt = '';
  const agent = createOneTurnAgent({
    async runProcess(_command, args, options) {
      prompt = options.input;
      const outputPath = args[args.indexOf('--output-last-message') + 1];
      await fs.writeFile(outputPath, JSON.stringify({
        answer: 'その変更点は、回答後の連続質問への対応です。',
        completed: true,
        unavailable_reason: '',
        used_previous_turn: true,
        operation: 'none', document_title: '', document_body: '', document_target: '',
      }));
      return { code: 0, stdout: JSON.stringify({ type: 'turn.completed' }), stderr: '' };
    },
  });
  const result = await agent({
    request: 'その変更点は?',
    previousTurn: {
      request: '私のAIの現在版は?',
      answer: '現在版はv0.16.10です。',
    },
  });
  assert.equal(result.usedPreviousTurn, true);
  assert.match(prompt, /直前の1往復/);
  assert.match(prompt, /現在版はv0\.16\.10/);
  assert.match(prompt, /単独で意味を持つ新しい話題なら/);
  assert.doesNotMatch(prompt, /前回の会話は存在しない/);
});

test('直前の往復がない初回に引き継ぎ済みとする回答を拒否する', async () => {
  const agent = createOneTurnAgent({
    async runProcess(_command, args) {
      const outputPath = args[args.indexOf('--output-last-message') + 1];
      await fs.writeFile(outputPath, JSON.stringify({
        answer: '誤って前回を使いました。',
        completed: true,
        unavailable_reason: '',
        used_previous_turn: true,
        operation: 'none', document_title: '', document_body: '', document_target: '',
      }));
      return { code: 0, stdout: JSON.stringify({ type: 'turn.completed' }), stderr: '' };
    },
  });
  await assert.rejects(() => agent({ request: '初回の質問' }), /used missing previous turn/);
});

test('自由な依頼から新規文書の全文だけを保存前候補として返す', async () => {
  let prompt = '';
  const agent = createOneTurnAgent({
    async runProcess(_command, args, options) {
      prompt = options.input;
      const outputPath = args[args.indexOf('--output-last-message') + 1];
      await fs.writeFile(outputPath, JSON.stringify({
        answer: '「青い計画書」の候補を用意しました。保存するならRokidで1回操作してください。',
        completed: true,
        unavailable_reason: '',
        used_previous_turn: false,
        operation: 'create_new_document',
        document_title: '青い計画書',
        document_body: '目的は、新しい計画を安全に進めることです。',
        document_target: '私のAI 作成文書',
      }));
      return { code: 0, stdout: JSON.stringify({ type: 'turn.completed' }), stderr: '' };
    },
  });
  const result = await agent({ request: '私のAI 作成文書に、青い計画書を新しく作って保存して' });
  assert.equal(result.operation, 'create_new_document');
  assert.equal(result.documentProposal.title, '青い計画書');
  assert.equal(result.documentProposal.targetHint, '私のAI 作成文書');
  assert.equal(result.changed, false);
  assert.match(prompt, /このAI処理自体はファイルを書かない/);
  assert.match(prompt, /文書全体の書き直し.*文書の削除/);
});

test('既存文書の題名と追加本文を追記候補として返す', async () => {
  let prompt = '';
  const agent = createOneTurnAgent({
    async runProcess(_command, args, options) {
      prompt = options.input;
      const outputPath = args[args.indexOf('--output-last-message') + 1];
      await fs.writeFile(outputPath, JSON.stringify({
        answer: '「青い計画書」への追記候補です。Rokidで内容を確認してください。',
        completed: true,
        unavailable_reason: '',
        used_previous_turn: false,
        operation: 'append_document',
        document_title: '青い計画書',
        document_body: '進捗は予定どおりです。',
        document_target: '私のAI 作成文書',
      }));
      return { code: 0, stdout: JSON.stringify({ type: 'turn.completed' }), stderr: '' };
    },
  });
  const result = await agent({ request: '私のAI 作成文書の青い計画書へ、進捗は予定どおりです、と追記して' });
  assert.equal(result.operation, 'append_document');
  assert.deepEqual(result.documentProposal, {
    title: '青い計画書',
    body: '進捗は予定どおりです。',
    targetHint: '私のAI 作成文書',
    markdown: '# 青い計画書\n\n進捗は予定どおりです。\n',
  });
  assert.match(prompt, /元の本文を要約、置換、削除、書き直ししない/);
});

test('既存文書の現在文と変更後文を一箇所変更候補にする', async () => {
  let prompt = '';
  const agent = createOneTurnAgent({
    async runProcess(_command, args, options) {
      prompt = options.input;
      const outputPath = args[args.indexOf('--output-last-message') + 1];
      await fs.writeFile(outputPath, JSON.stringify({
        answer: '「検証台帳」の変更候補です。Rokidで現在文と変更後文を確認してください。',
        completed: true,
        unavailable_reason: '',
        used_previous_turn: false,
        operation: 'replace_document_text',
        document_title: '検証台帳',
        document_match_text: '状態は未確認です。',
        document_body: '状態は実機合格です。',
        document_target: 'Obsidianの既存文書',
      }));
      return { code: 0, stdout: JSON.stringify({ type: 'turn.completed' }), stderr: '' };
    },
  });
  const result = await agent({
    request: 'Obsidianの検証台帳で「状態は未確認です。」を「状態は実機合格です。」に変えて',
  });
  assert.equal(result.operation, 'replace_document_text');
  assert.deepEqual(result.documentProposal, {
    title: '検証台帳',
    matchText: '状態は未確認です。',
    replacementText: '状態は実機合格です。',
    targetHint: 'Obsidianの既存文書',
  });
  assert.match(prompt, /operation=replace_document_text/);
  assert.match(prompt, /文書全体の書き直し/);
});

test('Google Driveへの題名と本文を保存前候補として返す', async () => {
  let prompt = '';
  const agent = createOneTurnAgent({
    async runProcess(_command, args, options) {
      prompt = options.input;
      const outputPath = args[args.indexOf('--output-last-message') + 1];
      await fs.writeFile(outputPath, JSON.stringify({
        answer: '「Drive試験」の候補です。RokidでGoogle Docs保存を確認してください。',
        completed: true,
        unavailable_reason: '',
        used_previous_turn: false,
        operation: 'save_document_to_google_drive',
        document_title: 'Drive試験',
        document_body: 'RokidからGoogle Driveへ保存する本文です。',
        document_target: 'Google DriveのRokid/私のAI 保存文書(Googleドキュメント)',
      }));
      return { code: 0, stdout: JSON.stringify({ type: 'turn.completed' }), stderr: '' };
    },
  });
  const result = await agent({ request: 'Drive試験という文書をGoogle Driveへ保存して' });
  assert.equal(result.operation, 'save_document_to_google_drive');
  assert.deepEqual(result.documentProposal, {
    title: 'Drive試験',
    body: 'RokidからGoogle Driveへ保存する本文です。',
    targetHint: 'Google DriveのRokid/私のAI 保存文書(Googleドキュメント)',
    documentText: '題名: Drive試験\n\n本文:\nRokidからGoogle Driveへ保存する本文です。\n',
  });
  assert.match(prompt, /operation=save_document_to_google_drive/);
  assert.match(prompt, /次の1回操作がGoogleドキュメント保存の確認/);
  assert.match(prompt, /Google DriveへMarkdown形式で保存する依頼はまだ扱わない/);
});

test('自由な依頼からObsidian文書を読み取り専用で探して短く要約する', async () => {
  let prompt = '';
  let localInput = null;
  const agent = createOneTurnAgent({
    localVaultPath: '/fixed/local/vault',
    async localKnowledge(input) {
      localInput = input;
      return {
        answer: { text: '対象文書には、Googleドキュメント保存の実機合格が記録されています。' },
        documentSources: [{
          path: '検証/検証台帳.md', title: '検証台帳', section: 'Google Docs保存',
          excerpt: 'Googleドキュメント保存は実機合格。',
        }],
      };
    },
    async runProcess(_command, args, options) {
      prompt = options.input;
      const outputPath = args[args.indexOf('--output-last-message') + 1];
      await fs.writeFile(outputPath, JSON.stringify({
        answer: 'ローカル文書を確認します。',
        completed: true,
        unavailable_reason: '',
        used_previous_turn: false,
        operation: 'consult_local_documents',
        document_title: '',
        document_body: '',
        document_target: '',
      }));
      return { code: 0, stdout: JSON.stringify({ type: 'turn.completed' }), stderr: '' };
    },
  });
  const result = await agent({ request: 'Obsidianの検証台帳からGoogle Docs保存の結果を探して要約して' });
  assert.equal(result.operation, 'none');
  assert.equal(result.answer, '対象文書には、Googleドキュメント保存の実機合格が記録されています。');
  assert.deepEqual(result.tools, ['local/obsidian-readonly']);
  assert.equal(result.changed, false);
  assert.equal(result.ephemeral, true);
  assert.deepEqual(result.documentContext, {
    sources: [{
      path: '検証/検証台帳.md', title: '検証台帳', section: 'Google Docs保存',
      excerpt: 'Googleドキュメント保存は実機合格。',
    }],
  });
  assert.equal(localInput.question, 'Obsidianの検証台帳からGoogle Docs保存の結果を探して要約して');
  assert.equal(localInput.vaultPath, '/fixed/local/vault');
  assert.equal(localInput.answerCharacterLimit, 240);
  assert.equal(localInput.allowSensitive, false);
  assert.match(prompt, /operation=consult_local_documents/);
  assert.match(prompt, /この段階でGoogle DriveやWebを検索しない/);
  assert.match(prompt, /最終的な目的.*文書を変える依頼ではない/);
});

test('ローカル文書を特定できない時はWeb検索へ逃げず一回で終える', async () => {
  let processCalls = 0;
  let localCalls = 0;
  const agent = createOneTurnAgent({
    async localKnowledge() {
      localCalls += 1;
      throw new Error('no allowlisted evidence');
    },
    async runProcess(_command, args) {
      processCalls += 1;
      const outputPath = args[args.indexOf('--output-last-message') + 1];
      await fs.writeFile(outputPath, JSON.stringify({
        answer: 'ローカル文書を確認します。',
        completed: true,
        unavailable_reason: '',
        used_previous_turn: false,
        operation: 'consult_local_documents',
        document_title: '',
        document_body: '',
        document_target: '',
      }));
      return { code: 0, stdout: JSON.stringify({ type: 'turn.completed' }), stderr: '' };
    },
  });
  const result = await agent({ request: 'Obsidianから存在しない文書を探して' });
  assert.equal(processCalls, 1);
  assert.equal(localCalls, 1);
  assert.equal(result.completed, false);
  assert.equal(result.operation, 'none');
  assert.equal(result.changed, false);
  assert.deepEqual(result.tools, ['local/obsidian-readonly']);
  assert.match(result.answer, /文書は変更していません/);
});

test('通常回答へ文書本文を混ぜず、不正な保存先を拒否する', async () => {
  const invalid = createOneTurnAgent({
    async runProcess(_command, args) {
      const outputPath = args[args.indexOf('--output-last-message') + 1];
      await fs.writeFile(outputPath, JSON.stringify({
        answer: '候補です。', completed: true, unavailable_reason: '', used_previous_turn: false,
        operation: 'create_new_document', document_title: '文書', document_body: '本文', document_target: '別の場所',
      }));
      return { code: 0, stdout: JSON.stringify({ type: 'turn.completed' }), stderr: '' };
    },
  });
  await assert.rejects(() => invalid({ request: '文書を作って' }), /target is not allowed/);
});

test('固定された機能分類を最終判断として持たない', async () => {
  const source = await fs.readFile(new URL('./one-turn-agent.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /voice_note|web_research_note|personal_knowledge_question/);
  assert.match(source, /固定コマンドや機能分類へ当てはめず/);
  assert.match(source, /直前の1往復/);
  assert.match(source, /create_new_document/);
  assert.match(source, /append_document/);
  assert.match(source, /replace_document_text/);
  assert.match(source, /save_document_to_google_drive/);
  assert.match(source, /--approve-for-me/);
  assert.match(source, /'--search'/);
  assert.match(source, /OpenAIのネイティブWeb検索を優先する/);
  assert.match(source, /--ephemeral/);
  assert.doesNotMatch(source, /'-a', 'never'/);
  assert.doesNotMatch(source, /READ_ONLY_MCP_TOOLS|SAFE_ITEM_TYPES/);
});
