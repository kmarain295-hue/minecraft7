'use client';

/**
 * Fantasy dragon health bar HUD — top-left corner of the gameplay view.
 *
 * The frame art (`/hud/health-bar.png`, transparent PNG) holds two inset
 * panels; the fills are overlaid on top of them, geometry measured from the
 * artwork as fractions of its 2172x724 canvas:
 *   - TOP bar   = HEALTH  (red)  — wired to the real vitals: fall damage,
 *     regen after the grace period, death/respawn.
 *   - BOTTOM bar = STAMINA (amber) — unlimited sprint keeps it pinned full,
 *     wired all the same so any future drain shows up instantly.
 *
 * The game loop pushes values every frame through the imperative
 * {@link HealthBarHandle.update} handle — everything is written straight to
 * the DOM (width styles + text), so there are no React re-renders per frame.
 * Extras: white damage flash when health drops, numeric readout, and a
 * pulsing red glow while health is under 25%.
 */

import { forwardRef, useImperativeHandle, useRef } from 'react';

export interface HealthBarHandle {
  /** Push the current vitals; writes directly to the DOM. */
  update(
    health: number,
    maxHealth: number,
    stamina: number,
    maxStamina: number,
    dead: boolean
  ): void;
}

/** Health fraction under which the bar starts pulsing. */
const HEALTH_LOW_AT = 0.25;

/** Matches MAX_HEALTH in page.tsx (flash-detection initial value). */
const MAX_HEALTH_START = 100;

/* Bar insets measured from the frame art (fractions of the image box). */
const HEALTH_BOX = { left: 29.3, top: 42.6, width: 50.9, height: 8.4 };
const STAMINA_BOX = { left: 29.3, top: 61.2, width: 55.6, height: 9.2 };

const boxStyle = (box: typeof HEALTH_BOX) => ({
  left: `${box.left}%`,
  top: `${box.top}%`,
  width: `${box.width}%`,
  height: `${box.height}%`,
});

const HealthBar = forwardRef<HealthBarHandle>(function HealthBar(_props, api) {
  const root = useRef<HTMLDivElement | null>(null);
  const healthFill = useRef<HTMLDivElement | null>(null);
  const staminaFill = useRef<HTMLDivElement | null>(null);
  const healthText = useRef<HTMLSpanElement | null>(null);
  const flash = useRef<HTMLDivElement | null>(null);
  const lastHealth = useRef(MAX_HEALTH_START);
  const lowActive = useRef(false);

  useImperativeHandle(api, () => ({
    update(health, maxHealth, stamina, maxStamina, dead) {
      const hp =
        maxHealth > 0 ? Math.min(1, Math.max(0, health / maxHealth)) : 0;
      const sp =
        maxStamina > 0 ? Math.min(1, Math.max(0, stamina / maxStamina)) : 0;

      if (healthFill.current) {
        healthFill.current.style.width = `${(hp * 100).toFixed(1)}%`;
      }
      if (staminaFill.current) {
        staminaFill.current.style.width = `${(sp * 100).toFixed(1)}%`;
      }
      if (healthText.current) {
        healthText.current.textContent = `${Math.max(0, Math.ceil(health))} / ${maxHealth}`;
      }

      // white flash whenever the health value drops (damage taken)
      if (flash.current && health < lastHealth.current - 0.01) {
        const el = flash.current;
        el.style.transition = 'none';
        el.style.opacity = '0.85';
        requestAnimationFrame(() => {
          el.style.transition = 'opacity 0.45s ease-out';
          el.style.opacity = '0';
        });
      }
      lastHealth.current = health;

      // pulsing red glow while badly hurt (toggled on threshold crossing)
      const low = !dead && hp > 0 && hp < HEALTH_LOW_AT;
      if (low !== lowActive.current) {
        lowActive.current = low;
        root.current?.classList.toggle('rf-hud-low', low);
      }
    },
  }));

  return (
    <div
      ref={root}
      aria-hidden
      className="pointer-events-none absolute left-1 top-1 z-10 select-none"
      style={{
        // slightly under half-size HUD (250px cap halved, then ~10% light trim — user request)
        width: 'clamp(125px, 22.5vw, 225px)',
        containerType: 'inline-size',
      }}
    >
      <style>{`
        @keyframes rfHudPulse {
          0%, 100% { filter: drop-shadow(0 0 3px rgba(255, 40, 20, 0.25)); }
          50% { filter: drop-shadow(0 0 14px rgba(255, 60, 30, 0.85)); }
        }
        .rf-hud-low { animation: rfHudPulse 0.9s ease-in-out infinite; }
      `}</style>

      <div className="relative w-full" style={{ aspectRatio: '2172 / 724' }}>
        {/* dragon medallion frame art */}
        <img
          src="/hud/health-bar.png"
          alt=""
          draggable={false}
          className="absolute inset-0 h-full w-full"
        />

        {/* HEALTH — top inset panel */}
        <div
          className="absolute overflow-hidden rounded-[2px]"
          style={boxStyle(HEALTH_BOX)}
        >
          <div
            ref={healthFill}
            className="h-full"
            style={{
              width: '100%',
              background:
                'linear-gradient(to bottom, #ff8a64 0%, #e02323 22%, #b01010 58%, #6f0707 100%)',
              boxShadow:
                'inset 0 1px 0 rgba(255,255,255,0.35), inset 0 -1px 2px rgba(0,0,0,0.55)',
              transition: 'width 0.22s ease-out',
            }}
          />
        </div>

        {/* damage flash sweep over the health bar */}
        <div
          ref={flash}
          className="absolute rounded-[2px]"
          style={{
            ...boxStyle(HEALTH_BOX),
            opacity: 0,
            background:
              'linear-gradient(to bottom, rgba(255,255,255,0.95), rgba(255,170,150,0.5))',
          }}
        />

        {/* numeric health readout, centred on the red bar */}
        <span
          ref={healthText}
          className="absolute flex items-center justify-center font-black tracking-wider text-red-50"
          style={{
            ...boxStyle(HEALTH_BOX),
            fontSize: '4.2cqw',
            textShadow:
              '0 1px 2px rgba(0,0,0,0.9), 0 0 7px rgba(255,70,40,0.55)',
          }}
        >
          100 / 100
        </span>

        {/* STAMINA — bottom inset panel */}
        <div
          className="absolute overflow-hidden rounded-[2px]"
          style={boxStyle(STAMINA_BOX)}
        >
          <div
            ref={staminaFill}
            className="h-full"
            style={{
              width: '100%',
              background:
                'linear-gradient(to bottom, #ffe08a 0%, #f6b83c 32%, #c07f0d 68%, #7a4a05 100%)',
              boxShadow:
                'inset 0 1px 0 rgba(255,255,255,0.4), inset 0 -1px 2px rgba(0,0,0,0.55)',
              transition: 'width 0.22s ease-out',
            }}
          />
        </div>
      </div>
    </div>
  );
});

export default HealthBar;
