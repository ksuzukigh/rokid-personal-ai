import { pathToFileURL } from 'node:url';

import { createMobilePersonalAiGateway } from './mobile-personal-ai-gateway.mjs';

export function createPersonalAiMacService(options = {}) {
  const output = options.output ?? console.log;
  const createGateway = options.createGateway ?? createMobilePersonalAiGateway;
  const gateway = createGateway({
    output,
    errorOutput: options.errorOutput ?? console.error,
    ...(options.gatewayOptions ?? {}),
  });
  let running = null;
  let stopping = false;

  function start() {
    if (running) throw new Error('Personal AI Mac service is already started');
    const completion = (async () => {
      output('PERSONAL_AI_MAC_SERVICE_STARTED recordingStarted=false changed=false');
      const gatewayState = await gateway.start();
      output('PERSONAL_AI_MAC_SERVICE_READY route=internet recordingStarted=false changed=false');
      await gatewayState.completion;
      output('PERSONAL_AI_MAC_SERVICE_STOPPED');
    })();
    running = { completion };
    return running;
  }

  async function stop() {
    if (!running) return { stopped: true };
    if (!stopping) {
      stopping = true;
      await gateway.stop();
    }
    await running.completion;
    return { stopped: true };
  }

  return { start, stop };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const service = createPersonalAiMacService();
  let stopped = false;
  const stopForSignal = async () => {
    if (stopped) return;
    stopped = true;
    await service.stop().catch(() => {});
  };
  process.once('SIGINT', stopForSignal);
  process.once('SIGTERM', stopForSignal);
  try {
    const active = service.start();
    await active.completion;
  } catch (error) {
    console.error(`PERSONAL_AI_MAC_SERVICE_FAILED ${error.message}`);
    process.exitCode = 2;
  }
}
