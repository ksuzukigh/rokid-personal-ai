import assert from 'node:assert/strict';
import test from 'node:test';

import { createDocumentEditPlanner } from './document-edit-planner.mjs';

const sources = [{
  path: 'Rokidシステム化/作成文書/私のAI/文書検索編集テスト.md',
  title: '文書検索編集テスト',
  section: '文書検索編集テスト',
  excerpt: 'この文書は実機テスト用です。\n\n編集状態は確認前',
}, {
  path: 'Rokidシステム化/会話記録/私のAI/2026-08-25.md',
  title: '2026-08-25',
  section: '20:30:41',
  excerpt: '文書が見つからないため変更できませんでした。',
}];

function readyValue(overrides = {}) {
  return {
    ready: true,
    source_id: 'S1',
    current_text: '編集状態は確認前',
    replacement_text: '編集状態は確認済み',
    clarification: '',
    ...overrides,
  };
}

test('自然な依頼とLuna検索候補から対象パスと実在文を決める', async () => {
  let plannerPrompt = '';
  const planner = createDocumentEditPlanner({
    async retrieve(input) {
      assert.match(input.question, /Obsidianの文書検索編集テスト/);
      return { transmission: { sent: sources }, modelRuns: [{ stage: 'search-plan' }] };
    },
    async modelRunner(input) {
      plannerPrompt = input.prompt;
      return { value: readyValue(), audit: { stage: input.stage, model: 'gpt-5.6-luna' } };
    },
  });
  const result = await planner({
    request: 'Obsidianの文書検索編集テストの確認前を確認済みに変えて',
    initialProposal: {
      title: 'Rokidシステム化/作成文書/私のAI/文書検索編集テスト.md',
      matchText: '確認前になっているところ',
      replacementText: '確認済み',
      targetHint: 'Obsidianの既存文書',
    },
    usePreviousTurn: false,
  });
  assert.deepEqual(result.proposal, {
    title: '文書検索編集テスト',
    matchText: '編集状態は確認前',
    replacementText: '編集状態は確認済み',
    targetHint: 'Obsidianの既存文書',
    resolvedPath: 'Rokidシステム化/作成文書/私のAI/文書検索編集テスト.md',
  });
  assert.match(plannerPrompt, /固定コマンや語句の型に当てはめず/);
  assert.match(plannerPrompt, /会話記録/);
  assert.match(plannerPrompt, /Rokidシステム化\/作成文書/);
});

test('「その文書」は直前にLunaが参照した候補と会話を使う', async () => {
  let retrieveCalls = 0;
  let prompt = '';
  const planner = createDocumentEditPlanner({
    async retrieve() { retrieveCalls += 1; throw new Error('must not retrieve again'); },
    async modelRunner(input) {
      prompt = input.prompt;
      return { value: readyValue(), audit: { stage: input.stage } };
    },
  });
  const result = await planner({
    request: 'その文書の確認前を確認済みにして',
    usePreviousTurn: true,
    previousTurn: {
      request: '文書検索編集テストを探して要約して',
      answer: '編集状態は確認前です。',
      documentContext: { sources: [sources[0]] },
    },
  });
  assert.equal(retrieveCalls, 0);
  assert.equal(result.audit.source, 'previous_document_context');
  assert.match(prompt, /直前の会話/);
  assert.match(prompt, /編集状態は確認前です/);
});

test('Lunaが対象を一つに決められない場合は確認事項を返す', async () => {
  const planner = createDocumentEditPlanner({
    async retrieve() { return { transmission: { sent: sources }, modelRuns: [] }; },
    async modelRunner() {
      return {
        value: {
          ready: false, source_id: '', current_text: '', replacement_text: '',
          clarification: 'どちらの文書を変更するか教えてください。',
        },
        audit: { stage: 'document-edit-plan' },
      };
    },
  });
  await assert.rejects(
    () => planner({ request: '確認済みに変えて' }),
    (error) => error?.code === 'DOCUMENT_EDIT_NEEDS_CLARIFICATION' && /どちら/.test(error.clarification),
  );
});
