import { pathToFileURL } from 'node:url';

import {
  createAdbAppOpenObserver,
  DEFAULT_ROKID_ADB,
  DEFAULT_ROKID_ADB_PORT,
} from './adb-app-open-observer.mjs';
import { createDailyStartupSupervisor } from './startup-supervisor.mjs';

export async function runDailyAppSupervisor(options = {}) {
  const output = options.output ?? console.log;
  const errorOutput = options.errorOutput ?? console.error;
  const serial = options.serial ?? process.env.ROKID_ADB_SERIAL;
  if (typeof serial !== 'string' || !serial.trim()) {
    throw new Error('ROKID_ADB_SERIAL is required');
  }
  const supervisor = options.supervisor ?? createDailyStartupSupervisor(options.supervisorOptions);
  const observer = options.observer ?? createAdbAppOpenObserver({
    adbPath: options.adbPath ?? process.env.ROKID_ADB_PATH ?? DEFAULT_ROKID_ADB,
    serial,
    port: options.port ?? DEFAULT_ROKID_ADB_PORT,
    onAppOpened: async (event) => {
      const readiness = await supervisor.appOpened(event);
      output(
        `DAILY_SESSION_READY origin=${readiness.origin} expiresAt=${readiness.expiresAt} ` +
        `reused=${readiness.reused} executionCapability=${readiness.executionCapability} ` +
        `changed=${readiness.changed}`,
      );
    },
    onError: (error) => errorOutput(`DAILY_SUPERVISOR_EVENT_FAILED ${error.message}`),
    environment: options.environment,
  });

  let stopping = null;
  async function stop(reason = 'requested') {
    if (stopping) return stopping;
    stopping = Promise.allSettled([
      observer.stop(),
      supervisor.stop(reason),
    ]).then((results) => {
      const failed = results.find((result) => result.status === 'rejected');
      if (failed) throw failed.reason;
      return { stopped: true, reason };
    });
    return stopping;
  }

  const started = await observer.start();
  output(`DAILY_APP_WATCHING serial=${serial} executionCapability=none changed=false`);
  return { completion: started.completion, stop, supervisor };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let runner = null;
  let signalReceived = false;
  const stopForSignal = async (signal) => {
    if (signalReceived) return;
    signalReceived = true;
    await runner?.stop?.(signal.toLowerCase()).catch(() => {});
    process.exit(130);
  };
  process.once('SIGINT', () => stopForSignal('SIGINT'));
  process.once('SIGTERM', () => stopForSignal('SIGTERM'));
  try {
    runner = await runDailyAppSupervisor();
    await runner.completion;
    if (!signalReceived) throw new Error('Rokid app-open observer stopped');
  } catch (error) {
    console.error(`DAILY_APP_SUPERVISOR_FAILED ${error.message}`);
    await runner?.stop?.('failure').catch(() => {});
    process.exitCode = 2;
  }
}
