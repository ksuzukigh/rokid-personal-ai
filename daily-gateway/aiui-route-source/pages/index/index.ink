<script def>
{ "navigationBarTitleText": "私のAI" }
</script>

<script setup>
const ROUTE_URL = '__ROUTE_URL__';
const CANCEL_URL = '__CANCEL_URL__';
const SESSION_TOKEN = '__SESSION_TOKEN__';
const UTTERANCE = __UTTERANCE_JSON__;

export default {
  data: {
    state: '行き先だけを確認します',
    detail: '録音・検索・保存はしません',
    instruction: 'テンプル1回：確認する',
    phase: 'ready',
    requestId: '',
    lastTriggerAt: 0
  },

  routeRequest() {
    if (this.data.phase !== 'ready') return;
    const requestId = `daily_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    this.setData({
      state: 'AIが行き先を確認中',
      detail: 'まだ何も実行していません',
      instruction: 'もう1回：取り消す',
      phase: 'routing',
      requestId
    });
    wx.request({
      url: ROUTE_URL,
      method: 'POST',
      header: { 'Content-Type': 'application/json', Authorization: `Bearer ${SESSION_TOKEN}` },
      data: { requestId, utterance: UTTERANCE },
      dataType: 'json',
      timeout: 70000,
      success: (response) => this.acceptRoute(requestId, response && response.data),
      fail: () => this.showFailure('通信できませんでした')
    });
  },

  acceptRoute(requestId, payload) {
    if (this.data.phase !== 'routing' || this.data.requestId !== requestId) return;
    if (!this.isSafeRoute(payload)) return this.showFailure('応答を採用しません');
    const display = this.routeDisplay(payload);
    this.setData({
      state: display.state,
      detail: display.detail,
      instruction: '戻る：アプリ一覧',
      phase: 'done'
    });
  },

  isSafeRoute(payload) {
    if (!payload || payload.ok !== true || payload.executionCapability !== 'none' || payload.changed !== false) return false;
    if (payload.intent === 'voice_note') {
      return payload.confirmationRequired === true && payload.recordingConsentRequired === true;
    }
    if (payload.intent === 'web_research_note') {
      return payload.confirmationRequired === true && payload.recordingConsentRequired === false;
    }
    if (['personal_knowledge_question', 'needs_clarification', 'unsupported'].includes(payload.intent)) {
      return payload.confirmationRequired === false && payload.recordingConsentRequired === false;
    }
    return false;
  },

  routeDisplay(payload) {
    if (payload.intent === 'voice_note') {
      return { state: '行き先：音声メモ', detail: '録音前に、改めて確認します' };
    }
    if (payload.intent === 'personal_knowledge_question') {
      return { state: '行き先：私の資料', detail: '読み取り専用。まだ検索していません' };
    }
    if (payload.intent === 'web_research_note') {
      return { state: '行き先：Web検索メモ', detail: '保存前に内容を確認します' };
    }
    if (payload.intent === 'needs_clarification') {
      const question = String(payload.clarifyingQuestion || '').slice(0, 90);
      return { state: 'もう少し教えてください', detail: question || '目的を一つに決められません' };
    }
    return { state: 'この操作はまだ対応していません', detail: '何も実行していません' };
  },

  cancelRequest() {
    if (this.data.phase !== 'routing' || !this.data.requestId) return;
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
    if (this.data.phase === 'ready') this.routeRequest();
    else if (this.data.phase === 'routing') this.cancelRequest();
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
