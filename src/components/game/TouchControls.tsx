'use client';

/**
 * Mobile touch controls for the RATFIRE third-person view.
 *
 * Rendered ONLY while the game is playing on a touch device (detection lives
 * in page.tsx — `?touch=1` force-overrides it for desktop testing):
 *
 *   - Virtual joystick (bottom-left): analog forward/back + left/right turn.
 *   - FIRE (hold): loops the attack clip with the shot + reload sound cycle.
 *   - JUMP: one tap, one jump.
 *   - ROAR: flip emote + the monster roar (same as the keyboard 5 key).
 *   - RUN: sprint toggle — pushes past walk speed while ON.
 *   - WEAPON / SKIN: cycle the loadout exactly like the X / Q / E keys.
 *   - HOME: back to the lobby (same as the keyboard Esc key).
 *
 * Every control talks to the game loop through the imperative TouchGameApi
 * ref, so no React re-render ever happens mid-frame. All controls use
 * pointer events with `touch-action: none` — multi-touch friendly (one
 * finger drives the stick while another fires) and immune to browser
 * scroll/zoom gestures and the 300ms click delay.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ChevronsUp,
  Crosshair,
  FastForward,
  Home,
  Move,
  Shirt,
  Sparkles,
  Swords,
  type LucideIcon,
} from 'lucide-react';

/** Imperative bridge into the game loop (assigned in page.tsx). */
export interface TouchGameApi {
  /** Joystick vector: x -1(left)..1(right), y -1(back)..1(forward). */
  move(x: number, y: number): void;
  /** Joystick released — stop moving. */
  moveEnd(): void;
  /** FIRE pressed (starts the looping attack clip + sound cycle). */
  fireDown(): void;
  /** FIRE released. */
  fireUp(): void;
  jump(): void;
  /** Flip emote + monster roar (trimmed to the animation's length). */
  roar(): void;
  /** Sprint toggle (RUN button). */
  setRun(on: boolean): void;
  /** Cycle to the next weapon loadout (same as the keyboard X key). */
  cycleWeapon(): void;
  /** dir: -1 previous skin, 1 next skin (same as the Q / E keys). */
  cycleSkin(dir: number): void;
  /** Back to the lobby showcase (same as the keyboard Esc key). */
  exitToLobby(): void;
}

interface TouchControlsProps {
  apiRef: React.RefObject<TouchGameApi | null>;
}

/** Joystick deadzone fraction — inside this the stick reads as idle. */
const JOY_DEADZONE = 0.16;
/** Knob travel radius in px (base 144px minus half knob 64px). */
const JOY_RADIUS = 40;
/** iOS home-bar clearance baked into every bottom-anchored control. */
const SAFE_B = 'env(safe-area-inset-bottom, 0px)';
/** Notch / status-bar clearance for top-anchored controls (the game canvas
 *  runs under both when the viewport `cover` insets are exposed). */
const SAFE_T = 'env(safe-area-inset-top, 0px)';

/** One round icon button with an optional micro-label under the icon. */
function RoundButton({
  icon: Icon,
  label,
  size,
  onDown,
  onUp,
  onLostCapture,
  active = false,
  danger = false,
  className = '',
  style,
  iconClass,
}: {
  icon: LucideIcon;
  label: string;
  size: number;
  onDown?: (event: React.PointerEvent<HTMLButtonElement>) => void;
  onUp?: (event: React.PointerEvent<HTMLButtonElement>) => void;
  onLostCapture?: (event: React.PointerEvent<HTMLButtonElement>) => void;
  active?: boolean;
  danger?: boolean;
  className?: string;
  style?: React.CSSProperties;
  iconClass?: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active || undefined}
      onPointerDown={onDown}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onLostPointerCapture={onLostCapture}
      onContextMenu={(event) => event.preventDefault()}
      style={{ width: size, height: size, touchAction: 'none', ...style }}
      className={`pointer-events-auto absolute flex select-none flex-col items-center justify-center gap-0.5 rounded-full border backdrop-blur-md transition-transform duration-100 active:scale-90 ${
        active
          ? 'border-amber-300/90 bg-amber-400/25 text-amber-200 shadow-[0_0_18px_-4px_rgba(251,191,36,0.85)]'
          : danger
            ? 'border-red-400/45 bg-zinc-950/60 text-red-300'
            : 'border-zinc-400/35 bg-zinc-950/60 text-zinc-100'
      } ${className}`}
    >
      <Icon className={iconClass ?? 'h-6 w-6'} aria-hidden />
      <span className="text-[8px] font-black uppercase leading-none tracking-[0.14em] opacity-75">
        {label}
      </span>
    </button>
  );
}

export default function TouchControls({ apiRef }: TouchControlsProps) {
  const [knob, setKnob] = useState({ x: 0, y: 0 });
  const [joyActive, setJoyActive] = useState(false);
  const [sprint, setSprint] = useState(false);
  const joyPointer = useRef<number | null>(null);
  const firePointer = useRef<number | null>(null);
  const joyBase = useRef<HTMLDivElement | null>(null);

  // Safety net: if the HUD unmounts mid-press (death, Esc-to-lobby), never
  // leave the game loop thinking fire/joystick are still held.
  useEffect(() => {
    return () => {
      apiRef.current?.moveEnd();
      apiRef.current?.fireUp();
    };
  }, [apiRef]);

  /** Recompute the stick vector from the active pointer position. */
  const joyUpdate = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const base = joyBase.current;
      if (!base) return;
      const rect = base.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      let dx = (event.clientX - cx) / JOY_RADIUS;
      let dy = (event.clientY - cy) / JOY_RADIUS;
      const len = Math.hypot(dx, dy);
      if (len > 1) {
        dx /= len;
        dy /= len;
      }
      setKnob({ x: dx * JOY_RADIUS, y: dy * JOY_RADIUS });
      if (Math.hypot(dx, dy) < JOY_DEADZONE) {
        apiRef.current?.move(0, 0);
        return;
      }
      // screen up = forward, so the game gets the inverted y
      apiRef.current?.move(dx, -dy);
    },
    [apiRef]
  );

  const joyDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (joyPointer.current !== null) return;
    event.preventDefault();
    joyPointer.current = event.pointerId;
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // capture is best-effort; the stick still tracks while pressed
    }
    setJoyActive(true);
    joyUpdate(event);
  };

  const joyUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (joyPointer.current !== event.pointerId) return;
    joyPointer.current = null;
    setJoyActive(false);
    setKnob({ x: 0, y: 0 });
    apiRef.current?.moveEnd();
  };

  /** Shared press hygiene for instant-response tap buttons. */
  const pressCapture = (event: React.PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // ignore — the tap already landed
    }
  };

  const jumpDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    pressCapture(event);
    apiRef.current?.jump();
  };

  const roarDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    pressCapture(event);
    apiRef.current?.roar();
  };

  const weaponDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    pressCapture(event);
    apiRef.current?.cycleWeapon();
  };

  const skinDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    pressCapture(event);
    apiRef.current?.cycleSkin(1);
  };

  const lobbyDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    pressCapture(event);
    apiRef.current?.exitToLobby();
  };

  const fireDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    if (firePointer.current !== null) return;
    firePointer.current = event.pointerId;
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // ignore
    }
    apiRef.current?.fireDown();
  };

  const fireUp = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (
      firePointer.current !== null &&
      event.pointerId !== firePointer.current
    ) {
      return;
    }
    firePointer.current = null;
    apiRef.current?.fireUp();
  };

  const toggleRun = (event: React.PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    setSprint((current) => {
      const next = !current;
      apiRef.current?.setRun(next);
      return next;
    });
  };

  return (
    <div
      className="pointer-events-none absolute inset-0 z-20 select-none"
      aria-label="Touch controls"
    >
      {/* ============ virtual joystick (bottom-left) ============ */}
      <div
        ref={joyBase}
        role="group"
        aria-label="Movement joystick — drag to walk and turn"
        onPointerDown={joyDown}
        onPointerMove={(event) => {
          if (joyPointer.current === event.pointerId) joyUpdate(event);
        }}
        onPointerUp={joyUp}
        onPointerCancel={joyUp}
        onContextMenu={(event) => event.preventDefault()}
        style={{
          touchAction: 'none',
          left: '1rem',
          bottom: `calc(1.4rem + ${SAFE_B})`,
        }}
        className={`pointer-events-auto absolute flex h-36 w-36 items-center justify-center rounded-full border backdrop-blur-sm transition-colors ${
          joyActive
            ? 'border-amber-300/60 bg-zinc-950/45'
            : 'border-zinc-400/25 bg-zinc-950/35'
        }`}
      >
        {/* travel ring */}
        <div className="absolute inset-3 rounded-full border border-dashed border-white/10" />
        {/* knob */}
        <div
          className="absolute left-1/2 top-1/2 flex h-16 w-16 items-center justify-center rounded-full border border-white/25 bg-gradient-to-b from-zinc-100/90 to-zinc-400/80 shadow-[0_4px_14px_-4px_rgba(0,0,0,0.8)]"
          style={{
            transform: `translate(calc(-50% + ${knob.x}px), calc(-50% + ${knob.y}px))`,
          }}
        >
          <Move className="h-6 w-6 text-zinc-700" aria-hidden />
        </div>
      </div>

      {/* ============ left column: sprint toggle above the stick ============ */}
      <RoundButton
        icon={FastForward}
        label="Run"
        size={56}
        iconClass="h-6 w-6"
        active={sprint}
        onDown={toggleRun}
        style={{
          left: '1.6rem',
          bottom: `calc(11rem + ${SAFE_B})`,
        }}
      />

      {/* ============ right cluster: fire / jump / roar ============ */}
      <RoundButton
        icon={Crosshair}
        label="Fire"
        size={76}
        iconClass="h-8 w-8"
        danger
        onDown={fireDown}
        onUp={fireUp}
        onLostCapture={fireUp}
        style={{
          right: '1rem',
          bottom: `calc(1.4rem + ${SAFE_B})`,
        }}
      />
      <RoundButton
        icon={ChevronsUp}
        label="Jump"
        size={64}
        iconClass="h-7 w-7"
        onDown={jumpDown}
        style={{
          right: '6.75rem',
          bottom: `calc(1.8rem + ${SAFE_B})`,
        }}
      />
      <RoundButton
        icon={Sparkles}
        label="Roar"
        size={58}
        onDown={roarDown}
        style={{
          right: '1.4rem',
          bottom: `calc(8.6rem + ${SAFE_B})`,
        }}
      />

      {/* ============ loadout cycling above the fire cluster ============ */}
      <RoundButton
        icon={Swords}
        label="Weap"
        size={48}
        iconClass="h-5 w-5"
        onDown={weaponDown}
        style={{
          right: '7.25rem',
          bottom: `calc(9rem + ${SAFE_B})`,
        }}
      />
      <RoundButton
        icon={Shirt}
        label="Skin"
        size={48}
        iconClass="h-5 w-5"
        onDown={skinDown}
        style={{
          right: '1.4rem',
          bottom: `calc(13.4rem + ${SAFE_B})`,
        }}
      />

      {/* ============ top-centre: back to the lobby ============ */}
      <RoundButton
        icon={Home}
        label="Lobby"
        size={44}
        iconClass="h-5 w-5"
        onDown={lobbyDown}
        className="left-1/2 -translate-x-1/2"
        style={{ top: `calc(0.625rem + ${SAFE_T})` }}
      />
    </div>
  );
}
