/**
 * RATFIRE game audio — Web Audio sound manager.
 *
 * The suite is the user's pick plus their uploaded gun cues:
 *   rain-loop   "Heavy storm rain loop" (mixkit #2400)      /public/sfx/
 *   night-loop  "Wind blowing ambience" (mixkit #2658 WAV)  /public/sfx/
 *              — the NIGHT ambience channel, faded in with the moon
 *   shoot       user-uploaded gun SHOOTING sfx       /public/sfx/shoot.mp3
 *   reload      user-uploaded gun RELOAD sfx         /public/sfx/reload.mp3
 *   jump        user-uploaded ATHLETIC JUMP sfx      /public/sfx/jump.mp3
 *   roar        "Giant monster roar" (mixkit #1972 WAV) — the 5-key emote
 * (the pre-existing /sounds/running-forest.wav footstep loop lives in
 * page.tsx as a plain HTMLAudioElement; the mute toggle covers ALL.)
 *
 * Autoplay-policy-proof architecture: the AudioContext is created LAZILY
 * inside the FIRST user gesture (any click / key press — the F fire key
 * qualifies). A context born during a gesture starts 'running' in every
 * browser — no resume() gamble. The MP3 file data is prefetched at page
 * mount (fetch needs no gesture), so decoding starts the instant the
 * context exists. One-shots fired before the graph is ready only warm the
 * init — the next press plays. A missing file only silences its own cue;
 * audio can never break the game.
 */

export interface GameAudioHandle {
  /** Storm intensity 0..1 — drives the rain loop. */
  setRain(intensity: number): void;
  /** Night factor 0..1 (moon height) — fades the night wind loop in/out. */
  setNight(intensity: number): void;
  /** Ensure the context exists + is running (called from user gestures). */
  resume(): void;
  /** One-shot cues: gun fire per attack clip, gun draw on weapon switch,
   *  the F-key fire cycle (shot -> reload) on every attack press, the
   *  Space-key jump, and the 5-key monster roar. shootThenReload schedules
   *  the reload `reloadDelaySeconds` after the bang so BOTH cues live
   *  inside one attack-clip duration. roar(fitSeconds) trims the long roar
   *  file so it ends exactly with the flip animation. */
  shoot(): void;
  reload(): void;
  jump(): void;
  roar(fitSeconds?: number): void;
  shootThenReload(reloadDelaySeconds?: number): void;
  setMuted(muted: boolean): void;
  isMuted(): boolean;
  /** Debug/verification snapshot (surfaced on window.__sfx). */
  debug(): {
    ctxState: string;
    loaded: string[];
    muted: boolean;
    gains: Record<string, number>;
    oneshots: Record<string, number>;
    resumeError: string | null;
    rainTarget: number;
    nightTarget: number;
    /** Delay (s) scheduled between the last shot and its chained reload. */
    reloadDelay: number;
    /** Portion (s) of the roar file the last 5-press played (fit to flip). */
    roarFit: number;
  };
}

const RAIN_FILE = 'rain-loop.mp3';
const RAIN_GAIN = 0.75;
const NIGHT_FILE = 'night-loop.wav';
const NIGHT_GAIN = 0.38; // lightly reduced per user (was 0.45)
const ONE_SHOTS = {
  shoot: { file: 'shoot.mp3', gain: 0.6 },
  reload: { file: 'reload.mp3', gain: 0.7 },
  jump: { file: 'jump.mp3', gain: 0.55 },
  roar: { file: 'roar.wav', gain: 0.7 },
} as const;

/** Fallback gap between the shot and its follow-up reload cue. page.tsx
 *  overrides this per fire cycle with attackClipDuration * 0.4 (the attack
 *  clip is 0.8s -> 0.32s), which lands the reload's audible clicks (first
 *  ~0.41s of the file) BEFORE the attack animation finishes — both cues
 *  start AND finish inside one shooting animation. */
const DEFAULT_RELOAD_DELAY = 0.4;

const MUTE_PREF_KEY = 'ratfire-muted';

let singleton: GameAudioHandle | null = null;
let creating: Promise<GameAudioHandle> | null = null;

/** Lazily create (once) the game audio manager. Safe to call anywhere. */
export function getGameAudio(): Promise<GameAudioHandle> {
  if (singleton) return Promise.resolve(singleton);
  if (!creating) creating = createGameAudio();
  return creating;
}

async function createGameAudio(): Promise<GameAudioHandle> {
  // ---- prefetch the raw MP3 data right away (fetch needs no gesture) ----
  const prefetch = new Map<string, Promise<ArrayBuffer | null>>();
  const files: Array<[string, string]> = [
    ['rain-loop', RAIN_FILE],
    ['night-loop', NIGHT_FILE],
    ['shoot', ONE_SHOTS.shoot.file],
    ['reload', ONE_SHOTS.reload.file],
    ['jump', ONE_SHOTS.jump.file],
    ['roar', ONE_SHOTS.roar.file],
  ];
  for (const [key, file] of files) {
    prefetch.set(
      key,
      fetch(`/sfx/${file}`)
        .then((res) => (res.ok ? res.arrayBuffer() : null))
        .catch(() => null)
    );
  }

  // ---- live audio graph (built inside the first user gesture) ----
  let ctx: AudioContext | null = null;
  let master: GainNode | null = null;
  let rainGain: GainNode | null = null;
  let nightGain: GainNode | null = null;
  const oneShotBuffers = new Map<string, AudioBuffer>();
  let lastRainTarget = -1;
  let rainTarget = 0;
  let lastNightTarget = -1;
  let nightTarget = 0;
  const oneshotCounts: Record<string, number> = {};
  let resumeError: string | null = null;
  let initPromise: Promise<void> | null = null;

  let muted = false;
  try {
    muted = localStorage.getItem(MUTE_PREF_KEY) === '1';
  } catch {
    /* private mode etc. */
  }

  /** Build the AudioContext + graph. MUST first be called from a gesture —
   *  a context born mid-gesture starts 'running' in every browser. */
  function init(): Promise<void> {
    if (initPromise) return initPromise;
    initPromise = (async () => {
      try {
        const Ctx =
          window.AudioContext ??
          (window as unknown as { webkitAudioContext?: typeof AudioContext })
            .webkitAudioContext;
        const theCtx = new Ctx(); // born running (gesture-driven)
        ctx = theCtx;

        master = theCtx.createGain();
        master.gain.value = muted ? 0 : 1;
        master.connect(theCtx.destination);

        // decode rain (loop) from the prefetched data
        const rainData = await prefetch.get('rain-loop');
        if (rainData) {
          const buf = await theCtx.decodeAudioData(rainData);
          const src = theCtx.createBufferSource();
          src.buffer = buf;
          src.loop = true;
          rainGain = theCtx.createGain();
          rainGain.gain.value = 0;
          src.connect(rainGain).connect(master);
          src.start();
        }

        // decode the night wind (loop) — faded in by the moon, not the storm
        const nightData = await prefetch.get('night-loop');
        if (nightData) {
          const buf = await theCtx.decodeAudioData(nightData);
          const src = theCtx.createBufferSource();
          src.buffer = buf;
          src.loop = true;
          nightGain = theCtx.createGain();
          nightGain.gain.value = 0;
          src.connect(nightGain).connect(master);
          src.start();
        }

        // decode the gun one-shots
        for (const name of Object.keys(ONE_SHOTS) as Array<
          keyof typeof ONE_SHOTS
        >) {
          const data = await prefetch.get(name);
          if (data) {
            oneShotBuffers.set(
              name,
              await theCtx.decodeAudioData(data.slice(0))
            );
          }
        }
      } catch (err) {
        resumeError = err instanceof Error ? err.message : String(err);
      }
    })();
    return initPromise;
  }

  /** Create + schedule one cue at `when` seconds from now (sample-accurate
   *  on real hardware; counted for the debug snapshot). */
  function playOneShot(name: keyof typeof ONE_SHOTS, when = 0): void {
    const buf = oneShotBuffers.get(name);
    if (!ctx || !buf || !master) return;
    oneshotCounts[name] = (oneshotCounts[name] ?? 0) + 1;
    try {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = 1 + (Math.random() - 0.5) * 0.12;
      const gain = ctx.createGain();
      gain.gain.value = ONE_SHOTS[name].gain;
      src.connect(gain).connect(master);
      src.start(ctx.currentTime + when);
      src.onended = () => {
        src.disconnect();
        gain.disconnect();
      };
    } catch {
      /* never let audio throw into the game loop */
    }
  }

  /** Ready-check shared by the cue entry points; warms the init if the
   *  graph is still building (the NEXT press then plays). */
  function graphReady(): boolean {
    const buf = oneShotBuffers.get('shoot');
    if (!ctx || !buf || !master) {
      void init();
      return false;
    }
    if (ctx.state !== 'running') void ctx.resume().catch(() => {});
    return true;
  }

  /** Fire a single one-shot cue. */
  function fire(name: keyof typeof ONE_SHOTS): void {
    if (!graphReady()) return;
    playOneShot(name);
  }

  /** F-key fire cycle (user request): the shooting SFX plays first and the
   *  reload SFX follows within the SAME attack-clip duration — the reload
   *  starts at `reloadDelaySeconds` (page.tsx derives it from the real
   *  attack clip length) so its clicks finish before the animation ends. */
  let lastReloadDelay = DEFAULT_RELOAD_DELAY;
  function shootThenReload(reloadDelaySeconds?: number): void {
    if (!graphReady()) return;
    const delay = Math.max(
      0,
      reloadDelaySeconds ?? DEFAULT_RELOAD_DELAY
    );
    lastReloadDelay = delay;
    playOneShot('shoot');
    if (oneShotBuffers.has('reload')) {
      playOneShot('reload', delay);
    }
  }

  /** 5-key monster roar, TRIMMED to `fitSeconds` (the flip clip's length):
   *  src.start's third arg plays only the first `fit` seconds of the file
   *  and a linear gain ease-out over the last 0.15s makes the cut inaudible
   *  — the roar ends exactly with the animation. Playback rate stays 1.0 so
   *  the fit is exact (no chipmunk speed-up). */
  let lastRoarFit = 0;
  function roar(fitSeconds?: number): void {
    if (!graphReady()) return;
    const buf = oneShotBuffers.get('roar');
    if (!ctx || !buf || !master) return;
    oneshotCounts.roar = (oneshotCounts.roar ?? 0) + 1;
    const fit =
      fitSeconds && fitSeconds > 0.2
        ? Math.min(fitSeconds, buf.duration)
        : buf.duration;
    lastRoarFit = Number(fit.toFixed(3));
    try {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const gain = ctx.createGain();
      const g = ONE_SHOTS.roar.gain;
      const t0 = ctx.currentTime;
      if (fit < buf.duration - 0.05) {
        gain.gain.setValueAtTime(g, t0);
        gain.gain.setValueAtTime(g, t0 + fit - 0.15);
        gain.gain.linearRampToValueAtTime(0.0001, t0 + fit);
      } else {
        gain.gain.value = g;
      }
      src.connect(gain).connect(master);
      src.start(t0, 0, fit);
      src.onended = () => {
        src.disconnect();
        gain.disconnect();
      };
    } catch {
      /* never let audio throw into the game loop */
    }
  }

  // ---- ANY first interaction builds the context (born running) ----
  window.addEventListener('pointerdown', () => void init());
  window.addEventListener('keydown', () => void init());

  singleton = {
    resume() {
      void init();
    },
    setRain(intensity) {
      const target = RAIN_GAIN * Math.min(1, Math.max(0, intensity));
      rainTarget = Number(target.toFixed(3));
      if (!rainGain || Math.abs(lastRainTarget - target) < 0.004) return;
      lastRainTarget = target;
      rainGain.gain.setTargetAtTime(target, ctx!.currentTime, 0.5);
    },
    setNight(intensity) {
      const target = NIGHT_GAIN * Math.min(1, Math.max(0, intensity));
      nightTarget = Number(target.toFixed(3));
      if (!nightGain || Math.abs(lastNightTarget - target) < 0.004) return;
      lastNightTarget = target;
      // slow ~1s ambience fade so dusk/dawn crossfades feel natural
      nightGain.gain.setTargetAtTime(target, ctx!.currentTime, 1.0);
    },
    shoot: () => fire('shoot'),
    reload: () => fire('reload'),
    jump: () => fire('jump'),
    roar: (fitSeconds?: number) => roar(fitSeconds),
    // forward the delay — an argless arrow here would silently drop it
    shootThenReload: (delay?: number) => shootThenReload(delay),
    setMuted(next) {
      muted = next;
      try {
        localStorage.setItem(MUTE_PREF_KEY, next ? '1' : '0');
      } catch {
        /* ignore */
      }
      if (master && ctx) {
        master.gain.setTargetAtTime(next ? 0 : 1, ctx.currentTime, 0.05);
      }
    },
    isMuted: () => muted,
    debug() {
      return {
        ctxState: ctx ? ctx.state : 'uncreated',
        loaded: [
          ...(rainGain ? ['rain-loop'] : []),
          ...(nightGain ? ['night-loop'] : []),
          ...[...oneShotBuffers.keys()],
        ],
        muted,
        gains:
          rainGain && nightGain && ctx
            ? {
                'rain-loop': Number(rainGain.gain.value.toFixed(3)),
                'night-loop': Number(nightGain.gain.value.toFixed(3)),
              }
            : {},
        oneshots: { ...oneshotCounts },
        resumeError,
        rainTarget,
        nightTarget,
        reloadDelay: lastReloadDelay,
        roarFit: lastRoarFit,
      };
    },
  };

  return singleton;
}
