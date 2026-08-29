import { rmSync } from 'node:fs';
import path from 'node:path';

import { createFixedDailySessionController } from './fixed-session-controller.mjs';
import { normalizeOneTurnRequest } from './one-turn-agent.mjs';
import { prepareOneTurnAix } from './prepare-one-turn-aix.mjs';

const [outputArgument, ...requestParts] = process.argv.slice(2);
if (!outputArgument || !requestParts.length) {
  console.error('usage: node start-fixed-one-turn-session.mjs OUTPUT_AIX FREE_REQUEST');
  process.exit(2);
}
const output = path.resolve(outputArgument);
const request = normalizeOneTurnRequest(requestParts.join(' '));
const controller = createFixedDailySessionController({
  receiverScript: path.join(import.meta.dirname, 'one-turn-session-receiver.mjs'),
});
const stopForSignal = async () => {
  await controller.stop('signal').catch(() => {});
  rmSync(output, { force: true });
  process.exit(130);
};
process.once('SIGINT', stopForSignal);
process.once('SIGTERM', stopForSignal);

try {
  const session = await controller.start();
  prepareOneTurnAix(output, {
    origin: session.origin,
    token: session.token,
    request,
  });
  console.log(
    `SESSION_READY mode=free-one-turn origin=${session.origin} ` +
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
