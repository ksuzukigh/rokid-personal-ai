import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { wavFromPcm } from './audio-relay.mjs';
import { buildWhisperArgs, normalizeTranscript } from './transcribe.mjs';

const glossary = JSON.parse(await readFile(new URL('./glossary.json', import.meta.url), 'utf8'));

test('Rokid固有語と合成音声の限定誤認を補正する', () => {
  assert.equal(normalizeTranscript('ロキッドの個人合作り', glossary), 'Rokidの個人AIづくり');
  assert.equal(normalizeTranscript('当事さんのObsidian', glossary), '当事さんのObsidian');
});

test('人名を常時ヒントに入れずVADで発話区間だけを認識する', () => {
  const args = buildWhisperArgs({
    inputPath: '/tmp/input.wav',
    modelPath: '/tmp/whisper.bin',
    vadModelPath: '/tmp/vad.bin',
    glossary,
  });
  assert.deepEqual(args.slice(-3), ['--vad', '--vad-model', '/tmp/vad.bin']);
  assert.equal(args.includes('田路さん'), false);
  assert.match(args[args.indexOf('--prompt') + 1], /Rokid/);
});

test('16kHzモノラルPCMを正しいWAVヘッダーで包む', () => {
  const pcm = Buffer.from([1, 0, 2, 0]);
  const wav = wavFromPcm(pcm);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt32LE(24), 16000);
  assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(wav.readUInt32LE(40), pcm.length);
  assert.deepEqual(wav.subarray(44), pcm);
});
