import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DAILY_APP_AGENT_ID, DAILY_APP_REMOTE_PATH } from './build-aix.mjs';

export function addDailyAppToIndex(indexValue, aixBytes, { updatedAt = Date.now() } = {}) {
  if (!indexValue || typeof indexValue !== 'object' || !Array.isArray(indexValue.agents)) throw new Error('invalid agents index');
  if (!Buffer.isBuffer(aixBytes) || aixBytes.length < 1) throw new Error('AIX bytes are required');
  const existingIds = new Set(indexValue.agents.map((agent) => String(agent?.agentId ?? '')));
  const withoutDailyApp = indexValue.agents.filter((agent) => String(agent?.agentId ?? '') !== DAILY_APP_AGENT_ID);
  if (withoutDailyApp.length !== indexValue.agents.length && !existingIds.has(DAILY_APP_AGENT_ID)) throw new Error('daily app index mismatch');
  const dailyApp = {
    agentId: DAILY_APP_AGENT_ID,
    agentName: '私のAI',
    agentDesc: '決められた機能メニューを選ばず、自由な依頼を一つ伝えるための個人用AI。',
    agentLogo: '',
    url: '',
    permissions: [],
    nativeVersion: '0.0.16',
    fileMd5: createHash('md5').update(aixBytes).digest('hex'),
    filePath: DAILY_APP_REMOTE_PATH,
    updatedAt
  };
  return { ...indexValue, agents: [...withoutDailyApp, dailyApp] };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [, , indexPath, aixPath, outputPath] = process.argv;
  if (!indexPath || !aixPath || !outputPath) {
    console.error('usage: node update-agent-index.mjs INDEX_JSON APP_AIX OUTPUT_JSON');
    process.exit(2);
  }
  try {
    const updated = addDailyAppToIndex(JSON.parse(readFileSync(indexPath, 'utf8')), readFileSync(aixPath));
    writeFileSync(outputPath, `${JSON.stringify(updated, null, 2)}\n`, { mode: 0o600 });
    console.log(`READY ${path.resolve(outputPath)}`);
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
}
