import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const [baseAixArgument, outputAixArgument] = process.argv.slice(2);
if (!baseAixArgument || !outputAixArgument) {
  console.error('usage: node prepare-safe-aix.mjs BASE_AIX OUTPUT_AIX');
  process.exit(2);
}

const baseAix = resolve(baseAixArgument);
const outputAix = resolve(outputAixArgument);
const work = mkdtempSync(join(tmpdir(), 'rokid-aiui-knowledge-safe-aix-'));

try {
  execFileSync('/usr/bin/unzip', ['-qq', baseAix, '-d', work]);
  writeFileSync(join(work, 'pages/index/index.ink'), `<script def>
{
  "navigationBarTitleText": "検証終了"
}
</script>

<script setup>
export default {
  data: {
    state: '検証終了',
    detail: '接続情報を消去しました'
  }
}
</script>

<page>
  <view class="screen">
    <text class="state">{{ state }}</text>
    <text class="detail">{{ detail }}</text>
  </view>
</page>

<style>
.screen {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  height: 100vh;
  padding: 18px;
  background-color: #000000;
}
.state, .detail {
  width: 100%;
  color: #40ff5e;
  text-align: center;
}
.state { font-size: 28px; line-height: 32px; margin-bottom: 12px; }
.detail { font-size: 16px; line-height: 21px; }
</style>
`, { encoding: 'utf8', mode: 0o600 });
  writeFileSync(join(work, 'AGENTS.md'), '# Agent: Rokid検証終了画面\n\n通信、録音、保存、処理を一切行わない後片付け用の静的Agent。\n', { encoding: 'utf8', mode: 0o600 });
  writeFileSync(join(work, 'README.md'), '一時検証後のAIUI実行キャッシュを、接続情報を持たない画面で上書きする。\n', { encoding: 'utf8', mode: 0o600 });
  writeFileSync(join(work, 'package.json'), JSON.stringify({
    name: 'rokid-aiui-knowledge-bridge',
    version: '0.1.0-test',
    private: true,
  }, null, 2), { encoding: 'utf8', mode: 0o600 });
  writeFileSync(join(work, 'app.json'), JSON.stringify({
    pages: ['pages/index/index'],
    window: { navigationBarTitleText: '検証終了' },
  }, null, 2), { encoding: 'utf8', mode: 0o600 });
  writeFileSync(join(work, 'VERSION'), `${randomUUID()}\n`, { encoding: 'utf8', mode: 0o600 });

  rmSync(outputAix, { force: true });
  execFileSync('/usr/bin/zip', ['-q', '-r', outputAix, '.'], { cwd: work });
  chmodSync(outputAix, 0o600);
  console.log(`READY ${outputAix}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
