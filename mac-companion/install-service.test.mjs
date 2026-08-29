import assert from 'node:assert/strict';
import test from 'node:test';

import { buildLaunchAgentPlist, buildMobileTunnelConfig, SERVICE_LABEL } from './install-service.mjs';

test('Macログイン後に私のAI専用待受けだけを自動起動する設定を作る', () => {
  const plist = buildLaunchAgentPlist({
    node: '/opt/homebrew/bin/node',
    service: '/path/to/your/RokidWorkspace/rokid-personal-ai/personal-ai-mac-service.mjs',
    stdout: '/Users/test/Library/Logs/Rokid Personal AI/service.log',
    stderr: '/Users/test/Library/Logs/Rokid Personal AI/service-error.log',
  });
  assert.match(plist, new RegExp(`<string>${SERVICE_LABEL}</string>`));
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.match(plist, /personal-ai-mac-service\.mjs/);
  assert.doesNotMatch(plist, /Rokid Control|OPENAI_API_KEY|Bearer|cloudflared.*run/);
});

test('固定名の開始口と会話口をMac内の別々の待受けへ結ぶ', () => {
  const config = buildMobileTunnelConfig(`tunnel: tunnel-id\ncredentials-file: /Users/test/.cloudflared/secret.json\n\ningress:\n  - hostname: personal-ai.example.com\n    service: http://127.0.0.1:18448\n`);
  assert.match(config, /path: \/v1\/bootstrap\s+service: http:\/\/127\.0\.0\.1:18447/);
  assert.match(config, /path: \/v1\/status\s+service: http:\/\/127\.0\.0\.1:18447/);
  assert.match(config, /hostname: personal-ai\.example\.com\s+service: http:\/\/127\.0\.0\.1:18448/);
  assert.doesNotMatch(config, /Bearer|bootstrap-token/);
});
