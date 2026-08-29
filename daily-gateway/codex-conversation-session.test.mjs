import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

import {
  buildEffectBoundaryPolicy,
  createCodexConversationSession,
  extractCodexSessionId,
  normalizeConversationResponse,
} from './codex-conversation-session.mjs';

const SESSION_ID = '11111111-2222-4333-8444-555555555555';

test('CodexのJSONイベントから保存済み作業セッションIDを得る', () => {
  assert.equal(extractCodexSessionId([
    JSON.stringify({ type: 'thread.started', thread_id: SESSION_ID }),
    JSON.stringify({ type: 'turn.started' }),
  ].join('\n')), SESSION_ID);
  assert.throws(() => extractCodexSessionId('{"type":"turn.started"}'), /session id/);
});

test('会話用Codexは利用者設定を読まず、読み取り専用検索とComputer Historyだけを再構成する', async () => {
  const calls = [];
  const runProcess = async (_executable, args) => {
    calls.push(args);
    if (calls.length === 1) {
      return {
        code: 0,
        stdout: JSON.stringify({
          name: 'computer-history', enabled: true,
          transport: {
            type: 'stdio', command: './bin/computer-use-client-launcher',
            args: ['computer-history', 'mcp'], env_vars: ['CODEX_HOME'],
            cwd: '/Users/test/.codex/plugins/cache/openai-bundled/computer-history/1.0.0/.',
          },
        }),
      };
    }
    return {
      code: 0,
      stdout: JSON.stringify({
        name: 'bright-data', enabled: true,
        transport: {
          type: 'stdio', command: '/Applications/Codex.app/Contents/Resources/cua_node/bin/npx',
          args: ['-y', '@brightdata/mcp'], env: { API_TOKEN: 'test-read-only-token-123456' },
          cwd: null,
        },
      }),
    };
  };
  const policy = await buildEffectBoundaryPolicy({
    runProcess,
    environment: {
      HOME: '/Users/test', PATH: '/usr/bin:/bin', LANG: 'ja_JP.UTF-8',
      GOOGLE_DRIVE_WRITE_TOKEN: 'must-not-reach-conversation',
    },
  });
  assert.ok(policy.args.includes('--ignore-user-config'));
  assert.ok(policy.args.some((arg) => arg.startsWith('mcp_servers.computer-history=')));
  assert.ok(policy.args.some((arg) => arg.startsWith('mcp_servers.bright-data=')));
  assert.equal(policy.args.some((arg) => /google-drive|playwright|node_repl/u.test(arg)), false);
  assert.equal(policy.args.some((arg) => arg.includes('test-read-only-token')), false);
  assert.equal(policy.environment.API_TOKEN, 'test-read-only-token-123456');
  assert.equal(policy.environment.GOOGLE_DRIVE_WRITE_TOKEN, undefined);
  assert.equal(policy.environment.HOME, '/Users/test');
  assert.deepEqual(calls.map((args) => args.slice(0, 3)), [
    ['mcp', 'get', 'computer-history'],
    ['mcp', 'get', 'bright-data'],
  ]);
});

test('安全な読み取り接続が見つからない時は外部接続なしで閉じる', async () => {
  const policy = await buildEffectBoundaryPolicy({
    runProcess: async () => ({ code: 1, stdout: '', stderr: 'not found' }),
    environment: { HOME: '/Users/test', PRIVATE_WRITE_TOKEN: 'secret' },
  });
  assert.deepEqual(policy.args, ['--ignore-user-config']);
  assert.deepEqual(policy.environment, { HOME: '/Users/test' });
});

test('読み取り接続の実体が許可した形と違えば起動前に拒否する', async () => {
  await assert.rejects(() => buildEffectBoundaryPolicy({
    runProcess: async () => ({
      code: 0,
      stdout: JSON.stringify({
        name: 'computer-history', enabled: true,
        transport: { type: 'stdio', command: '/tmp/untrusted', args: [], env_vars: [], cwd: '/tmp' },
      }),
    }),
  }), /safety transport is invalid/);
});

test('通常応答、自然な聞き返し、許可済み範囲の正確な効果提案だけを通す', () => {
  assert.deepEqual(normalizeConversationResponse({
    message: 'どちらの文書を指していますか？', needs_user_input: true, effect_proposal: null,
  }), { message: 'どちらの文書を指していますか?', needsUserInput: true, effectProposal: null });
  assert.deepEqual(normalizeConversationResponse({
    message: '変更内容を確認してください。', needs_user_input: false,
    effect_proposal: {
      action: 'replace_obsidian_text',
      summary: '文書の一部を変更',
      details: '対象と変更前後を境界で確定する。',
      title: '検証台帳',
      current_text: '現在の文',
      replacement_text: '変更後の文',
      resolved_path: '検証/検証台帳.md',
      body: '',
    },
  }), {
    message: '変更内容を確認してください。', needsUserInput: false,
    effectProposal: {
      action: 'replace_obsidian_text',
      summary: '文書の一部を変更',
      details: '対象と変更前後を境界で確定する。',
      title: '検証台帳',
      currentText: '現在の文',
      replacementText: '変更後の文',
      resolvedPath: '検証/検証台帳.md',
    },
  });
  assert.throws(() => normalizeConversationResponse({
    message: '確認してください。', needs_user_input: true,
    effect_proposal: {
      action: 'create_obsidian_markdown', summary: '変更', details: '同時には出さない。',
      title: '候補', body: '本文', current_text: '', replacement_text: '', resolved_path: '',
    },
  }), /clarification/);
  assert.throws(() => normalizeConversationResponse({
    message: '送信します。', needs_user_input: false,
    effect_proposal: {
      action: 'send_email', summary: 'メール送信', details: '許可されていない。',
      title: '件名', body: '本文',
    },
  }), /not allowed/);
});

test('最初の発言で作業セッションを作り、次の発言は同じIDへresumeする', async () => {
  const calls = [];
  const responses = [
    { message: '「Obsidianの〇〇」と「〇〇」のどちらですか？', needs_user_input: true, effect_proposal: null },
    { message: '後者の文書を確認しました。', needs_user_input: false, effect_proposal: null },
  ];
  const runProcess = async (_executable, args, options) => {
    calls.push({ args, options });
    if (args[0] === 'delete') return { code: 0, stdout: '', stderr: '' };
    const outputPath = args[args.indexOf('--output-last-message') + 1];
    await fs.writeFile(outputPath, JSON.stringify(responses.shift()));
    return {
      code: 0,
      stdout: calls.length === 1
        ? `${JSON.stringify({ type: 'thread.started', thread_id: SESSION_ID })}\n`
        : `${JSON.stringify({ type: 'turn.started' })}\n`,
      stderr: '',
    };
  };
  const session = createCodexConversationSession({
    runProcess,
    effectBoundaryArgs: [],
    workspace: '/path/to/your/RokidWorkspace',
  });
  const first = await session.send('Obsidianの〇〇を確認して');
  const second = await session.send('後者です');
  assert.equal(first.needsUserInput, true);
  assert.equal(second.message, '後者の文書を確認しました。');
  assert.equal(calls[0].args.includes('--ephemeral'), false);
  assert.deepEqual(calls[0].args.slice(0, 6), ['exec', '--model', 'gpt-5.6-luna', '--sandbox', 'read-only', '--skip-git-repo-check']);
  assert.deepEqual(calls[1].args.slice(0, 3), ['exec', 'resume', '--model']);
  assert.ok(calls[1].args.includes('sandbox_mode="read-only"'));
  assert.ok(calls[1].args.includes(SESSION_ID));
  assert.match(calls[1].options.input, /同じ仕事の文脈/);
  await session.close();
  assert.deepEqual(calls[2].args, ['delete', '--force', SESSION_ID]);
  assert.equal(session.closed, true);
});

test('閉じた会話へ発言を追加しない', async () => {
  const session = createCodexConversationSession({
    runProcess: async () => ({ code: 0, stdout: '', stderr: '' }),
    effectBoundaryArgs: [],
  });
  await session.close();
  await assert.rejects(() => session.send('続き'), /closed/);
});
