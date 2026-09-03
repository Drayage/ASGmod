/** Small WebAudio-based sound effects — no external audio assets to keep the
 * game self-contained. Every effect is a short synthesized tone. */

let audioContext: AudioContext | null = null;
let sfxEnabled = true;

export function setSoundEnabled(value: boolean): void {
  sfxEnabled = value;
}

function getContext(): AudioContext | null {
  if (!audioContext) {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    audioContext = new Ctor();
  }
  if (audioContext.state === "suspended") void audioContext.resume();
  return audioContext;
}

interface ToneStep {
  freq: number;
  duration: number;
  type?: OscillatorType;
  gain?: number;
  delay?: number;
}

function playTones(steps: ToneStep[]): void {
  if (!sfxEnabled) return;
  const ctx = getContext();
  if (!ctx) return;

  let startAt = ctx.currentTime;
  for (const step of steps) {
    startAt += step.delay ?? 0;
    const osc = ctx.createOscillator();
    const gainNode = ctx.createGain();
    osc.type = step.type ?? "sine";
    osc.frequency.setValueAtTime(step.freq, startAt);
    const peak = step.gain ?? 0.15;
    gainNode.gain.setValueAtTime(0.0001, startAt);
    gainNode.gain.exponentialRampToValueAtTime(peak, startAt + 0.02);
    gainNode.gain.exponentialRampToValueAtTime(0.0001, startAt + step.duration);
    osc.connect(gainNode).connect(ctx.destination);
    osc.start(startAt);
    osc.stop(startAt + step.duration + 0.02);
    startAt += step.duration;
  }
}

export function playSelect(): void {
  playTones([{ freq: 480, duration: 0.05, type: "triangle", gain: 0.1 }]);
}

/** 꽃피우기: a soft, quick "bloom". */
export function playClone(): void {
  playTones([
    { freq: 520, duration: 0.07, type: "sine", gain: 0.13 },
    { freq: 660, duration: 0.09, type: "sine", gain: 0.1, delay: -0.03 },
  ]);
}

/** 씨앗 날리기: a quick upward sweep, approximated as two rising tones. */
export function playJump(): void {
  playTones([
    { freq: 340, duration: 0.05, type: "triangle", gain: 0.1 },
    { freq: 620, duration: 0.08, type: "triangle", gain: 0.11 },
  ]);
}

/** 주변 꽃 물들이기: a short cascade, one blip per converted flower — capped
 * so a huge capture doesn't turn into a machine-gun of notes. */
export function playConvert(count: number): void {
  if (count <= 0) return;
  const notes = Math.min(count, 5);
  const steps: ToneStep[] = [];
  for (let i = 0; i < notes; i++) {
    steps.push({ freq: 700 + i * 90, duration: 0.06, type: "sine", gain: 0.09, delay: i === 0 ? 0 : 0.045 });
  }
  playTones(steps);
}

export function playSkipTurn(): void {
  playTones([{ freq: 260, duration: 0.1, type: "sine", gain: 0.07 }]);
}

export function playWin(): void {
  playTones([
    { freq: 523, duration: 0.1, gain: 0.15 },
    { freq: 659, duration: 0.1, gain: 0.15 },
    { freq: 784, duration: 0.22, gain: 0.15 },
  ]);
}

export function playLose(): void {
  playTones([
    { freq: 392, duration: 0.14, type: "sine", gain: 0.12 },
    { freq: 294, duration: 0.22, type: "sine", gain: 0.12 },
  ]);
}

export function playDraw(): void {
  playTones([
    { freq: 440, duration: 0.12, type: "sine", gain: 0.1 },
    { freq: 440, duration: 0.16, type: "sine", gain: 0.1, delay: 0.05 },
  ]);
}

/** Quiet, generative "garden afternoon" loop — a handful of long soft sine
 * pads at low volume, no external audio file. */
const MUSIC_NOTES = [293.66, 349.23, 392.0, 440.0, 523.25]; // D F G A C, pentatonic
const MUSIC_STEP_MS = 2800;
const MUSIC_NOTE_DURATION_S = 3.4;
const MUSIC_PEAK_GAIN = 0.03;

let musicTimer: ReturnType<typeof setInterval> | null = null;
let musicStep = 0;

function playPad(freq: number): void {
  const ctx = getContext();
  if (!ctx) return;
  const start = ctx.currentTime;
  const osc = ctx.createOscillator();
  const gainNode = ctx.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(freq, start);
  gainNode.gain.setValueAtTime(0.0001, start);
  gainNode.gain.exponentialRampToValueAtTime(MUSIC_PEAK_GAIN, start + 1.2);
  gainNode.gain.exponentialRampToValueAtTime(0.0001, start + MUSIC_NOTE_DURATION_S);
  osc.connect(gainNode).connect(ctx.destination);
  osc.start(start);
  osc.stop(start + MUSIC_NOTE_DURATION_S + 0.05);
}

function playNextMusicStep(): void {
  playPad(MUSIC_NOTES[musicStep % MUSIC_NOTES.length]);
  musicStep += 1;
}

export function setMusicEnabled(value: boolean): void {
  if (value && !musicTimer) {
    playNextMusicStep();
    musicTimer = setInterval(playNextMusicStep, MUSIC_STEP_MS);
  } else if (!value && musicTimer) {
    clearInterval(musicTimer);
    musicTimer = null;
  }
}
