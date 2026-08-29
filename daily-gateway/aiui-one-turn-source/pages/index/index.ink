<script def>
{ "navigationBarTitleText": "私のAI" }
</script>

<script setup>
const ANSWER_URL = '__ANSWER_URL__';
const CANCEL_URL = '__CANCEL_URL__';
const SESSION_TOKEN = '__SESSION_TOKEN__';
const FREE_REQUEST = __FREE_REQUEST_JSON__;

export default {
  data: {
    state: 'どうぞ',
    detail: FREE_REQUEST,
    instruction: 'テンプル1回：話す',
    phase: 'ready',
    requestId: '',
    lastTriggerAt: 0
  },

  answerRequest() {
    if (this.data.phase !== 'ready') return;
    const requestId = `one_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    this.setData({
      state: 'AIが考えています',
      detail: '読み取り専用の1回処理です',
      instruction: 'もう1回：取り消す',
      phase: 'answering',
      requestId
    });
    wx.request({
      url: ANSWER_URL,
      method: 'POST',
      header: { 'Content-Type': 'application/json', Authorization: `Bearer ${SESSION_TOKEN}` },
      data: { requestId, request: FREE_REQUEST },
      dataType: 'json',
      timeout: 90000,
      success: (response) => this.acceptAnswer(requestId, response && response.data),
      fail: () => this.showFailure('通信できませんでした')
    });
  },

  acceptAnswer(requestId, payload) {
    if (this.data.phase !== 'answering' || this.data.requestId !== requestId) return;
    if (!this.isSafeAnswer(payload)) return this.showFailure('応答を採用しません');
    this.setData({
      state: 'AI',
      detail: `私：${FREE_REQUEST}\n\nAI：${String(payload.answer).slice(0, 240)}`,
      instruction: '戻る：アプリ一覧',
      phase: 'done'
    });
  },

  isSafeAnswer(payload) {
    if (!payload || payload.ok !== true) return false;
    if (payload.requestHandledAs !== 'free_one_turn') return false;
    if (payload.changed !== false || payload.ephemeral !== true) return false;
    if (typeof payload.answer !== 'string' || !payload.answer.length || payload.answer.length > 240) return false;
    if (payload.completed !== true && payload.completed !== false) return false;
    return true;
  },

  cancelRequest() {
    if (this.data.phase !== 'answering' || !this.data.requestId) return;
    const requestId = this.data.requestId;
    this.setData({ state: '取り消しています', instruction: '', phase: 'cancelling' });
    wx.request({
      url: CANCEL_URL,
      method: 'POST',
      header: { 'Content-Type': 'application/json', Authorization: `Bearer ${SESSION_TOKEN}` },
      data: { requestId },
      dataType: 'json',
      timeout: 5000,
      success: () => this.setData({
        state: '取り消しました', detail: '何も変更していません', instruction: '戻る：アプリ一覧', phase: 'done'
      }),
      fail: () => this.showFailure('取消結果を確認できません')
    });
  },

  showFailure(message) {
    this.setData({
      state: message,
      detail: '何も変更していません',
      instruction: '戻る：アプリ一覧',
      phase: 'done'
    });
  },

  onKeyUp(event) {
    const now = Date.now();
    if (now - this.data.lastTriggerAt < 800) return;
    const code = String(event && event.code || '').toLowerCase();
    if (!['enter', 'center', 'ok', 'globalhook'].includes(code)) return;
    if (event && event.preventDefault) event.preventDefault();
    this.setData({ lastTriggerAt: now });
    if (this.data.phase === 'ready') this.answerRequest();
    else if (this.data.phase === 'answering') this.cancelRequest();
  }
}
</script>

<page>
  <view class="screen">
    <text class="title">私のAI</text>
    <text class="state">{{ state }}</text>
    <text class="detail">{{ detail }}</text>
    <text class="instruction">{{ instruction }}</text>
  </view>
</page>

<style>
.screen { display:flex; flex-direction:column; align-items:center; justify-content:center; box-sizing:border-box; height:100vh; padding:14px 18px; background-color:#000000; }
.title,.state,.detail,.instruction { width:100%; color:#40ff5e; text-align:center; }
.title { font-size:24px; line-height:29px; margin-bottom:12px; }
.state { font-size:19px; line-height:25px; margin-bottom:11px; }
.detail { font-size:16px; line-height:22px; margin-top:5px; }
.instruction { font-size:14px; line-height:19px; margin-top:10px; }
</style>
