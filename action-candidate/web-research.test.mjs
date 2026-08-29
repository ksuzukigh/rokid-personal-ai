import assert from 'node:assert/strict';
import test from 'node:test';

import { runWebResearch, validateWebResearch, validateWebRequest } from './web-research.mjs';

test('文字の依頼をライブWeb検索の出典付き結果へ整える', async () => {
  const prompts = [];
  const result = await runWebResearch('Rokidの最新発表を調べて', {
    date: '2026-08-24',
    async modelRunner(input) {
      prompts.push(input.prompt);
      return { value: { summary: 'Rokidの公式発表を確認した。', sources: [
        { title: '公式発表', url: 'https://global.rokid.com/blogs/articles/example', key_point: '新製品が発表された。' },
      ] }, audit: { webSearch: 'live' } };
    },
  });
  assert.equal(result.request, 'Rokidの最新発表を調べて');
  assert.equal(result.sources[0].keyPoint, '新製品が発表された。');
  assert.match(prompts[0], /必ずライブWeb検索/);
  assert.match(prompts[0], /2026-08-24/);
});

test('私的URL、重複URL、制御文字を拒否する', () => {
  assert.throws(() => validateWebRequest('検索\nして'));
  assert.throws(() => validateWebResearch({ summary: '結果', sources: [{ title: '内部', url: 'https://127.0.0.1/test', key_point: '不可' }] }), /private/);
  assert.throws(() => validateWebResearch({ summary: '結果', sources: [
    { title: 'A', url: 'https://example.com/a', key_point: 'A' },
    { title: 'B', url: 'https://example.com/a#fragment', key_point: 'B' },
  ] }), /duplicate/);
});
