import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const projectDir = path.dirname(fileURLToPath(import.meta.url));
const defaultModel = process.env.ROKID_WHISPER_MODEL ||
  '/path/to/your/RokidWorkspace/開発中/rokid-local-transcription-probe/models/ggml-large-v3-turbo-q5_0.bin';
const defaultVadModel = process.env.ROKID_WHISPER_VAD_MODEL ||
  '/path/to/your/RokidWorkspace/開発中/rokid-local-transcription-probe/models/ggml-silero-v6.2.0.bin';
const defaultGlossary = path.join(projectDir, 'glossary.json');

export function normalizeTranscript(text, glossary) {
  let normalized = text.trim();
  for (const [heard, intended] of Object.entries(glossary)) {
    normalized = normalized.split(heard).join(intended);
  }
  return normalized;
}

export function buildWhisperArgs({ inputPath, modelPath, vadModelPath, glossary }) {
  const prompt = `用語: ${[...new Set(Object.values(glossary))].join('、')}。`;
  return [
    '-m', modelPath,
    '-f', inputPath,
    '-l', 'ja',
    '-nt',
    '-np',
    '--prompt', prompt,
    '--vad',
    '--vad-model', vadModelPath,
  ];
}

async function transcribe(inputPath, modelPath, vadModelPath, glossaryPath) {
  const glossary = JSON.parse(await readFile(glossaryPath, 'utf8'));
  const args = buildWhisperArgs({ inputPath, modelPath, vadModelPath, glossary });

  const startedAt = process.hrtime.bigint();
  const child = spawn('whisper-cli', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  if (exitCode !== 0) {
    throw new Error(`whisper-cli failed (${exitCode}): ${stderr.trim()}`);
  }

  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
  const raw = stdout.trim();
  return {
    text: normalizeTranscript(raw, glossary),
    raw,
    elapsedMs: Math.round(elapsedMs),
  };
}

function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const inputPath = valueAfter('--input');
  if (!inputPath) {
    console.error('Usage: node transcribe.mjs --input <audio-file>');
    process.exit(2);
  }
  const modelPath = valueAfter('--model') || defaultModel;
  const vadModelPath = valueAfter('--vad-model') || defaultVadModel;
  const glossaryPath = valueAfter('--glossary') || defaultGlossary;
  try {
    console.log(JSON.stringify(await transcribe(inputPath, modelPath, vadModelPath, glossaryPath), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
