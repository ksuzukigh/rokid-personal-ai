# 「私のAI」起動役 v0.23.1

RV101の通常のアプリ一覧へ「私のAI」を一つ表示し、選ぶと「私のAI／準備中…」だけを短く出す小さなAndroid起動役です。

- 起動役は認証済みHTTPSで自宅Mac miniの専用待受けへ接続し、会話ごとの別名一時AIXを受け取って開く。日常利用時のADB接続は不要。
- 一時AIXはアプリ専用領域だけへ置き、会話終了時に削除する。音声や依頼本文をAndroidログへ出さない。
- Android側が要求するのは通信、会話中の画面維持、終了検知用サービスの権限。マイク、共有ストレージ、Obsidian操作の権限は要求しない。
- Macの保護ファイルにある開始用認証値はローカルビルド時だけAPKへ設定する。認証値のファイル自体はGitへ追加しない。
- 物理ダブルタップでYodaOSのJS AIシーンを閉じ、システムHomeであるアプリ一覧へ戻る。先に届く`GlobalHook`は650ms保留し、終了操作による誤録音を防ぐ。
- 専用アイコンは、利用者がWeb版ChatGPTで作成して採用した「緑色のメガネ＋会話」の画像を使う。元画像を`icon-source/personal-ai-icon.png`へ保持し、Android標準の5密度へ縮小した同じ意匠をアプリ一覧へ表示する。

無音時間による録音終了を行わず、話し終えたらテンプル1回で確定します。終了操作を受けると、すぐ「受け取りました／AIが考えています」へ切り替わります。戻る操作で取り消し、放置時だけ60秒で停止します。固定メニューは表示しません。

```sh
JAVA_HOME=$(/usr/libexec/java_home -v 17) \
ANDROID_HOME=/opt/homebrew/share/android-commandlinetools \
gradle --offline :app:lintDebug :app:assembleDebug
```
