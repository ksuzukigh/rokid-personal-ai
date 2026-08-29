<script def>
{
  "navigationBarTitleText": "私のAI"
}
</script>

<script setup>

const AUDIO_URL = '';
const CANCEL_URL = '';
const EFFECT_CONFIRM_URL = '';
const EFFECT_CANCEL_URL = '';
const AUTH_TOKEN = '';
const PREVIEW_CONFIRMATION_TEXT = '';
const TEST_LABEL = '';
const PROMPT_TEXT = '';
const EVALUATION_ONLY = false;
const CODEX_CONVERSATION_MODE = false;
const PREFLIGHT_ONLY = false;
const PROCESSING_PREVIEW_ONLY = false;
const ALLOW_REPEAT = false;
const HEALTH_URL = AUDIO_URL ? AUDIO_URL.replace(/\/v1\/transcribe$/, '/v1/health') : '';
const INPUT_DEBOUNCE_MS = 800;
const DOUBLE_TAP_EXIT_GRACE_MS = 650;
const ANSWER_REQUEST_TIMEOUT_MS = 630000;
const HEALTH_CHECK_ATTEMPTS = 2;

const AUDIO_LIMITS = Object.freeze({
  sampleRate: 16000,
  channels: 1,
  bytesPerSample: 2,
  maxDurationMs: 10000,
  maxBytes: 320000
});

const VOICE_ACTIVITY_LIMITS = Object.freeze({
  minimumRms: 350,
  minimumPeak: 1000,
  minimumSpeechMs: 250,
  minimumRecordingMs: 0,
  automaticStopOnSilence: true,
  trailingSilenceMs: 900
});

class PcmVoiceActivityDetector {
  constructor() {
    this.reset();
  }

  reset() {
    this.speechDetected = false;
    this.consecutiveSpeechMs = 0;
    this.trailingSilenceMs = 0;
    this.totalDurationMs = 0;
    this.voicedDurationMs = 0;
    this.frameCount = 0;
    this.maxRms = 0;
    this.maxPeak = 0;
    this.speechDetectedAtMs = null;
  }

  process(frame) {
    const bytes = frame instanceof Uint8Array ? frame : new Uint8Array(frame);
    if (bytes.byteLength === 0 || bytes.byteLength % 2 !== 0) {
      return { valid: false, speechDetected: this.speechDetected, shouldStop: false };
    }
    let sumSquares = 0;
    let peak = 0;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const samples = bytes.byteLength / 2;
    for (let offset = 0; offset < bytes.byteLength; offset += 2) {
      const sample = view.getInt16(offset, true);
      const absolute = Math.abs(sample);
      if (absolute > peak) peak = absolute;
      sumSquares += sample * sample;
    }
    const rms = Math.sqrt(sumSquares / samples);
    const durationMs = samples * 1000 / AUDIO_LIMITS.sampleRate;
    const voiced = rms >= VOICE_ACTIVITY_LIMITS.minimumRms && peak >= VOICE_ACTIVITY_LIMITS.minimumPeak;
    this.totalDurationMs += durationMs;
    this.frameCount += 1;
    if (voiced) this.voicedDurationMs += durationMs;
    if (rms > this.maxRms) this.maxRms = rms;
    if (peak > this.maxPeak) this.maxPeak = peak;
    if (!this.speechDetected) {
      this.consecutiveSpeechMs = voiced ? this.consecutiveSpeechMs + durationMs : 0;
      if (this.consecutiveSpeechMs >= VOICE_ACTIVITY_LIMITS.minimumSpeechMs) {
        this.speechDetected = true;
        this.speechDetectedAtMs = this.totalDurationMs;
        this.trailingSilenceMs = 0;
      }
    } else if (voiced) {
      this.trailingSilenceMs = 0;
    } else {
      this.trailingSilenceMs += durationMs;
    }
    return {
      valid: true,
      speechDetected: this.speechDetected,
      shouldStop: VOICE_ACTIVITY_LIMITS.automaticStopOnSilence &&
        this.speechDetected &&
        this.totalDurationMs >= VOICE_ACTIVITY_LIMITS.minimumRecordingMs &&
        this.trailingSilenceMs >= VOICE_ACTIVITY_LIMITS.trailingSilenceMs
    };
  }

  summary() {
    return {
      frameCount: this.frameCount,
      totalDurationMs: Math.round(this.totalDurationMs),
      voicedDurationMs: Math.round(this.voicedDurationMs),
      maxRms: Math.round(this.maxRms),
      maxPeak: this.maxPeak,
      speechDetected: this.speechDetected,
      speechDetectedAtMs: this.speechDetectedAtMs === null ? null : Math.round(this.speechDetectedAtMs),
      trailingSilenceMs: Math.round(this.trailingSilenceMs)
    };
  }
}

class OneShotAudioSession {
  constructor() {
    this.voiceDetector = new PcmVoiceActivityDetector();
    this.reset();
  }

  reset() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.phase = 'idle';
    this.requestId = null;
    this.chunks = [];
    this.totalBytes = 0;
    this.stopRecorder = null;
    this.abortSend = null;
    this.voiceState = null;
    this.voiceDetector.reset();
  }

  begin({ requestId, stopRecorder }) {
    if (this.phase !== 'idle' && this.phase !== 'done' && this.phase !== 'cancelled') return false;
    this.reset();
    this.phase = 'recording';
    this.requestId = requestId;
    this.stopRecorder = stopRecorder;
    this.timer = setTimeout(() => {
      if (this.phase !== 'recording') return;
      this.phase = 'stopping';
      if (this.stopRecorder) this.stopRecorder('time_limit');
    }, AUDIO_LIMITS.maxDurationMs);
    return true;
  }

  appendFrame(frame) {
    if (this.phase !== 'recording') return false;
    const bytes = frame instanceof Uint8Array ? frame : new Uint8Array(frame);
    if (bytes.byteLength === 0 || bytes.byteLength % AUDIO_LIMITS.bytesPerSample !== 0) {
      this.cancel('invalid_pcm', { stopRecorder: true });
      return false;
    }
    if (this.totalBytes + bytes.byteLength > AUDIO_LIMITS.maxBytes) {
      this.cancel('size_limit', { stopRecorder: true });
      return false;
    }
    this.chunks.push(bytes.slice());
    this.totalBytes += bytes.byteLength;
    this.voiceState = this.voiceDetector.process(bytes);
    if (!this.voiceState.valid) {
      this.cancel('invalid_pcm', { stopRecorder: true });
      return false;
    }
    if (this.voiceState.shouldStop) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      this.phase = 'stopping';
      if (this.stopRecorder) this.stopRecorder('silence_after_speech');
    }
    return true;
  }

  finishRecording(reason = 'user_finished') {
    if (this.phase !== 'recording') return false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.phase = 'stopping';
    if (this.stopRecorder) this.stopRecorder(reason);
    return true;
  }

  recorderStopped(send) {
    if (this.phase !== 'recording' && this.phase !== 'stopping') return null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const audio = new Uint8Array(this.totalBytes);
    let offset = 0;
    for (const chunk of this.chunks) {
      audio.set(chunk, offset);
      offset += chunk.byteLength;
    }
    this.chunks = [];
    this.totalBytes = 0;
    this.phase = 'sending';
    const control = send({ requestId: this.requestId, audio });
    this.abortSend = control && control.abort ? control.abort : null;
    return control && control.promise ? control.promise : Promise.resolve(control);
  }

  markDone() {
    if (this.phase === 'sending') this.phase = 'done';
    this.abortSend = null;
  }

  cancel(reason = 'user', { stopRecorder = true } = {}) {
    const wasRecording = this.phase === 'recording' || this.phase === 'stopping';
    const wasSending = this.phase === 'sending';
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.chunks = [];
    this.totalBytes = 0;
    this.phase = 'cancelled';
    if (wasRecording && stopRecorder && this.stopRecorder) this.stopRecorder(reason);
    if (wasSending && this.abortSend) this.abortSend();
    this.abortSend = null;
    return { requestId: this.requestId, wasRecording, wasSending, reason };
  }
}

function headers(requestId) {
  const value = {
    'content-type': 'application/octet-stream',
    'x-request-id': requestId,
    'x-audio-format': 'pcm_s16le',
    'x-sample-rate': '16000',
    'x-channels': '1'
  };
  if (AUTH_TOKEN) value.authorization = `Bearer ${AUTH_TOKEN}`;
  return value;
}

function effectHeaders() {
  const value = { 'content-type': 'application/json' };
  if (AUTH_TOKEN) value.authorization = `Bearer ${AUTH_TOKEN}`;
  return value;
}

export default {
  data: {
    state: TEST_LABEL || 'どうぞ',
    detail: PROMPT_TEXT ? `「${PROMPT_TEXT}」` : '',
    phase: 'idle',
    attemptUsed: false,
    recognizedText: '',
    actionLabel: '話す',
    lastTriggerAt: 0
  },

  onLoad() {
    this.session = new OneShotAudioSession();
    this.requestTask = null;
    this.preflightTask = null;
    this.cancelledDuringRecord = false;
    this.pendingGlobalHookTimer = null;
    this.pendingEffect = null;
    this.effectRequestTask = null;
    if (PROCESSING_PREVIEW_ONLY) {
      this.recorder = null;
      this.setData({
        state: '考え中…',
        detail: '',
        phase: 'sending',
        attemptUsed: true,
        actionLabel: ''
      });
      return;
    }
    if (PREVIEW_CONFIRMATION_TEXT) {
      this.recorder = null;
      this.setData({ attemptUsed: true });
      this.showConversationTurn(PREVIEW_CONFIRMATION_TEXT);
      return;
    }
    this.recorder = wx.media.getRecorderManager();
    this.bindRecorder();
    if (HEALTH_URL && AUTH_TOKEN) this.preflightConnection();
  },

  async preflightConnection() {
    this.setData({ state: '準備中…', detail: '', phase: 'checking', actionLabel: '' });
    const ready = await this.runHealthCheck();
    if (this.data.phase !== 'checking') return;
    if (ready) {
      this.setData({
        state: TEST_LABEL || 'どうぞ',
        detail: PROMPT_TEXT ? `「${PROMPT_TEXT}」` : '',
        phase: 'idle',
        actionLabel: '話す'
      });
    } else {
      this.setData({ state: '接続できません', detail: '時間をおいて開き直してください', phase: 'finished', actionLabel: '終了' });
    }
  },

  async runHealthCheck() {
    for (let attempt = 1; attempt <= HEALTH_CHECK_ATTEMPTS; attempt += 1) {
      const ready = await this.runSingleHealthCheck();
      if (ready) return true;
      if (this.data.phase !== 'checking') return false;
      if (attempt < HEALTH_CHECK_ATTEMPTS) {
        this.setData({ state: '準備中…', detail: '' });
      }
    }
    return false;
  },

  runSingleHealthCheck() {
    return new Promise((resolve) => {
      let task = null;
      task = wx.request({
        url: HEALTH_URL,
        method: 'POST',
        header: { authorization: `Bearer ${AUTH_TOKEN}` },
        dataType: 'json',
        success: (response) => {
          const body = response.data || {};
          resolve(response.statusCode >= 200 && response.statusCode < 300 && body.ok === true && body.ready === true);
        },
        fail: () => resolve(false),
        complete: () => { if (this.preflightTask === task) this.preflightTask = null; }
      });
      this.preflightTask = task;
    });
  },

  bindRecorder() {
    if (!this.recorder) {
      this.setData({ state: '録音できません', detail: '開き直してください', actionLabel: '終了' });
      return;
    }
    this.recorder.onFrameRecorded((payload) => {
      const frame = payload && payload.frameBuffer;
      if (!frame) return;
      if (!this.session.appendFrame(frame)) {
        if (this.session.phase === 'cancelled') {
          this.cancelledDuringRecord = true;
          this.setData({ state: '録音を中止しました', detail: '音声が長すぎました', phase: 'finished', actionLabel: '終了' });
        }
        return;
      }
    });
    this.recorder.onStop(() => {
      if (this.cancelledDuringRecord) {
        this.cancelledDuringRecord = false;
        return;
      }
      this.setData({
        state: '考え中…',
        detail: '',
        phase: 'sending',
        actionLabel: ''
      });
      const pending = this.session.recorderStopped((payload) => this.sendAudio(payload));
      if (!pending) return;
      pending
        .then(() => this.session.markDone())
        .catch(() => {
          if (this.session.phase === 'sending') this.session.reset();
        });
    });
    this.recorder.onError((payload) => {
      this.session.cancel('recorder_error', { stopRecorder: false });
      this.setData({
        state: '録音できません',
        detail: '開き直してください',
        phase: 'finished',
        actionLabel: '終了'
      });
    });
  },

  async startRecording() {
    if (!this.recorder || !['idle', 'done'].includes(this.data.phase)) return;
    if (this.data.attemptUsed) {
      this.setData({ state: '終了しました', detail: '', phase: 'finished', actionLabel: '終了' });
      return;
    }
    if (!AUDIO_URL || !AUTH_TOKEN) {
      this.setData({ state: '接続できません', detail: '開き直してください', actionLabel: '終了' });
      return;
    }
    this.setData({ state: '準備中…', detail: '', phase: 'checking', actionLabel: '' });
    const reachable = await this.runHealthCheck();
    if (this.data.phase !== 'checking') return;
    if (!reachable) {
      this.setData({ state: '接続できません', detail: '時間をおいて開き直してください', phase: 'finished', actionLabel: '終了' });
      return;
    }
    if (PREFLIGHT_ONLY) {
      this.setData({ state: '準備できました', detail: '', phase: 'finished', actionLabel: '終了' });
      return;
    }
    const requestId = `rokid-audio-${Date.now()}`;
    this.setData({ attemptUsed: true });
    this.cancelledDuringRecord = false;
    this.session.begin({
      requestId,
      stopRecorder: (reason) => {
        console.log(`VOICE_ACTIVITY_SUMMARY ${JSON.stringify({
          reason,
          ...this.session.voiceDetector.summary()
        })}`);
        this.setData({
          state: '考え中…',
          detail: '',
          phase: 'stopping',
          actionLabel: ''
        });
        this.recorder.stop().catch(() => {});
      }
    });
    this.setData({
      state: '聞いています',
      detail: '1回で終了',
      phase: 'recording',
      actionLabel: '終了'
    });
    try {
      await this.recorder.start({ sampleRate: 16000, numberOfChannels: 1, format: 'pcm' });
    } catch (error) {
      this.session.cancel('start_failed', { stopRecorder: false });
      this.setData({ state: '録音できません', detail: '開き直してください', phase: 'finished', actionLabel: '終了' });
    }
  },

  prepareNextQuestion({ startImmediately = false } = {}) {
    if (!ALLOW_REPEAT || this.data.phase !== 'finished') return;
    this.session.reset();
    this.setData({
      state: TEST_LABEL || 'どうぞ',
      detail: '',
      phase: 'idle',
      attemptUsed: false,
      actionLabel: '話す',
      recognizedText: ''
    });
    if (startImmediately) {
      setTimeout(() => this.startRecording(), 0);
    }
  },

  sendAudio(payload) {
    let resolvePromise;
    let rejectPromise;
    const promise = new Promise((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    const task = wx.request({
      url: AUDIO_URL,
      method: 'POST',
      header: headers(payload.requestId),
      data: payload.audio.buffer,
      dataType: 'json',
      timeout: ANSWER_REQUEST_TIMEOUT_MS,
      success: (response) => {
        if (this.session.phase !== 'sending') return;
        const body = response.data || {};
        if (response.statusCode >= 200 && response.statusCode < 300 && body.requestId === payload.requestId) {
          this.session.markDone();
          if (body.text && body.requestHandledAs === 'codex_conversation_turn' &&
              typeof body.needsUserInput === 'boolean' && typeof body.usedPreviousTurn === 'boolean' &&
              body.conversationRecorded === true && body.changed === false &&
              body.sessionScoped === true &&
              (body.effectProposal === null || this.isValidEffectProposal(body.effectProposal)) &&
              !(body.needsUserInput && body.effectProposal)) {
            if (body.effectProposal) {
              this.showPendingEffect(body.text, body.requestText, body.effectProposal);
            } else {
              this.showConversationTurn(body.text, body.requestText);
            }
          } else if (body.text && EVALUATION_ONLY && !CODEX_CONVERSATION_MODE) {
            this.showConversationTurn(body.text, body.requestText);
          }
          else this.setData({
            state: 'うまくいきませんでした',
            detail: ALLOW_REPEAT ? 'もう一度話してください' : '',
            phase: 'finished',
            actionLabel: ALLOW_REPEAT ? '続けて話す' : '終了'
          });
          resolvePromise();
        } else {
          this.setData({
            state: 'うまくいきませんでした',
            detail: ALLOW_REPEAT ? 'もう一度話してください' : '',
            phase: 'finished',
            actionLabel: ALLOW_REPEAT ? '続けて話す' : '終了'
          });
          rejectPromise(new Error('invalid response'));
        }
      },
      fail: (error) => {
        if (this.session.phase !== 'sending') return;
        this.setData({
          state: '接続できませんでした',
          detail: ALLOW_REPEAT ? 'もう一度話してください' : '開き直してください',
          phase: 'finished',
          actionLabel: ALLOW_REPEAT ? '続けて話す' : '終了'
        });
        rejectPromise(new Error('request failed'));
      },
      complete: () => { this.requestTask = null; }
    });
    this.requestTask = task;
    return { promise, abort: () => task.abort() };
  },

  showConversationTurn(text, requestText = '') {
    this.setData({
      state: 'AI',
      detail: `私：${requestText || '（認識文なし）'}\n\nAI：${text}`,
      recognizedText: '',
      phase: 'finished',
      actionLabel: ALLOW_REPEAT ? '続けて話す' : '終了'
    });
  },

  showPendingEffect(text, requestText = '', effect = null) {
    this.pendingEffect = effect;
    this.setData({
      state: 'AI',
      detail: `私：${requestText || '（認識文なし）'}\n\nAI：${text}\n\n操作内容：${effect.summary}\n対象：${effect.targetHint}\n題名：${effect.title}\n${effect.preview}\n\nまだ実行していません`,
      recognizedText: '',
      phase: 'effect_confirmation',
      actionLabel: '実行する'
    });
  },

  isValidEffectProposal(effect) {
    return effect && typeof effect.summary === 'string' && typeof effect.details === 'string' &&
      typeof effect.action === 'string' && typeof effect.title === 'string' &&
      typeof effect.targetHint === 'string' && typeof effect.preview === 'string' &&
      typeof effect.ticketId === 'string' && typeof effect.candidateId === 'string' &&
      typeof effect.confirmationToken === 'string';
  },

  confirmPendingEffect() {
    if (!this.pendingEffect || !EFFECT_CONFIRM_URL || this.data.phase !== 'effect_confirmation') return;
    const effect = this.pendingEffect;
    this.setData({ state: '実行中…', detail: '', phase: 'confirming_effect', actionLabel: '' });
    const task = wx.request({
      url: EFFECT_CONFIRM_URL,
      method: 'POST',
      header: effectHeaders(),
      data: {
        ticketId: effect.ticketId,
        candidateId: effect.candidateId,
        confirmationToken: effect.confirmationToken
      },
      dataType: 'json',
      timeout: ANSWER_REQUEST_TIMEOUT_MS,
      success: (response) => {
        const body = response.data || {};
        this.pendingEffect = null;
        if (response.statusCode >= 200 && response.statusCode < 300 && body.ok === true &&
            body.applied === true && body.changed === true && typeof body.text === 'string') {
          this.setData({
            state: 'AI',
            detail: body.text,
            phase: 'finished',
            actionLabel: ALLOW_REPEAT ? '続けて話す' : '終了'
          });
        } else {
          this.setData({
            state: '変更しませんでした',
            detail: typeof body.text === 'string' ? body.text : '対象または確認状態が変わりました',
            phase: 'finished',
            actionLabel: ALLOW_REPEAT ? '続けて話す' : '終了'
          });
        }
      },
      fail: () => {
        this.setData({
          state: '結果を確認できません',
          detail: '同じ操作を繰り返さず、Mac側で確認してください',
          phase: 'finished',
          actionLabel: '終了'
        });
      },
      complete: () => { if (this.effectRequestTask === task) this.effectRequestTask = null; }
    });
    this.effectRequestTask = task;
  },

  cancelPendingEffect() {
    if (!this.pendingEffect || !EFFECT_CANCEL_URL || this.data.phase !== 'effect_confirmation') return;
    const effect = this.pendingEffect;
    this.pendingEffect = null;
    wx.request({
      url: EFFECT_CANCEL_URL,
      method: 'POST',
      header: effectHeaders(),
      data: {
        ticketId: effect.ticketId,
        candidateId: effect.candidateId,
        confirmationToken: effect.confirmationToken
      },
      dataType: 'json'
    });
  },

  cancel() {
    const result = this.session.cancel('user');
    if (result.wasRecording) this.cancelledDuringRecord = true;
    this.setData({ state: '取り消しました', detail: '', phase: 'idle', actionLabel: '話す' });
    if (result.wasSending && CANCEL_URL && result.requestId) {
      wx.request({
        url: CANCEL_URL,
        method: 'POST',
        header: headers(result.requestId),
        data: { requestId: result.requestId },
        dataType: 'json'
      });
    }
  },

  handlePrimaryAction() {
    if (this.data.phase === 'recording') {
      this.setData({
        state: '考え中…',
        detail: '',
        phase: 'stopping',
        actionLabel: ''
      });
      this.session.finishRecording('user_finished');
    } else if (this.data.phase === 'effect_confirmation') {
      this.confirmPendingEffect();
    } else if (this.data.phase === 'finished' && ALLOW_REPEAT) {
      this.prepareNextQuestion({ startImmediately: true });
    } else if (this.data.phase !== 'stopping' && this.data.phase !== 'sending') {
      this.startRecording();
    }
  },

  clearPendingGlobalHookAction() {
    if (!this.pendingGlobalHookTimer) return;
    clearTimeout(this.pendingGlobalHookTimer);
    this.pendingGlobalHookTimer = null;
  },

  triggerPrimaryActionOnce() {
    const now = Date.now();
    if (now - this.data.lastTriggerAt < INPUT_DEBOUNCE_MS) return;
    this.setData({ lastTriggerAt: now });
    this.handlePrimaryAction();
  },

  onKeyUp(event) {
    if (event.code === 'Backspace') {
      // RV101 maps the standard temple double-tap exit gesture to Backspace.
      // Its firmware emits GlobalHook first, so discard the deferred single-tap action.
      this.clearPendingGlobalHookAction();
      if (this.session && ['recording', 'stopping', 'sending'].includes(this.session.phase)) {
        this.cancel();
      }
      this.cancelPendingEffect();
      this.closeWaitingSession();
      return;
    }
    if (event.code === 'GlobalHook') {
      if (event.preventDefault) event.preventDefault();
      if (this.pendingGlobalHookTimer) return;
      this.pendingGlobalHookTimer = setTimeout(() => {
        this.pendingGlobalHookTimer = null;
        this.triggerPrimaryActionOnce();
      }, DOUBLE_TAP_EXIT_GRACE_MS);
      return;
    }
    if (event.code !== 'Enter') return;
    if (event.preventDefault) event.preventDefault();
    this.clearPendingGlobalHookAction();
    this.triggerPrimaryActionOnce();
  },

  closeWaitingSession() {
    if (!CANCEL_URL || !AUTH_TOKEN || !this.session) return;
    if (this.data.phase === 'confirming_effect') return;
    if (['recording', 'stopping', 'sending'].includes(this.session.phase)) return;
    wx.request({
      url: CANCEL_URL,
      method: 'POST',
      header: { authorization: `Bearer ${AUTH_TOKEN}`, 'content-type': 'application/json' },
      data: { requestId: 'close-idle-session' },
      dataType: 'json'
    });
  },

  onHide() {
    this.clearPendingGlobalHookAction();
    this.cancelPendingEffect();
    this.closeWaitingSession();
    if (this.preflightTask && typeof this.preflightTask.abort === 'function') this.preflightTask.abort();
    this.preflightTask = null;
    if (this.data.phase !== 'idle' && this.data.phase !== 'done') this.cancel();
  }
}
</script>

<page>
  <view class="screen">
    <text class="title">私のAI</text>
    <text class="state">{{ state }}</text>
    <text class="detail">{{ detail }}</text>
    <button wx:if="{{ actionLabel }}" class="action" bindtap="handlePrimaryAction">{{ actionLabel }}</button>
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

.title { font-size: 22px; line-height: 26px; margin-bottom: 18px; }
.state { font-size: 28px; line-height: 32px; margin-bottom: 12px; }
.detail { font-size: 17px; line-height: 22px; margin-bottom: 20px; text-align: left; }
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
