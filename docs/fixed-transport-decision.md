# AIUI固定経路の設計判断

## 結論

非公開の実働環境では、Cloudflareの事前作成型トンネル（named tunnel）と、個人AI専用の固定HTTPS名を組み合わせました。

```text
RV101 AIUI
  → 個人AI専用の固定HTTPS名
  → Cloudflare Tunnel
  → Macから外向きに張る接続
  → 127.0.0.1限定の受け口
  → ローカル文字起こし / Codex / 許可した個人資料
```

自宅ルーターへ受信用ポートを開けず、Mac側から外向きに接続できます。Macログイン中は開始口 `18447` だけを待ち受け、会話中だけ一時受け口 `18448` を開きます。

## 比較した方式

### 一時URL

Cloudflare Quick Tunnelは小さな疎通実験には便利でしたが、URLが毎回変わり、稼働保証もありません。RV101へ日常入口を固定する用途には使いませんでした。

### Tailscale Funnel

固定名を持てますが、検証日の接続状態に変動がありました。最初の技術実証には使ったものの、現在の中心経路には採用していません。

### 事前作成型Cloudflare Tunnel

固定HTTPS名、Macからの外向き接続、パスごとのingress制限を組み合わせられるため採用しました。公開コードの `personal-ai.example.com` は例示値であり、実在する稼働先ではありません。

## 安全条件

- 個人AI専用のホストを使い、既存メールやWebのDNSへ影響させない
- トンネル認証はMacだけへ置き、Git、AIX、Obsidianへ保存しない
- bootstrap tokenと、会話ごとの短命な秘密値を分ける
- Mac受け口は `127.0.0.1` 限定、件数・本文量・期限を制限する
- 公開到達確認に合格するまで、認証入り一時AIXを作らない
- 成功、失敗、取消、期限切れのすべてで、一時受け口と一時AIXを削除する
- 録音、保存、編集を単なる接続確認へ混ぜない

## RV101固有の観測

固定名を作った直後の最初の試験では、AIUI独自中継から443番への接続がタイムアウトしました。その後の接続確認と固定質問は成功しましたが、最初の失敗原因は断定していません。

この経験から、録音開始前に次の順で確認します。

1. Mac側のローカル受け口
2. Macから固定HTTPS名への認証付き到達
3. RV101起動時の到達確認
4. 利用者が録音開始を選んだ直後の再確認

接続失敗時は録音や現実作用へ進めず、Rokidへ失敗を表示して後片付けします。

## 参考資料

- [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/create-local-tunnel/)
- [Tailscale Funnel](https://tailscale.com/docs/features/tailscale-funnel)
