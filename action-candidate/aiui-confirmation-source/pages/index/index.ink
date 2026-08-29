<script def>
{ "navigationBarTitleText": "私のAI" }
</script>

<script setup>
const SESSION = __CONFIRMATION_SESSION__;

export default {
  data: {
    state: SESSION.preview.kind,
    target: SESSION.preview.target,
    payload: SESSION.preview.payload,
    safety: 'まだ保存・実行していません',
    instruction: 'テンプル1回：Macへ確認',
    phase: 'preview',
    lastTriggerAt: 0
  },

  ticketBody() {
    return {
      ticketId: SESSION.ticketId,
      candidateId: SESSION.candidateId,
      confirmationToken: SESSION.confirmationToken
    };
  },

  sendConfirmation() {
    if (this.data.phase !== 'preview') return;
    this.setData({
      state: '確認を送っています',
      safety: 'まだ保存・実行していません',
      instruction: '', phase: 'sending', lastTriggerAt: Date.now()
    });
    wx.request({
      url: `${SESSION.origin}/v1/confirm`, method: 'POST', dataType: 'json',
      header: { authorization: `Bearer ${SESSION.bearer}`, 'content-type': 'application/json' },
      data: this.ticketBody(),
      success: (response) => {
        if (this.data.phase !== 'sending') return;
        const body = response.data || {};
        if (SESSION.applyOnConfirm === true && response.statusCode >= 200 && response.statusCode < 300 && body.ok === true && body.confirmationRecorded === true && body.applied === true) {
          this.setData({ state: body.changed === false ? '保存済みでした' : (body.text || '保存しました'), safety: '完了', phase: 'finished' });
        } else if (response.statusCode >= 200 && response.statusCode < 300 &&
            body.ok === true && body.confirmationRecorded === true &&
            body.protectedResourceChanged === false) {
          this.setData({ state: 'Macが確認を受け取りました', safety: '保存・実行していません', phase: 'finished' });
        } else if (response.statusCode === 410 || body.reason === 'expired') {
          this.setData({ state: '確認期限が切れました', safety: '保存・実行していません', phase: 'finished' });
        } else {
          this.setData({ state: '確認結果が不明です', safety: '保存・実行していません', phase: 'finished' });
        }
      },
      fail: () => this.setData({ state: '確認結果が不明です', safety: '保存・実行していません', phase: 'finished' })
    });
  },

  sendCancellation() {
    if (this.data.phase !== 'preview') return;
    this.setData({ state: '取り消しを送っています', instruction: '', phase: 'cancelling', lastTriggerAt: Date.now() });
    wx.request({
      url: `${SESSION.origin}/v1/cancel`, method: 'POST', dataType: 'json',
      header: { authorization: `Bearer ${SESSION.bearer}`, 'content-type': 'application/json' },
      data: this.ticketBody(),
      success: (response) => {
        const body = response.data || {};
        const accepted = response.statusCode >= 200 && response.statusCode < 300 && body.status === 'cancelled';
        this.setData({ state: accepted ? '取り消しました' : '取消結果が不明です', safety: '保存・実行していません', phase: 'finished' });
      },
      fail: () => this.setData({ state: '取消結果が不明です', safety: '保存・実行していません', phase: 'finished' })
    });
  },

  onKeyUp(event) {
    const now = Date.now();
    if (now - this.data.lastTriggerAt < 800) return;
    if (event.code === 'Backspace') {
      if (event.preventDefault) event.preventDefault();
      this.sendCancellation();
    } else if (event.code === 'Enter' || event.code === 'GlobalHook') {
      if (event.preventDefault) event.preventDefault();
      this.sendConfirmation();
    }
  }
}
</script>

<page>
  <view class="screen">
    <text class="title">私のAI／実行前</text>
    <text class="state">{{ state }}</text>
    <text class="line">{{ target }}</text>
    <text class="line">{{ payload }}</text>
    <text class="safety">{{ safety }}</text>
    <text class="instruction">{{ instruction }}</text>
  </view>
</page>

<style>
.screen { display:flex; flex-direction:column; align-items:center; justify-content:center; box-sizing:border-box; height:100vh; padding:14px; background-color:#000000; }
.title,.state,.line,.safety,.instruction { width:100%; color:#40ff5e; text-align:center; }
.title { font-size:18px; line-height:22px; margin-bottom:12px; }
.state { font-size:25px; line-height:30px; margin-bottom:14px; }
.line { font-size:16px; line-height:21px; margin-bottom:8px; }
.safety { font-size:17px; line-height:22px; margin-top:8px; }
.instruction { font-size:15px; line-height:20px; margin-top:9px; }
</style>
