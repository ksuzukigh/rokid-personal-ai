import { pathToFileURL } from 'node:url';

import {
  createAudioRelay,
  transcribePcm,
} from './audio-relay.mjs';
import { runKnowledgePipeline } from '../knowledge-router/knowledge-pipeline.mjs';
import { normalizeSessionQuestion } from './relay.mjs';

const FIXED_VAULT = '/path/to/your/ObsidianVault';
const ANSWER_CHARACTER_LIMIT = 160;

export function createVoiceKnowledgeProcessor({
  transcribe = transcribePcm,
  pipeline = runKnowledgePipeline,
} = {}) {
  return async (pcm, { signal } = {}) => {
    const startedAt = Date.now();
    const transcript = await transcribe(pcm, { signal });
    throwIfAborted(signal);
    const question = normalizeSessionQuestion(transcript?.text);
    const result = await pipeline({
      vaultPath: FIXED_VAULT,
      question,
      answerCharacterLimit: ANSWER_CHARACTER_LIMIT,
      signal,
      searchLimit: 16,
      perFileLimit: 2,
      transmission: { maximumSources: 6, maximumExcerptCharacters: 4800 },
    });
    throwIfAborted(signal);
    const answer = String(result?.answer?.text ?? '').normalize('NFKC').trim();
    if (!answer || answer.length > ANSWER_CHARACTER_LIMIT) {
      throw new Error('knowledge answer must be 1 to 160 characters');
    }
    return {
      text: answer,
      elapsedMs: Date.now() - startedAt,
    };
  };
}

export function createVoiceKnowledgeRelay({
  token,
  port = 0,
  ttlMs = 300000,
  exitOnFinish = false,
  transcribe = transcribePcm,
  pipeline = runKnowledgePipeline,
} = {}) {
  return createAudioRelay({
    token,
    port,
    ttlMs,
    maxRequests: 1,
    transcribe: createVoiceKnowledgeProcessor({ transcribe, pipeline }),
    exitOnFinish,
  });
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const error = new Error('operation aborted');
  error.name = 'AbortError';
  throw error;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const token = process.env.ROKID_VOICE_KNOWLEDGE_TOKEN || '';
  const port = Number(process.env.ROKID_VOICE_KNOWLEDGE_PORT || 18448);
  const ttlMs = Number(process.env.ROKID_VOICE_KNOWLEDGE_TTL_MS || 300000);
  try {
    const relay = createVoiceKnowledgeRelay({
      token,
      port,
      ttlMs,
      exitOnFinish: true,
    });
    const address = await relay.listen();
    console.log(
      `READY http://${address.host}:${address.port}/v1/transcribe ` +
        `ttlMs=${ttlMs} maxRequests=1 mode=voice-knowledge-readonly`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
}
