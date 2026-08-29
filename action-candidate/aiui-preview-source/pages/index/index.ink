<script def>
{
  "navigationBarTitleText": "私のAI"
}
</script>

<script setup>
const PREVIEW = __CANDIDATE_PREVIEW__;

export default {
  data: {
    state: PREVIEW.kind,
    target: PREVIEW.target,
    payload: PREVIEW.payload,
    safety: 'まだ保存・実行していません',
    instruction: 'テンプル1回：内容確認',
    phase: 'preview',
    lastTriggerAt: 0
  },

  confirmPreview() {
    if (this.data.phase !== 'preview') return;
    this.setData({
      state: '内容を確認しました',
      safety: '保存・実行していません',
      instruction: '',
      phase: 'finished',
      lastTriggerAt: Date.now()
    });
  },

  cancelPreview() {
    if (this.data.phase !== 'preview') return;
    this.setData({
      state: '取り消しました',
      safety: '何も変更していません',
      instruction: '',
      phase: 'finished',
      lastTriggerAt: Date.now()
    });
  },

  onKeyUp(event) {
    const now = Date.now();
    if (now - this.data.lastTriggerAt < 800) return;
    if (event.code === 'Backspace') {
      if (event.preventDefault) event.preventDefault();
      this.cancelPreview();
      return;
    }
    if (event.code === 'Enter' || event.code === 'GlobalHook') {
      if (event.preventDefault) event.preventDefault();
      this.confirmPreview();
    }
  },

  onHide() {
    this.cancelPreview();
  }
}
</script>

<page>
  <view class="screen">
    <text class="title">私のAI／実行前</text>
    <text class="state">{{ state }}</text>
    <text class="target">{{ target }}</text>
    <text class="payload">{{ payload }}</text>
    <text class="safety">{{ safety }}</text>
    <text class="instruction">{{ instruction }}</text>
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
  padding: 14px;
  background-color: #000000;
}

.title,
.state,
.target,
.payload,
.safety,
.instruction {
  width: 100%;
  color: #40ff5e;
  text-align: center;
}

.title { font-size: 18px; line-height: 22px; margin-bottom: 12px; }
.state { font-size: 27px; line-height: 31px; margin-bottom: 14px; }
.target, .payload { font-size: 16px; line-height: 21px; margin-bottom: 8px; }
.safety { font-size: 17px; line-height: 22px; margin-top: 8px; }
.instruction { font-size: 15px; line-height: 20px; margin-top: 9px; }
</style>
