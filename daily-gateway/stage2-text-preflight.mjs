import { createOneTurnAgent } from './one-turn-agent.mjs';

const agent = createOneTurnAgent();

const firstRequest = '会話継続の動作確認です。仮の文書名は「青い計画書」です。文書名だけ答えてください。';
const first = await agent({ request: firstRequest });
if (first.usedPreviousTurn !== false || !first.answer.includes('青い計画書')) {
  throw new Error('first turn did not establish the synthetic document context');
}

const secondRequest = 'その文書名は何でしたか?';
const second = await agent({
  request: secondRequest,
  previousTurn: { request: firstRequest, answer: first.answer },
});
if (second.usedPreviousTurn !== true || !second.answer.includes('青い計画書')) {
  throw new Error('follow-up turn did not use the immediately previous turn');
}

const thirdRequest = '日本の首都はどこですか?';
const third = await agent({
  request: thirdRequest,
  previousTurn: { request: secondRequest, answer: second.answer },
});
if (third.usedPreviousTurn !== false || !third.answer.includes('東京')) {
  throw new Error('independent turn incorrectly used previous context');
}

process.stdout.write(`${JSON.stringify({
  first: { answer: first.answer, usedPreviousTurn: first.usedPreviousTurn },
  followUp: { answer: second.answer, usedPreviousTurn: second.usedPreviousTurn },
  independent: { answer: third.answer, usedPreviousTurn: third.usedPreviousTurn },
  changed: false,
  persistedConversation: false,
}, null, 2)}\n`);
