# 自分の環境へ適合するための事項

これはセットアップ手順ではなく、再現を試みる開発者が変更・検証すべき場所の一覧です。公開スナップショットは別環境での通し動作を確認していません。

## 前提

- Rokid AI Glasses RV101とYodaOSのAIUI/AIXを調査・配置できること
- macOS、Node.js、JDK 17、Android SDK 35、Gradle
- ChatGPTへログインしたCodex CLI
- `whisper.cpp`とWhisperモデル、Silero VADモデル
- 自分で管理する固定HTTPSホストとCloudflare named tunnel相当の経路
- 自分で管理するObsidian保管庫と、必要ならGoogle Driveへの接続
- Hi Rokid側で開発者モード（ADB）を有効にした検証用RV101

## 公開コードの例示値

次の値は実在する稼働環境ではありません。

- `personal-ai.example.com` — 自分で管理するHTTPSホストへ置換
- `/path/to/your/ObsidianVault` — 自分のObsidian保管庫へ置換
- `/path/to/your/RokidWorkspace` — 自分の作業場所へ置換
- `your-tailnet.ts.net` — 古い比較実証に残る例示ホスト。現在の中心経路では使用しない

置換後は、テスト内の期待値も同じ値に合わせてください。Android側のURLは `LauncherActivity.java` と `ExitHomeService.java`、Mac側の固定名は `daily-gateway/`、`aiui-knowledge-bridge/`、`mac-companion/` にあります。

## 認証と通信

1. Macの開始口は `127.0.0.1:18447` だけで待ち受けます。
2. 会話中だけ一時受け口 `18448` を開きます。
3. 外部公開は固定HTTPS経路から上記ローカル受け口へ限定します。
4. 起動時のbootstrap tokenと、会話ごとの短命な秘密値を分けます。
5. 秘密値、Cloudflare credentials、生成AIXをGitへ入れません。

公開コードの `mac-companion/install-service.mjs` は既存のCloudflare設定を読み、固定ホスト用の限定ingressを生成する設計です。自分のトンネル名、credentialsファイル、DNS、証明書を自分で用意してください。

## Android起動役

`daily-launcher-android/app/build.gradle` は、`~/.config/rokid-personal-ai/bootstrap-token` をビルド時に読みます。空のままビルドしても実働経路へは接続できません。

公開版にはGradle wrapper、署名鍵、署名済みAPKを含めていません。必要ならapplication ID、署名、バージョンを自分のプロジェクトとして変更してください。

## ObsidianとGoogle Drive

公開コード内の保存先は例示値です。自分の保管庫で、少なくとも次を決め直してください。

- 読み取りを許可する範囲と抜粋上限
- 新規Markdownの固定保存先
- 既存文書編集を許可する親フォルダ
- 会話記録の保存先
- Google Driveの固定フォルダ

対象外パス、シンボリックリンク、同名、対象変更、二重実行を拒否する検査を、自分のパスでも維持してください。

## ローカル文字起こし

`aiui-knowledge-bridge/transcribe.mjs` のWhisper/VADモデルパスを自分の配置へ合わせます。モデルファイルは大きく、ライセンスと配布条件も別に確認してください。このリポジトリにはモデルを含めません。

## 再現時の推奨順序

1. Mac内だけでテストを実行
2. 秘密値なし・無作用の固定文字往復
3. 録音後に必ず原音と一時WAVを削除する一回音声
4. 読み取り専用の回答
5. 未実行候補と取消・期限切れ
6. 専用テストデータだけを使う確認後一回実行
7. 終了後の一時物・受け口・端末設定の復元

実際の保存・編集を試す前に、表示、物理入力、Mac到達、実対象の変更、後片付けを別々に確認してください。
