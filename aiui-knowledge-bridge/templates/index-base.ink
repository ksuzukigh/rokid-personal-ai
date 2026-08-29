<script def>
{
  "navigationBarTitleText": "文字往復テスト"
}
</script>

<script setup>
const PROBE_URL = 'https://js.rokid.com/api/v1/testing/http/echo';
const CANCEL_URL = '';
const PROBE_TOKEN = '';
const PROBE_TEXT = 'ROKID_AIUI_PROBE_V1';

function buildHeaders() {
  const header = { 'content-type': 'application/json' };
  if (PROBE_TOKEN) header.authorization = `Bearer ${PROBE_TOKEN}`;
  return header;
}

export default {
  data: {
    state: '準備完了',
    detail: '1回で送信・送信中にもう1回で取消',
    busy: false,
    generation: 0,
    lastTriggerAt: 0
  },
  requestTask: null,
  activeRequestId: null,

  sendProbe() {
    const now = Date.now();
    if (this.data.busy || now - this.data.lastTriggerAt < 800) return;

    const generation = this.data.generation + 1;
    const requestId = `rokid-aiui-${now}`;
    this.setData({
      state: '送信中',
      detail: '固定文字だけを送信',
      busy: true,
      generation,
      lastTriggerAt: now
    });

    const task = wx.request({
      url: PROBE_URL,
      method: 'POST',
      header: buildHeaders(),
      data: { requestId, text: PROBE_TEXT },
      dataType: 'json',
      success: (response) => {
        if (generation !== this.data.generation) return;
        if (response.statusCode < 200 || response.statusCode >= 300) {
          this.setData({ state: '通信失敗', detail: `HTTP ${response.statusCode}`, busy: false });
          return;
        }

        const payload = response.data || {};
        const echoed = payload && payload.body ? payload.body : {};
        const matched = echoed.requestId === requestId && echoed.text === PROBE_TEXT;
        this.setData({
          state: matched ? '往復成功' : '応答不一致',
          detail: matched ? '受信しました' : '内容を採用しません',
          busy: false
        });
      },
      fail: (error) => {
        if (generation !== this.data.generation) return;
        this.setData({
          state: '通信失敗',
          detail: error && error.errMsg ? error.errMsg : '応答がありません',
          busy: false
        });
      },
      complete: () => {
        if (generation === this.data.generation) {
          this.requestTask = null;
          this.activeRequestId = null;
        }
      }
    });
    this.requestTask = task;
    this.activeRequestId = requestId;
  },

  cancelProbe() {
    const task = this.requestTask;
    const requestId = this.activeRequestId;
    this.requestTask = null;
    this.activeRequestId = null;
    this.setData({
      state: '取り消しました',
      detail: '通信を中断し、応答を反映しません',
      busy: false,
      generation: this.data.generation + 1,
      lastTriggerAt: Date.now()
    });
    if (task && typeof task.abort === 'function') task.abort();
    if (CANCEL_URL && requestId) {
      wx.request({
        url: CANCEL_URL,
        method: 'POST',
        header: buildHeaders(),
        data: { requestId },
        dataType: 'json'
      });
    }
  },

  onKeyUp(event) {
    if (event.code === 'Backspace') {
      if (event.preventDefault) event.preventDefault();
      this.cancelProbe();
      return;
    }

    if (event.code === 'Enter' || event.code === 'GlobalHook') {
      if (event.preventDefault) event.preventDefault();
      const now = Date.now();
      if (now - this.data.lastTriggerAt < 800) return;
      if (this.data.busy) this.cancelProbe();
      else this.sendProbe();
    }
  },

  onHide() {
    this.cancelProbe();
  }
}
</script>

<page>
  <view class="screen">
    <text class="title">文字往復テスト</text>
    <text class="state">{{ state }}</text>
    <text class="detail">{{ detail }}</text>
    <button class="action" bindtap="sendProbe">送信</button>
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

.title,
.state,
.detail,
.action {
  width: 100%;
  color: #40ff5e;
  text-align: center;
}

.title {
  font-size: 22px;
  line-height: 26px;
  margin-bottom: 18px;
}

.state {
  font-size: 28px;
  line-height: 32px;
  margin-bottom: 12px;
}

.detail {
  font-size: 18px;
  line-height: 22px;
  margin-bottom: 20px;
}

.action {
  box-sizing: border-box;
  width: 140px;
  padding: 8px;
  border: 2px solid #40ff5e;
  border-radius: 12px;
  font-size: 20px;
  line-height: 24px;
}
</style>
