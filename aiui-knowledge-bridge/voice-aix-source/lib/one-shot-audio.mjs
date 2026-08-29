export const AUDIO_LIMITS = Object.freeze({
  sampleRate: 16000,
  channels: 1,
  bytesPerSample: 2,
  maxDurationMs: 10000,
  maxBytes: 320000,
});

export const VOICE_ACTIVITY_LIMITS = Object.freeze({
  minimumRms: 350,
  minimumPeak: 1000,
  minimumSpeechMs: 250,
  minimumRecordingMs: 0,
  automaticStopOnSilence: true,
  trailingSilenceMs: 900,
});

export class PcmVoiceActivityDetector {
  constructor({
    sampleRate = AUDIO_LIMITS.sampleRate,
    limits = VOICE_ACTIVITY_LIMITS,
  } = {}) {
    this.sampleRate = sampleRate;
    this.limits = limits;
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
    const durationMs = samples * 1000 / this.sampleRate;
    const voiced = rms >= this.limits.minimumRms && peak >= this.limits.minimumPeak;
    this.totalDurationMs += durationMs;
    this.frameCount += 1;
    if (voiced) this.voicedDurationMs += durationMs;
    if (rms > this.maxRms) this.maxRms = rms;
    if (peak > this.maxPeak) this.maxPeak = peak;

    if (!this.speechDetected) {
      this.consecutiveSpeechMs = voiced ? this.consecutiveSpeechMs + durationMs : 0;
      if (this.consecutiveSpeechMs >= this.limits.minimumSpeechMs) {
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
      rms,
      peak,
      durationMs,
      voiced,
      speechDetected: this.speechDetected,
      trailingSilenceMs: this.trailingSilenceMs,
      shouldStop: this.limits.automaticStopOnSilence &&
        this.speechDetected &&
        this.totalDurationMs >= this.limits.minimumRecordingMs &&
        this.trailingSilenceMs >= this.limits.trailingSilenceMs,
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
      trailingSilenceMs: Math.round(this.trailingSilenceMs),
    };
  }
}

export class OneShotAudioSession {
  constructor({
    limits = AUDIO_LIMITS,
    voiceDetector = new PcmVoiceActivityDetector({ sampleRate: limits.sampleRate }),
    schedule = setTimeout,
    unschedule = clearTimeout,
  } = {}) {
    this.limits = limits;
    this.schedule = schedule;
    this.unschedule = unschedule;
    this.voiceDetector = voiceDetector;
    this.reset();
  }

  reset() {
    if (this.timer) this.unschedule(this.timer);
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
    if (this.phase !== 'idle' && this.phase !== 'done' && this.phase !== 'cancelled') {
      throw new Error(`cannot begin while ${this.phase}`);
    }
    this.reset();
    this.phase = 'recording';
    this.requestId = requestId;
    this.stopRecorder = stopRecorder;
    this.timer = this.schedule(() => {
      if (this.phase !== 'recording') return;
      this.phase = 'stopping';
      this.stopRecorder?.('time_limit');
    }, this.limits.maxDurationMs);
  }

  appendFrame(frame) {
    if (this.phase !== 'recording') return false;
    const bytes = frame instanceof Uint8Array ? frame : new Uint8Array(frame);
    if (bytes.byteLength === 0 || bytes.byteLength % this.limits.bytesPerSample !== 0) {
      this.cancel('invalid_pcm', { stopRecorder: true });
      return false;
    }
    if (this.totalBytes + bytes.byteLength > this.limits.maxBytes) {
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
      if (this.timer) this.unschedule(this.timer);
      this.timer = null;
      this.phase = 'stopping';
      this.stopRecorder?.('silence_after_speech');
    }
    return true;
  }

  finishRecording(reason = 'user_finished') {
    if (this.phase !== 'recording') return false;
    if (this.timer) this.unschedule(this.timer);
    this.timer = null;
    this.phase = 'stopping';
    this.stopRecorder?.(reason);
    return true;
  }

  recorderStopped(send) {
    if (this.phase !== 'recording' && this.phase !== 'stopping') return null;
    if (this.timer) this.unschedule(this.timer);
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

    const control = send({
      requestId: this.requestId,
      audio,
      sampleRate: this.limits.sampleRate,
      channels: this.limits.channels,
      bytesPerSample: this.limits.bytesPerSample,
    });
    this.abortSend = control?.abort || null;
    return control?.promise || Promise.resolve(control);
  }

  markDone() {
    if (this.phase === 'sending') this.phase = 'done';
    this.abortSend = null;
  }

  cancel(reason = 'user', { stopRecorder = true } = {}) {
    const wasRecording = this.phase === 'recording' || this.phase === 'stopping';
    const wasSending = this.phase === 'sending';
    if (this.timer) this.unschedule(this.timer);
    this.timer = null;
    this.chunks = [];
    this.totalBytes = 0;
    this.phase = 'cancelled';
    if (wasRecording && stopRecorder) this.stopRecorder?.(reason);
    if (wasSending) this.abortSend?.();
    this.abortSend = null;
    return { requestId: this.requestId, wasRecording, wasSending, reason };
  }
}
