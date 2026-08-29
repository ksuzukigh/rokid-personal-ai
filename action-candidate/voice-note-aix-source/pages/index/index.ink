<script def>
{
  "navigationBarTitleText": "一回音声入力テスト"
}
</script>

<script setup>

const AUDIO_URL = '';
const CANCEL_URL = '';
const CONFIRM_URL = '';
const NOTE_CANCEL_URL = '';
const AUTH_TOKEN = '';
const PREVIEW_CONFIRMATION_TEXT = '';
const TEST_LABEL = '';
const PROMPT_TEXT = '';
const EVALUATION_ONLY = false;
const PREFLIGHT_ONLY = false;
const PROCESSING_PREVIEW_ONLY = false;
const ALLOW_REPEAT = false;
const HEALTH_URL = AUDIO_URL ? AUDIO_URL.replace(/\/v1\/transcribe$/, '/v1/health') : '';
const INPUT_DEBOUNCE_MS = 800;
const ANSWER_REQUEST_TIMEOUT_MS = 630000;
const CONFIRMATION_TIMEOUT_MS = 15000;
const RECORD_ARM_MIN_DELAY_MS = 1500;
const RECORD_ARM_TIMEOUT_MS = 8000;
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

export default {
  data: {
    state: TEST_LABEL || '準備完了',
    detail: PROMPT_TEXT ? `「${PROMPT_TEXT}」` : 'テンプル1回で確認',
    phase: 'idle',
    attemptUsed: false,
    armedAt: 0,
    recognizedText: '',
    actionLabel: '質問する',
    lastTriggerAt: 0
  },

  onLoad() {
    this.session = new OneShotAudioSession();
    this.requestTask = null;
    this.preflightTask = null;
    this.confirmTimer = null;
    this.armTimer = null;
    this.cancelledDuringRecord = false;
    this.noteTicket = null;
    this.documentProposal = null;
    if (PROCESSING_PREVIEW_ONLY) {
      this.recorder = null;
      this.setData({
        state: '質問を受け取りました',
        detail: '文字化して回答を用意しています',
        phase: 'sending',
        attemptUsed: true,
        actionLabel: '処理中'
      });
      return;
    }
    if (PREVIEW_CONFIRMATION_TEXT) {
      this.recorder = null;
      this.setData({ attemptUsed: true });
      this.beginConfirmation(PREVIEW_CONFIRMATION_TEXT);
      return;
    }
    this.recorder = wx.media.getRecorderManager();
    this.bindRecorder();
    if (HEALTH_URL && AUTH_TOKEN) this.preflightConnection();
  },

  async preflightConnection() {
    this.setData({ state: '接続確認中', detail: '録音はまだ始めません', phase: 'checking' });
    const ready = await this.runHealthCheck();
    if (this.data.phase !== 'checking') return;
    if (ready) {
      this.setData({
        state: TEST_LABEL || '準備完了',
        detail: PROMPT_TEXT ? `「${PROMPT_TEXT}」` : 'テンプル1回で確認',
        phase: 'idle',
        actionLabel: '質問する'
      });
    } else {
      this.setData({ state: '接続できません', detail: '録音していません', phase: 'finished' });
    }
  },

  async runHealthCheck() {
    for (let attempt = 1; attempt <= HEALTH_CHECK_ATTEMPTS; attempt += 1) {
      const ready = await this.runSingleHealthCheck();
      if (ready) return true;
      if (this.data.phase !== 'checking') return false;
      if (attempt < HEALTH_CHECK_ATTEMPTS) {
        this.setData({ state: '接続再確認中', detail: '録音はまだ始めません' });
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
      this.setData({ state: '利用できません', detail: '録音機能がありません' });
      return;
    }
    this.recorder.onFrameRecorded((payload) => {
      const frame = payload && payload.frameBuffer;
      if (!frame) return;
      if (!this.session.appendFrame(frame)) {
        if (this.session.phase === 'cancelled') {
          this.cancelledDuringRecord = true;
          this.setData({ state: '録音中止', detail: '上限を超えた音声を破棄しました', phase: 'idle' });
        }
        return;
      }
      this.setData({ detail: `録音中 ${this.session.totalBytes} / ${AUDIO_LIMITS.maxBytes} B` });
    });
    this.recorder.onStop(() => {
      if (this.cancelledDuringRecord) {
        this.cancelledDuringRecord = false;
        return;
      }
      this.setData({
        state: '質問を受け取りました',
        detail: '文字化して回答を用意しています',
        phase: 'sending',
        actionLabel: '処理中'
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
        state: '録音失敗',
        detail: payload && payload.errMsg ? payload.errMsg : '録音できません',
        phase: 'idle'
      });
    });
  },

  async startRecording() {
    if (!this.recorder || !['idle', 'done', 'armed'].includes(this.data.phase)) return;
    if (this.data.attemptUsed) {
      this.setData({ state: '終了しました', detail: '録音は1回だけです', phase: 'finished', actionLabel: '終了' });
      return;
    }
    if (!AUDIO_URL || !AUTH_TOKEN) {
      this.setData({ state: '接続先未設定', detail: '音声は録音・送信していません' });
      return;
    }
    if (!PREFLIGHT_ONLY) {
      if (this.data.phase !== 'armed') {
        this.armRecording();
        return;
      }
      if (Date.now() - this.data.armedAt < RECORD_ARM_MIN_DELAY_MS) {
        this.setData({ state: '録音確認', detail: '少し待って、もう1回で開始', phase: 'armed' });
        return;
      }
      if (this.armTimer) clearTimeout(this.armTimer);
      this.armTimer = null;
      this.setData({ armedAt: 0, phase: 'idle' });
    }
    this.setData({ state: '接続再確認中', detail: '録音はまだ始めません', phase: 'checking' });
    const reachable = await this.runHealthCheck();
    if (this.data.phase !== 'checking') return;
    if (!reachable) {
      this.setData({ state: '接続できません', detail: '録音していません', phase: 'finished' });
      return;
    }
    if (PREFLIGHT_ONLY) {
      this.setData({ state: '接続再確認成功', detail: '録音していません', phase: 'finished' });
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
          state: '質問を受け取りました',
          detail: reason === 'time_limit' ? '60秒で録音を終了・回答を用意しています' : '録音を終了・回答を用意しています',
          phase: 'stopping',
          actionLabel: '処理中'
        });
        this.recorder.stop().catch(() => {});
      }
    });
    this.setData({
      state: '録音中',
      detail: `話し終えたらテンプル1回・最長${AUDIO_LIMITS.maxDurationMs / 1000}秒`,
      phase: 'recording',
      actionLabel: '話し終えた'
    });
    try {
      await this.recorder.start({ sampleRate: 16000, numberOfChannels: 1, format: 'pcm' });
    } catch (error) {
      this.session.cancel('start_failed', { stopRecorder: false });
      this.setData({ state: '録音失敗', detail: String(error), phase: 'idle' });
    }
  },

  prepareNextQuestion() {
    if (!ALLOW_REPEAT || this.data.phase !== 'finished') return;
    if (this.confirmTimer) clearTimeout(this.confirmTimer);
    this.confirmTimer = null;
    if (this.armTimer) clearTimeout(this.armTimer);
    this.armTimer = null;
    this.noteTicket = null;
    this.documentProposal = null;
    this.session.reset();
    this.setData({
      state: TEST_LABEL || '準備完了',
      detail: '直前の内容を必要なときだけ引き継げます',
      phase: 'idle',
      attemptUsed: false,
      actionLabel: '質問する',
      armedAt: 0,
      recognizedText: ''
    });
  },

  armRecording() {
    if (this.armTimer) clearTimeout(this.armTimer);
    const armedAt = Date.now();
    this.setData({
      state: '録音しますか？',
      detail: '1.5秒後にもう1回で開始・8秒で取消',
      phase: 'armed',
      actionLabel: '録音開始',
      armedAt
    });
    this.armTimer = setTimeout(() => {
      this.armTimer = null;
      if (this.data.phase !== 'armed' || this.data.armedAt !== armedAt) return;
      this.setData({
        state: TEST_LABEL || '準備完了',
        detail: PROMPT_TEXT ? `「${PROMPT_TEXT}」` : 'テンプル1回で確認',
        phase: 'idle',
        actionLabel: '質問する',
        armedAt: 0
      });
    }, RECORD_ARM_TIMEOUT_MS);
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
          if (body.text && ['create_new_document', 'append_document', 'replace_document_text', 'save_document_to_google_drive'].includes(body.operation) &&
              body.requestHandledAs === 'free_conversation_turn' &&
              typeof body.usedPreviousTurn === 'boolean' && body.conversationRecorded === true &&
              body.changed === false && body.ephemeral === true &&
              body.documentProposal && typeof body.documentProposal.title === 'string' &&
              typeof body.documentProposal.preview === 'string' &&
              ((body.operation === 'create_new_document' && !body.documentProposal.action) ||
                (body.operation === 'append_document' && body.documentProposal.action === 'append') ||
                (body.operation === 'replace_document_text' && body.documentProposal.action === 'replace_text') ||
                (body.operation === 'save_document_to_google_drive' &&
                  body.documentProposal.action === 'save_to_google_docs')) &&
              ((body.operation === 'save_document_to_google_drive' &&
                body.documentProposal.targetHint === 'Google DriveのRokid/私のAI 保存文書(Googleドキュメント)') ||
                (['create_new_document', 'append_document'].includes(body.operation) &&
                  body.documentProposal.targetHint === '私のAI 作成文書') ||
                (body.operation === 'replace_document_text' &&
                  typeof body.documentProposal.targetHint === 'string' &&
                  body.documentProposal.targetHint.endsWith('.md') &&
                  !body.documentProposal.targetHint.startsWith('/') &&
                  !body.documentProposal.targetHint.includes('..'))) &&
              body.ticketId && body.candidateId && body.confirmationToken) {
            this.noteTicket = {
              ticketId: body.ticketId,
              candidateId: body.candidateId,
              confirmationToken: body.confirmationToken
            };
            this.documentProposal = body.documentProposal;
            this.beginConfirmation(body.text);
          } else if (body.text && body.ticketId && body.candidateId && body.confirmationToken) {
            this.noteTicket = {
              ticketId: body.ticketId,
              candidateId: body.candidateId,
              confirmationToken: body.confirmationToken
            };
            this.beginConfirmation(body.text);
          } else if (body.text && EVALUATION_ONLY) this.beginConfirmation(body.text);
          else this.setData({
            state: '回答を用意できませんでした',
            detail: '録音は受け取りました・何も変更していません',
            phase: 'finished',
            actionLabel: ALLOW_REPEAT ? '続けて質問' : '終了'
          });
          resolvePromise();
        } else {
          this.setData({
            state: '回答を用意できませんでした',
            detail: '録音は受け取りました・何も変更していません',
            phase: 'finished',
            actionLabel: ALLOW_REPEAT ? '続けて質問' : '終了'
          });
          rejectPromise(new Error('invalid response'));
        }
      },
      fail: (error) => {
        if (this.session.phase !== 'sending') return;
        this.setData({
          state: '回答を用意できませんでした',
          detail: '通信または回答処理が完了しませんでした',
          phase: 'finished',
          actionLabel: ALLOW_REPEAT ? '続けて質問' : '終了'
        });
        rejectPromise(new Error('request failed'));
      },
      complete: () => { this.requestTask = null; }
    });
    this.requestTask = task;
    return { promise, abort: () => task.abort() };
  },

  beginConfirmation(text) {
    if (this.confirmTimer) clearTimeout(this.confirmTimer);
    const document = this.documentProposal;
    const appending = document && document.action === 'append';
    const editing = document && document.action === 'replace_text';
    const savingToDrive = document && document.action === 'save_to_google_docs';
    this.setData({
      state: document
        ? (appending ? '追記内容を確認' : editing ? '変更内容を確認' : savingToDrive ? 'Google Docs保存を確認' : '新規文書を確認')
        : '確認してください',
      detail: document
        ? `「${document.title}」\n${document.preview}\n${appending ? '追記先' : editing ? '変更先' : '保存先'}: ${document.targetHint}`
        : (EVALUATION_ONLY ? `私：${text}\n\nAI：操作は不要です` : `私：${text}\n\nこの原文でよければ1回`),
      recognizedText: text,
      phase: 'confirming',
      actionLabel: document ? (appending ? '追記する' : editing ? '変更する' : savingToDrive ? 'Google Docsへ保存' : '保存する') : '確認する'
    });
    this.confirmTimer = setTimeout(() => {
      this.confirmTimer = null;
      if (this.data.phase !== 'confirming') return;
      if (NOTE_CANCEL_URL && this.noteTicket) {
        wx.request({
          url: NOTE_CANCEL_URL,
          method: 'POST',
          header: { authorization: `Bearer ${AUTH_TOKEN}`, 'content-type': 'application/json' },
          data: this.noteTicket,
          dataType: 'json'
        });
      }
      this.noteTicket = null;
      this.documentProposal = null;
      this.setData({
        state: '取り消しました', detail: '何も実行していません', phase: 'finished',
        actionLabel: ALLOW_REPEAT ? '続けて質問' : '終了'
      });
    }, CONFIRMATION_TIMEOUT_MS);
  },

  confirmResult() {
    if (this.data.phase !== 'confirming') return;
    if (this.confirmTimer) clearTimeout(this.confirmTimer);
    this.confirmTimer = null;
    if (!CONFIRM_URL || !this.noteTicket) {
      this.setData({ state: '確認しました', detail: 'まだ何も実行していません', phase: 'finished' });
      return;
    }
    const appending = this.documentProposal && this.documentProposal.action === 'append';
    const editing = this.documentProposal && this.documentProposal.action === 'replace_text';
    const savingToDrive = this.documentProposal && this.documentProposal.action === 'save_to_google_docs';
    this.setData({
      state: appending ? '追記中' : editing ? '変更中' : savingToDrive ? 'Google Docsへ保存中' : '保存中',
      detail: 'Macへ確認を送っています',
      phase: 'saving'
    });
    wx.request({
      url: CONFIRM_URL,
      method: 'POST',
      header: { authorization: `Bearer ${AUTH_TOKEN}`, 'content-type': 'application/json' },
      data: this.noteTicket,
      dataType: 'json',
      success: (response) => {
        const body = response.data || {};
        if (response.statusCode >= 200 && response.statusCode < 300 && body.ok === true && body.applied === true) {
          this.setData({
            state: '完了',
            detail: `AI：${body.text || this.data.recognizedText}`,
            phase: 'finished',
            actionLabel: ALLOW_REPEAT ? '続けて質問' : '終了'
          });
        } else {
          this.setData({
            state: ['already_exists', 'not_found', 'document_changed', 'match_changed'].includes(body.reason)
              ? (appending ? '追記していません' : editing ? '変更していません' : '保存していません')
              : (appending ? '追記できませんでした' : editing ? '変更できませんでした' : '保存できませんでした'),
            detail: body.text || (appending ? '既存文書への追記を確認できません' : editing ? '既存文書の変更を確認できません' : '新規文書の作成を確認できません'),
            phase: 'finished',
            actionLabel: ALLOW_REPEAT ? '続けて質問' : '終了'
          });
        }
        this.noteTicket = null;
        this.documentProposal = null;
      },
      fail: () => {
        this.noteTicket = null;
        this.documentProposal = null;
        this.setData({
          state: appending ? '追記できませんでした' : editing ? '変更できませんでした' : '保存できませんでした',
          detail: 'Macへ確認を送れません',
          phase: 'finished',
          actionLabel: ALLOW_REPEAT ? '続けて質問' : '終了'
        });
      }
    });
  },

  cancel() {
    if (this.armTimer) clearTimeout(this.armTimer);
    this.armTimer = null;
    if (this.confirmTimer) clearTimeout(this.confirmTimer);
    this.confirmTimer = null;
    if (this.data.phase === 'confirming' && NOTE_CANCEL_URL && this.noteTicket) {
      wx.request({
        url: NOTE_CANCEL_URL,
        method: 'POST',
        header: { authorization: `Bearer ${AUTH_TOKEN}`, 'content-type': 'application/json' },
        data: this.noteTicket,
        dataType: 'json'
      });
      this.noteTicket = null;
      this.documentProposal = null;
      this.setData({
        state: '取り消しました', detail: 'Obsidianへ保存していません',
        phase: 'finished', armedAt: 0, actionLabel: ALLOW_REPEAT ? '続けて質問' : '終了'
      });
      return;
    }
    const result = this.session.cancel('user');
    if (result.wasRecording) this.cancelledDuringRecord = true;
    this.setData({ state: '取り消しました', detail: '音声を破棄しました', phase: 'idle', armedAt: 0 });
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
    if (this.data.phase === 'confirming') {
      this.confirmResult();
    } else if (this.data.phase === 'recording') {
      this.setData({
        state: '質問を受け取りました',
        detail: '録音を終了・回答を用意しています',
        phase: 'stopping',
        actionLabel: '処理中'
      });
      this.session.finishRecording('user_finished');
    } else if (this.data.phase === 'finished' && ALLOW_REPEAT) {
      this.prepareNextQuestion();
    } else if (this.data.phase !== 'stopping' && this.data.phase !== 'sending') {
      this.startRecording();
    }
  },

  onKeyUp(event) {
    if (event.code === 'Backspace') {
      // RV101 maps the standard temple double-tap exit gesture to Backspace.
      // Do not consume it: notify the idle relay, then let YodaOS close the AIX.
      this.closeWaitingSession();
      return;
    }
    if (event.code !== 'Enter' && event.code !== 'GlobalHook') return;
    if (event.preventDefault) event.preventDefault();
    const now = Date.now();
    if (now - this.data.lastTriggerAt < INPUT_DEBOUNCE_MS) return;
    this.setData({ lastTriggerAt: now });
    this.handlePrimaryAction();
  },

  closeWaitingSession() {
    if (!CANCEL_URL || !AUTH_TOKEN || !this.session) return;
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
    this.closeWaitingSession();
    if (this.preflightTask && typeof this.preflightTask.abort === 'function') this.preflightTask.abort();
    this.preflightTask = null;
    if (this.confirmTimer) clearTimeout(this.confirmTimer);
    this.confirmTimer = null;
    if (this.armTimer) clearTimeout(this.armTimer);
    this.armTimer = null;
    if (this.data.phase !== 'idle' && this.data.phase !== 'done') this.cancel();
  }
}
</script>

<page>
  <view class="screen">
    <text class="title">一回音声入力テスト</text>
    <text class="state">{{ state }}</text>
    <text class="detail">{{ detail }}</text>
    <button class="action" bindtap="handlePrimaryAction">{{ actionLabel }}</button>
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
.detail { font-size: 18px; line-height: 22px; margin-bottom: 20px; }
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
