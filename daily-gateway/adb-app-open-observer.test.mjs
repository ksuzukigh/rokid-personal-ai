import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createAdbAppOpenObserver,
  parseAppOpenEventId,
} from './adb-app-open-observer.mjs';
import { DAILY_APP_OPEN_EVENT } from './startup-supervisor.mjs';

const OLD_ID = '11111111-1111-4111-8111-111111111111';
const NEW_ID = '22222222-2222-4222-8222-222222222222';

test('Android起動役の正しい一回合図だけを認識する', () => {
  assert.equal(parseAppOpenEventId(`DAILY_APP_OPENED eventId=${NEW_ID}`), NEW_ID);
  assert.equal(parseAppOpenEventId(`x DAILY_APP_OPENED eventId=${NEW_ID}`), null);
  assert.equal(parseAppOpenEventId('DAILY_APP_OPENED eventId=bad'), null);
  assert.equal(parseAppOpenEventId('録音して'), null);
});

test('開始前の古いログを再利用せず、新しい起動一件だけを監督へ渡す', async () => {
  let onLine;
  let stopped = 0;
  const received = [];
  const observer = createAdbAppOpenObserver({
    now: () => 5000,
    onAppOpened: async (event) => { received.push(event); },
    readExisting: async () => [`DAILY_APP_OPENED eventId=${OLD_ID}`],
    startLogcat: async (options) => {
      onLine = options.onLine;
      return {
        completion: new Promise(() => {}),
        async stop() { stopped += 1; },
      };
    },
  });
  await observer.start();
  onLine(`DAILY_APP_OPENED eventId=${OLD_ID}`);
  onLine(`DAILY_APP_OPENED eventId=${NEW_ID}`);
  onLine(`DAILY_APP_OPENED eventId=${NEW_ID}`);
  await observer.stop();
  assert.deepEqual(received, [{ type: DAILY_APP_OPEN_EVENT, observedAt: 5000 }]);
  assert.equal(stopped, 1);
});

test('監督の失敗を監視処理の停止へ変えず、次の起動を処理できる', async () => {
  let onLine;
  let calls = 0;
  const errors = [];
  const observer = createAdbAppOpenObserver({
    onAppOpened: async () => {
      calls += 1;
      if (calls === 1) throw new Error('not ready');
    },
    onError: (error) => { errors.push(error.message); },
    readExisting: async () => [],
    startLogcat: async (options) => {
      onLine = options.onLine;
      return { completion: new Promise(() => {}), async stop() {} };
    },
  });
  await observer.start();
  onLine(`DAILY_APP_OPENED eventId=${OLD_ID}`);
  onLine(`DAILY_APP_OPENED eventId=${NEW_ID}`);
  await observer.stop();
  assert.equal(calls, 2);
  assert.deepEqual(errors, ['not ready']);
});

test('ADB監視部品は録音、保存、個人資料検索、外部操作を持たない', async () => {
  const source = await (await import('node:fs/promises')).readFile(
    new URL('./adb-app-open-observer.mjs', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(source, /RecorderManager|RECORD_AUDIO|writeFile|appendFile|createWriteStream/);
  assert.doesNotMatch(source, /runKnowledgePipeline|runWebResearch|applyConfirmed/);
  assert.match(source, /ANDROID_ADB_SERVER_PORT/);
});

test('Android起動役はADBではなく認証済みHTTPSで会話を開く', async () => {
  const source = await (await import('node:fs/promises')).readFile(
    new URL('../daily-launcher-android/app/src/main/java/io/github/ksuzukigh/rokidpersonalai/LauncherActivity.java', import.meta.url),
    'utf8',
  );
  const manifest = await (await import('node:fs/promises')).readFile(
    new URL('../daily-launcher-android/app/src/main/AndroidManifest.xml', import.meta.url),
    'utf8',
  );
  const exitHome = await (await import('node:fs/promises')).readFile(
    new URL('../daily-launcher-android/app/src/main/java/io/github/ksuzukigh/rokidpersonalai/ExitHomeService.java', import.meta.url),
    'utf8',
  );
  const jsaiCloser = await (await import('node:fs/promises')).readFile(
    new URL('../daily-launcher-android/app/src/main/java/io/github/ksuzukigh/rokidpersonalai/YodaJsaiSceneCloser.java', import.meta.url),
    'utf8',
  );
  const iconSource = await (await import('node:fs/promises')).readFile(
    new URL('../daily-launcher-android/icon-source/personal-ai-icon.png', import.meta.url),
  );
  assert.match(source, /https:\/\/personal-ai\.example\.com\/v1\/bootstrap/);
  assert.match(source, /https:\/\/personal-ai\.example\.com\/v1\/end/);
  assert.match(source, /https:\/\/personal-ai\.example\.com\/v1\/status/);
  assert.match(source, /BuildConfig\.BOOTSTRAP_TOKEN/);
  assert.match(source, /getExternalFilesDir/);
  assert.match(source, /"personal-ai-" \+ UUID\.randomUUID\(\) \+ "\.aix"/);
  assert.match(source, /deleteStaleAixFiles/);
  assert.match(source, /startService\(intent\)/);
  assert.match(source, /startForegroundService\(new Intent\(this, ExitHomeService\.class\)\)/);
  assert.ok(
    source.indexOf('startForegroundService(new Intent(this, ExitHomeService.class))') <
      source.indexOf('worker.execute(this::prepareAndOpenAiui)'),
  );
  assert.match(source, /notifySessionEnded/);
  assert.match(source, /waitForSessionEnd\(\)/);
  assert.match(source, /runOnUiThread\(this::closeAiuiAfterSessionEnd\)/);
  assert.match(source, /new YodaJsaiSceneCloser\(this/);
  assert.match(source, /open_params/);
  assert.match(source, /com\.rokid\.os\.sprite\.jsai\.OPEN_PAGE/);
  assert.match(source, /onNewIntent/);
  assert.match(source, /準備中…/);
  assert.doesNotMatch(source, /質問の準備をしています/);
  assert.doesNotMatch(source, /準備が整うと自動で移動します|この画面では録音していません/);
  assert.doesNotMatch(source, /DAILY_APP_OPENED|Log\.i/);
  const permissions = [...manifest.matchAll(/<uses-permission android:name="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(permissions, [
    'android.permission.INTERNET',
    'android.permission.WAKE_LOCK',
    'android.permission.FOREGROUND_SERVICE',
  ]);
  assert.doesNotMatch(manifest, /RECORD_AUDIO|READ_EXTERNAL_STORAGE|WRITE_EXTERNAL_STORAGE/);
  assert.match(manifest, /android:name="\.ExitHomeService"/);
  assert.match(manifest, /android:exported="false"/);
  assert.match(manifest, /android:foregroundServiceType="dataSync"/);
  assert.match(exitHome, /https:\/\/personal-ai\.example\.com\/v1\/status/);
  assert.match(exitHome, /ServiceInfo\.FOREGROUND_SERVICE_TYPE_DATA_SYNC/);
  assert.match(exitHome, /keepSessionVisible\(\)/);
  assert.match(exitHome, /sessionWake\.acquire\(MAX_SESSION_MS\)/);
  assert.match(exitHome, /releaseSessionWake\(\)/);
  assert.match(exitHome, /deleteTemporaryAixFiles\(\)/);
  assert.match(exitHome, /name\.startsWith\("personal-ai-"\) && name\.endsWith\("\.aix"\)/);
  assert.match(exitHome, /new YodaJsaiSceneCloser\(this/);
  assert.match(jsaiCloser, /com\.rokid\.os\.sprite\.assist\.MasterAssistService/);
  assert.match(jsaiCloser, /TRANSACTION_CONTROL_MSG_JSON = 3/);
  assert.match(jsaiCloser, /cmd_scene_stop_by_launcher/);
  assert.match(jsaiCloser, /sceneKey\\\":\\\"jsai/);
  assert.match(jsaiCloser, /service\.transact\(TRANSACTION_CONTROL_MSG_JSON/);
  assert.doesNotMatch(source + exitHome, /HomeReturnRequest|moveToFront/);
  assert.match(exitHome, /SCREEN_BRIGHT_WAKE_LOCK \| PowerManager\.ACQUIRE_CAUSES_WAKEUP/);
  assert.match(exitHome, /Intent\.CATEGORY_HOME/);
  assert.match(manifest, /android:icon="@mipmap\/ic_launcher"/);
  const iconSha256 = (await import('node:crypto')).createHash('sha256').update(iconSource).digest('hex');
  assert.equal(iconSha256, '983135e51024a4b97c356da3fc5c7e5c50881f820caa374bca49adbf5673b9f6');
});
