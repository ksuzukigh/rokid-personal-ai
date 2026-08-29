import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AUDIO_LIMITS,
  OneShotAudioSession,
  PcmVoiceActivityDetector,
  VOICE_ACTIVITY_LIMITS,
} from './one-shot-audio.mjs';

const ONE_TURN_LIMITS = Object.freeze({
  ...VOICE_ACTIVITY_LIMITS,
  automaticStopOnSilence: false,
});

test('文中の短い間でも長い考え込みでも自動終了しない', () => {
  const detector = new PcmVoiceActivityDetector({ limits: ONE_TURN_LIMITS });
  processFrames(detector, 23, silenceFrame());
  processFrames(detector, 7, voicedFrame());
  const shortPause = processFrames(detector, 9, silenceFrame());

  assert.equal(shortPause.speechDetected, true);
  assert.equal(shortPause.trailingSilenceMs, 900);
  assert.equal(shortPause.shouldStop, false);

  processFrames(detector, 10, voicedFrame());
  const longPause = processFrames(detector, 100, silenceFrame());
  assert.equal(longPause.trailingSilenceMs, 10000);
  assert.equal(longPause.shouldStop, false);
});

test('利用者の終了操作でだけ録音を確定し、60秒を安全上限にする', () => {
  let scheduledDelay = null;
  let stoppedReason = null;
  const limits = Object.freeze({ ...AUDIO_LIMITS, maxDurationMs: 60000, maxBytes: 1920000 });
  const session = new OneShotAudioSession({
    limits,
    voiceDetector: new PcmVoiceActivityDetector({ limits: ONE_TURN_LIMITS }),
    schedule(_callback, delay) { scheduledDelay = delay; return 1; },
    unschedule() {},
  });
  session.begin({ requestId: 'manual_finish_01', stopRecorder: (reason) => { stoppedReason = reason; } });
  session.appendFrame(voicedFrame());
  processFrames(session.voiceDetector, 30, silenceFrame());
  assert.equal(session.phase, 'recording');
  assert.equal(stoppedReason, null);
  assert.equal(scheduledDelay, 60000);
  assert.equal(session.finishRecording('user_finished'), true);
  assert.equal(session.phase, 'stopping');
  assert.equal(stoppedReason, 'user_finished');
  assert.equal(session.finishRecording('duplicate'), false);
});

test('音声フレームの形式と既存の最大録音上限を維持する', () => {
  assert.equal(AUDIO_LIMITS.sampleRate, 16000);
  assert.equal(AUDIO_LIMITS.channels, 1);
  assert.equal(AUDIO_LIMITS.bytesPerSample, 2);
  const detector = new PcmVoiceActivityDetector();
  assert.equal(detector.process(new Uint8Array(3)).valid, false);
});

function processFrames(detector, count, frame) {
  let result = null;
  for (let index = 0; index < count; index += 1) result = detector.process(frame);
  return result;
}

function silenceFrame() {
  return pcmFrame(0);
}

function voicedFrame() {
  return pcmFrame(1500);
}

function pcmFrame(amplitude, durationMs = 100) {
  const samples = AUDIO_LIMITS.sampleRate * durationMs / 1000;
  const bytes = new Uint8Array(samples * AUDIO_LIMITS.bytesPerSample);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < samples; index += 1) {
    view.setInt16(index * AUDIO_LIMITS.bytesPerSample, amplitude, true);
  }
  return bytes;
}
