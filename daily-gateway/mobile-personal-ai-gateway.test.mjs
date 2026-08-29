import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { createMobilePersonalAiGateway } from './mobile-personal-ai-gateway.mjs';

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = (signal = 'SIGTERM') => {
    if (child.exitCode !== null || child.signalCode !== null) return false;
    child.signalCode = signal;
    queueMicrotask(() => child.emit('close', null, signal));
    return true;
  };
  return child;
}

async function freePort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function request(port, token = '', route = '/v1/bootstrap', body = '{}') {
  return new Promise((resolve, reject) => {
    const call = http.request({
      host: '127.0.0.1',
      port,
      path: route,
      method: 'POST',
      headers: token ? { authorization: `Bearer ${token}`, 'content-type': 'application/json' } : {},
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        type: response.headers['content-type'],
        body: Buffer.concat(chunks),
      }));
    });
    call.once('error', reject);
    call.end(body);
  });
}

test('Rokidの認証済み開始一件だけに会話専用AIXを返す', async () => {
  const bootstrapPort = await freePort();
  const sessionPort = await freePort();
  const bootstrapToken = 'b'.repeat(64);
  const aix = Buffer.from('PK\u0003\u0004private-aix');
  const children = [];
  const work = await mkdtemp(path.join(tmpdir(), 'mobile-gateway-test-'));
  const gateway = createMobilePersonalAiGateway({
    bootstrapPort,
    sessionPort,
    readSecret: async () => bootstrapToken,
    createWork: async () => work,
    removeWork: async () => {},
    fetchPublic: async () => ({ ok: true, async json() { return { ok: true, ready: true }; } }),
    spawnProcess(_command, args) {
      const child = fakeChild();
      children.push(child);
      if (args.includes('run')) return child;
      const outputAix = args.at(-1);
      queueMicrotask(async () => {
        await writeFile(outputAix, aix);
        child.stdout.write('SESSION_READY transport=cloudflare-persistent\n');
      });
      return child;
    },
    output: () => {},
    errorOutput: () => {},
  });
  await gateway.start();
  const denied = await request(bootstrapPort);
  assert.equal(denied.status, 401);
  const accepted = await request(bootstrapPort, bootstrapToken);
  assert.equal(accepted.status, 200);
  assert.equal(accepted.type, 'application/vnd.rokid.aix');
  assert.deepEqual(accepted.body, aix);
  assert.equal(children.length, 2);
  const active = await request(bootstrapPort, bootstrapToken, '/v1/status');
  assert.equal(active.status, 200);
  assert.deepEqual(JSON.parse(active.body), { ok: true, active: true });
  const ended = await request(bootstrapPort, bootstrapToken, '/v1/end');
  assert.equal(ended.status, 200);
  assert.deepEqual(JSON.parse(ended.body), { ok: true, closed: true });
  assert.equal(children[1].signalCode, 'SIGTERM');
  const inactive = await request(bootstrapPort, bootstrapToken, '/v1/status');
  assert.deepEqual(JSON.parse(inactive.body), { ok: true, active: false });
  await gateway.stop();
  assert.ok(children.every((child) => child.signalCode === 'SIGTERM'));
});

test('外出用待受けは分類や保存機能を増やさず、会話ごとの短命認証を作る', async () => {
  const source = await (await import('node:fs/promises')).readFile(
    new URL('./mobile-personal-ai-gateway.mjs', import.meta.url),
    'utf8',
  );
  assert.match(source, /randomBytes\(32\)/);
  assert.match(source, /\/v1\/bootstrap/);
  assert.match(source, /start-mobile-voice-session\.mjs/);
  assert.doesNotMatch(source, /intent-router|runKnowledgePipeline|appendFile|createWriteStream/);
  assert.doesNotMatch(source, /OPENAI_API_KEY|CODEX_API_KEY/);
});
