import { rmSync } from 'node:fs';
import path from 'node:path';

import { createFixedDailySessionController } from './fixed-session-controller.mjs';
import { prepareRouteAix } from './prepare-route-aix.mjs';
import { normalizeDailyUtterance } from './session-receiver.mjs';

const [outputArgument, ...utteranceParts] = process.argv.slice(2);
if (!outputArgument || !utteranceParts.length) {
  console.error('usage: node start-fixed-route-session.mjs OUTPUT_AIX UTTERANCE');
  process.exit(2);
}
const output = path.resolve(outputArgument);
const utterance = normalizeDailyUtterance(utteranceParts.join(' '));
const controller = createFixedDailySessionController();
const stopForSignal = async () => {
  await controller.stop('signal').catch(() => {});
  rmSync(output, { force: true });
  process.exit(130);
};
process.once('SIGINT', stopForSignal);
process.once('SIGTERM', stopForSignal);

try {
  const session = await controller.start();
  prepareRouteAix(output, {
    origin: session.origin,
    token: session.token,
    utterance,
  });
  console.log(
    `SESSION_READY mode=route-only origin=${session.origin} ` +
    `attempts=${session.health.attempts} elapsedMs=${session.health.elapsedMs} ` +
    `aix=${output} expiresAt=${session.expiresAt}`,
  );
  const result = await session.completion;
  console.log(`SESSION_COMPLETE receiverExit=${result.code ?? result.signal}`);
  process.exitCode = result.code === 0 ? 0 : 1;
} catch (error) {
  console.error(`SESSION_FAILED ${error.message}`);
  await controller.stop('failure').catch(() => {});
  process.exitCode = 2;
} finally {
  rmSync(output, { force: true });
}
