/**
 * Sound effects: procedural Web Audio synthesis by default, with optional
 * user-uploaded audio that plays in place of any of the five SFX slots and
 * a looping music track.
 */

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let muted = false;

// ─── Custom (uploaded) sound overrides ──────────────────────────────────────

type SoundSlot = 'takeoff' | 'cashout' | 'crash' | 'bet' | 'tick';

interface CustomSounds {
  takeoff?: string | null;
  cashout?: string | null;
  crash?:   string | null;
  bet?:     string | null;
  tick?:    string | null;
  music?:   string | null;
}

const customAudio: Record<SoundSlot, HTMLAudioElement | null> = {
  takeoff: null, cashout: null, crash: null, bet: null, tick: null,
};
let musicEl: HTMLAudioElement | null = null;
let musicSrc: string | null = null;

function setCustomSlot(slot: SoundSlot, src: string | null | undefined) {
  if (!src) { customAudio[slot] = null; return; }
  const a = new Audio(src);
  a.preload = 'auto';
  customAudio[slot] = a;
}

/** Wire uploaded sounds. Call when a theme is loaded or replaced. */
export function applyThemeSounds(sounds: CustomSounds | undefined) {
  setCustomSlot('takeoff', sounds?.takeoff);
  setCustomSlot('cashout', sounds?.cashout);
  setCustomSlot('crash',   sounds?.crash);
  setCustomSlot('bet',     sounds?.bet);
  setCustomSlot('tick',    sounds?.tick);

  // Music — replace if changed
  if (sounds?.music !== musicSrc) {
    stopMusic();
    musicSrc = sounds?.music ?? null;
    if (musicSrc) {
      musicEl = new Audio(musicSrc);
      musicEl.loop = true;
      musicEl.volume = muted ? 0 : 0.25;
      // Try to start now; browsers may require user gesture
      musicEl.play().catch(() => { /* will retry on next user gesture */ });
    }
  }
}

function playCustom(slot: SoundSlot): boolean {
  const a = customAudio[slot];
  if (!a) return false;
  try {
    // Clone so rapid overlapping plays don't cut each other off
    const clone = a.cloneNode(true) as HTMLAudioElement;
    clone.volume = muted ? 0 : 0.7;
    clone.play().catch(() => {});
    return true;
  } catch { return false; }
}

export function startMusic() {
  if (!musicEl) return;
  musicEl.volume = muted ? 0 : 0.25;
  musicEl.play().catch(() => {});
}

export function stopMusic() {
  if (musicEl) {
    try { musicEl.pause(); } catch { /* ignore */ }
    musicEl = null;
  }
}

interface Audio {
  ctx: AudioContext;
  master: GainNode;
  now: number;
}

function ensure(): Audio | null {
  if (typeof window === 'undefined') return null;
  if (!ctx || !master) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const AC = (window as any).AudioContext || (window as any).webkitAudioContext;
      if (!AC) return null;
      const c: AudioContext = new AC();
      const m = c.createGain();
      m.gain.value = 0.35;
      m.connect(c.destination);
      ctx = c;
      master = m;
    } catch {
      return null;
    }
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return { ctx, master, now: ctx.currentTime };
}

export function setMuted(m: boolean) {
  muted = m;
  if (master) master.gain.value = m ? 0 : 0.35;
  if (musicEl) musicEl.volume = m ? 0 : 0.25;
}

export function isMuted() {
  return muted;
}

export function uiTick() {
  if (playCustom('tick')) return;
  const a = ensure();
  if (!a) return;
  const { ctx: c, master: out, now } = a;
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = 'square';
  o.frequency.value = 1200;
  o.connect(g);
  g.connect(out);
  g.gain.setValueAtTime(0, now);
  g.gain.linearRampToValueAtTime(0.18, now + 0.002);
  g.gain.exponentialRampToValueAtTime(0.001, now + 0.05);
  o.start(now);
  o.stop(now + 0.06);
}

export function placeBet() {
  if (playCustom('bet')) return;
  const a = ensure();
  if (!a) return;
  const { ctx: c, master: out, now } = a;
  for (const [f, t] of [[440, 0], [660, 0.06]] as [number, number][]) {
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = 'sine';
    o.frequency.value = f;
    o.connect(g);
    g.connect(out);
    const start = now + t;
    g.gain.setValueAtTime(0, start);
    g.gain.linearRampToValueAtTime(0.28, start + 0.005);
    g.gain.exponentialRampToValueAtTime(0.001, start + 0.15);
    o.start(start);
    o.stop(start + 0.15);
  }
}

export function cashoutChime() {
  if (playCustom('cashout')) return;
  const a = ensure();
  if (!a) return;
  const { ctx: c, master: out, now } = a;
  const freqs = [523.25, 659.25, 783.99, 1046.5];
  freqs.forEach((f, i) => {
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = 'triangle';
    o.frequency.value = f;
    o.connect(g);
    g.connect(out);
    const t = now + i * 0.05;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.32, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
    o.start(t);
    o.stop(t + 0.25);
  });
}

export function takeoffWhoosh() {
  if (playCustom('takeoff')) return;
  const a = ensure();
  if (!a) return;
  const { ctx: c, master: out, now } = a;
  const buffer = c.createBuffer(1, Math.floor(c.sampleRate * 0.5), c.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
  const src = c.createBufferSource();
  src.buffer = buffer;
  const filt = c.createBiquadFilter();
  filt.type = 'bandpass';
  filt.frequency.setValueAtTime(300, now);
  filt.frequency.exponentialRampToValueAtTime(3000, now + 0.45);
  filt.Q.value = 6;
  const g = c.createGain();
  g.gain.setValueAtTime(0, now);
  g.gain.linearRampToValueAtTime(0.45, now + 0.05);
  g.gain.exponentialRampToValueAtTime(0.001, now + 0.5);
  src.connect(filt);
  filt.connect(g);
  g.connect(out);
  src.start(now);
  src.stop(now + 0.5);
}

export function crashBoom() {
  if (playCustom('crash')) return;
  const a = ensure();
  if (!a) return;
  const { ctx: c, master: out, now } = a;
  const buffer = c.createBuffer(1, Math.floor(c.sampleRate * 0.7), c.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) {
    const decay = Math.exp(-i / (c.sampleRate * 0.18));
    data[i] = (Math.random() * 2 - 1) * decay;
  }
  const src = c.createBufferSource();
  src.buffer = buffer;
  const filt = c.createBiquadFilter();
  filt.type = 'lowpass';
  filt.frequency.setValueAtTime(800, now);
  filt.frequency.exponentialRampToValueAtTime(100, now + 0.5);
  const g = c.createGain();
  g.gain.setValueAtTime(0.55, now);
  g.gain.exponentialRampToValueAtTime(0.001, now + 0.7);
  src.connect(filt);
  filt.connect(g);
  g.connect(out);
  src.start(now);
  src.stop(now + 0.7);

  const o = c.createOscillator();
  const og = c.createGain();
  o.type = 'sine';
  o.frequency.setValueAtTime(120, now);
  o.frequency.exponentialRampToValueAtTime(40, now + 0.4);
  og.gain.setValueAtTime(0.4, now);
  og.gain.exponentialRampToValueAtTime(0.001, now + 0.45);
  o.connect(og);
  og.connect(out);
  o.start(now);
  o.stop(now + 0.5);
}
