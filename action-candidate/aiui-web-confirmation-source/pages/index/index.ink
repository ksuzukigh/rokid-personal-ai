<script def>
{ "navigationBarTitleText": "私のAI" }
</script>

<script setup>
const SESSION = __WEB_CONFIRMATION_SESSION__;

export default {
  data: {
    state: `Web検索結果 ${SESSION.sourceCount}件`,
    summary: SESSION.summary,
    source1Title: SESSION.sources[0] ? `1. ${SESSION.sources[0].title}` : '',
    source1Url: SESSION.sources[0] ? SESSION.sources[0].url : '',
    source2Title: SESSION.sources[1] ? `2. ${SESSION.sources[1].title}` : '',
    source2Url: SESSION.sources[1] ? SESSION.sources[1].url : '',
    source3Title: SESSION.sources[2] ? `3. ${SESSION.sources[2].title}` : '',
    source3Url: SESSION.sources[2] ? SESSION.sources[2].url : '',
    safety: 'まだObsidianへ保存していません',
    instruction: 'テンプル1回：この内容を保存',
    phase: 'preview',
    lastTriggerAt: 0
  },

  ticketBody() {
    return { ticketId: SESSION.ticketId, candidateId: SESSION.candidateId, confirmationToken: SESSION.confirmationToken };
  },

  finish(state, safety) {
    this.setData({
      state, summary: '', source1Title: '', source1Url: '', source2Title: '', source2Url: '',
      source3Title: '', source3Url: '', safety, instruction: '', phase: 'finished'
    });
  },

  sendConfirmation() {
    if (this.data.phase !== 'preview') return;
    this.setData({ state: '保存の確認を送っています', safety: 'まだ保存していません', instruction: '', phase: 'sending', lastTriggerAt: Date.now() });
    wx.request({
      url: `${SESSION.origin}/v1/confirm`, method: 'POST', dataType: 'json',
      header: { authorization: `Bearer ${SESSION.bearer}`, 'content-type': 'application/json' },
      data: this.ticketBody(),
      success: (response) => {
        if (this.data.phase !== 'sending') return;
        const body = response.data || {};
        if (response.statusCode >= 200 && response.statusCode < 300 && body.ok === true && body.confirmationRecorded === true && body.applied === true) {
          this.finish(body.changed === false ? '保存済みでした' : (body.text || 'Web検索メモへ保存しました'), '完了');
        } else if (response.statusCode === 410 || body.reason === 'expired') {
          this.finish('確認期限が切れました', '保存していません');
        } else {
          this.finish('保存結果が不明です', '内容を確認してください');
        }
      },
      fail: () => this.finish('保存結果が不明です', '内容を確認してください')
    });
  },

  sendCancellation() {
    if (this.data.phase !== 'preview') return;
    this.setData({ state: '取り消しを送っています', instruction: '', phase: 'cancelling', lastTriggerAt: Date.now() });
    wx.request({
      url: `${SESSION.origin}/v1/cancel`, method: 'POST', dataType: 'json',
      header: { authorization: `Bearer ${SESSION.bearer}`, 'content-type': 'application/json' }, data: this.ticketBody(),
      success: (response) => {
        const body = response.data || {};
        this.finish(response.statusCode >= 200 && response.statusCode < 300 && body.status === 'cancelled' ? '取り消しました' : '取消結果が不明です', '保存していません');
      },
      fail: () => this.finish('取消結果が不明です', '保存していません')
    });
  },

  onKeyUp(event) {
    const now = Date.now();
    if (now - this.data.lastTriggerAt < 800) return;
    if (event.code === 'Backspace') { if (event.preventDefault) event.preventDefault(); this.sendCancellation(); }
    else if (event.code === 'Enter' || event.code === 'GlobalHook') { if (event.preventDefault) event.preventDefault(); this.sendConfirmation(); }
  }
}
</script>

<page>
  <view class="screen">
    <text class="title">私のAI／保存前の確認</text>
    <text class="state">{{ state }}</text>
    <text class="summary">{{ summary }}</text>
    <view class="sources">
      <view class="source"><text class="source-title">{{ source1Title }}</text><text class="source-url">{{ source1Url }}</text></view>
      <view class="source"><text class="source-title">{{ source2Title }}</text><text class="source-url">{{ source2Url }}</text></view>
      <view class="source"><text class="source-title">{{ source3Title }}</text><text class="source-url">{{ source3Url }}</text></view>
    </view>
    <text class="safety">{{ safety }}</text>
    <text class="instruction">{{ instruction }}</text>
  </view>
</page>

<style>
.screen { display:flex; flex-direction:column; align-items:center; justify-content:center; box-sizing:border-box; height:100vh; padding:12px 14px; background-color:#000000; }
.title,.state,.summary,.source-title,.source-url,.safety,.instruction { width:100%; color:#40ff5e; text-align:center; }
.title { font-size:16px; line-height:20px; margin-bottom:7px; }
.state { font-size:23px; line-height:27px; margin-bottom:8px; }
.summary { font-size:14px; line-height:18px; margin-bottom:8px; }
.sources { width:100%; }
.source { width:100%; margin-bottom:5px; }
.source-title { display:block; font-size:13px; line-height:16px; }
.source-url { display:block; font-size:11px; line-height:14px; }
.safety { font-size:15px; line-height:19px; margin-top:5px; }
.instruction { font-size:14px; line-height:18px; margin-top:6px; }
</style>
