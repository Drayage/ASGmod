/** Small WebAudio-based sound effects — no external audio assets to keep the
 * game self-contained. Every effect is a short synthesized tone. */

let audioContext: AudioContext | null = null;
let enabled = true;

export function setSoundEnabled(value: boolean): void {
  enabled = value;
}

function getContext(): AudioContext | null {
  if (!enabled) return null;
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

export function playPlace(): void {
  playTones([{ freq: 520, duration: 0.06, type: "triangle", gain: 0.12 }]);
}

export function playTerritoryComplete(): void {
  playTones([
    { freq: 660, duration: 0.09, type: "sine", gain: 0.15 },
    { freq: 880, duration: 0.14, type: "sine", gain: 0.15 },
  ]);
}

export function playIllegal(): void {
  playTones([{ freq: 140, duration: 0.12, type: "square", gain: 0.1 }]);
}

export function playPass(): void {
  playTones([
    { freq: 300, duration: 0.12, type: "sine", gain: 0.08 },
    { freq: 220, duration: 0.18, type: "sine", gain: 0.08 },
  ]);
}

export function playCaptureWin(): void {
  playTones([
    { freq: 880, duration: 0.08, type: "sawtooth", gain: 0.14 },
    { freq: 990, duration: 0.08, type: "sawtooth", gain: 0.14 },
    { freq: 1180, duration: 0.2, type: "sawtooth", gain: 0.14 },
  ]);
}

export function playResult(): void {
  playTones([
    { freq: 523, duration: 0.1, gain: 0.15 },
    { freq: 659, duration: 0.1, gain: 0.15 },
    { freq: 784, duration: 0.22, gain: 0.15 },
  ]);
}
