/**
 * Rain shower for the RATFIRE sky — a uniform rain field covering the whole
 * terrain PLUS a light density bump around the player, driven once per
 * in-game day by the scheduler in page.tsx.
 *
 *  - MAIN FIELD (world-fixed): ~120k line-segment streaks seeded uniformly
 *    across the entire 12,800 x 12,800 map, from above the tallest peak to
 *    below the deepest valley. Every drop's fall / wind slant / wrap is
 *    animated inside the vertex shader, so the per-frame CPU cost is zero.
 *  - LIGHT NEAR-FIELD BUMP: 440 extra streaks recycled inside a box
 *    re-centred on the player every frame (~1.1x extra density in a 700-unit
 *    footprint — 25x lighter than the old heavy curtain) so the rain right
 *    around the camera feels slightly fuller out to a wide radius without
 *    becoming a blob.
 *  - NEAR-CAMERA OPACITY BOOST: main-field streaks close to the camera get
 *    their opacity ramped up (up to 1 + NEAR_BOOST at zero distance, falling
 *    linearly to 1x at NEAR_RANGE), so near drops read bold and solid while
 *    the distant field keeps its faint veil look.
 *  - Terrain occludes drops behind hills via the depth buffer; the aerial
 *    FogExp2 fades distant streaks naturally (fog chunks + fog:true).
 *  - `intensity` (0..1) drives both layers' opacity plus a looping filtered-
 *    noise "rainfall" audio bed (WebAudio, no assets, fail-safe).
 *  - Storm dimming of sun/fog/sky/clouds lives in page.tsx's updateSky;
 *    this module only renders + sounds the water itself.
 */

import * as THREE from 'three';

/* ---------------- tuning: main field (whole terrain, GPU) ---------------- */
const FAR_DROPS = 120000; // streaks seeded uniformly across the entire map
const WORLD_HALF = 6400; // terrain spans 12,800 x 12,800 world units
const FAR_TOP = 2400; // above the tallest possible peak — wraps stay in open sky
const FAR_BOTTOM = -2400; // below the deepest valley — wraps hide underground
const FAR_SPEED_MIN = 430; // world units / s
const FAR_SPEED_MAX = 560;
const FAR_LENGTH_MIN = 30; // streak length reads at distance and up close
const FAR_LENGTH_MAX = 56;
const FAR_OPACITY = 0.5; // opacity multiplier at intensity 1
const NEAR_BOOST = 1.5; // extra opacity for drops at the camera (2.5x total)
const NEAR_RANGE = 800; // boost falls off linearly to zero at this distance

/* ---------------- tuning: light near-field bump (player-following) ------ */
const NEAR_DROPS = 440; // extra streaks around the player (same light density,
                        // wider 700-unit box — was 60 in a 260-unit box)
const NEAR_RADIUS = 350; // half-width of the bump box
const NEAR_TOP = 330; // spawn height above the player's feet
const NEAR_BOTTOM = -50; // respawn floor (below feet, off screen)
const NEAR_LENGTH_MIN = 26;
const NEAR_LENGTH_MAX = 46;
const NEAR_OPACITY = 0.42; // per-streak opacity multiplier at intensity 1

const WIND = new THREE.Vector3(-55, 0, -22); // world units / s slant (both)
const RAIN_COLOR = 0xa8bfd4; // pale blue-grey water
const AUDIO_MAX_GAIN = 0.22;

/* GPU rain: seed lives in `position` (x, z = spawn point, y = phase 0..1 down
   the fall column); aData = (speed, length, brightness, side 0 head/1 tail). */
const RAIN_VERTEX = /* glsl */ `
  attribute vec4 aData;
  uniform float uTime;
  uniform vec3 uWind;
  uniform float uTop;
  uniform float uBottom;
  uniform float uNearGain;
  uniform float uNearRange;
  varying float vFade;
  #include <fog_pars_vertex>
  void main() {
    float speed = aData.x;
    float span = uTop - uBottom;
    float fallen = mod(position.y * span + uTime * speed, span);
    float t = fallen / speed; // seconds since this drop spawned
    vec3 head = vec3(position.x + uWind.x * t, uTop - fallen, position.z + uWind.z * t);
    vec3 tail = head + vec3(uWind.x, -speed, uWind.z) * (aData.y / speed);
    vec3 p = mix(head, tail, aData.w);
    vFade = aData.z * (1.0 - aData.w * 0.75); // head bright, tail faded
    vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
    // near-camera boost: drops close to the lens read bold and solid
    float dist = length(mvPosition.xyz);
    vFade *= 1.0 + uNearGain * max(0.0, 1.0 - dist / uNearRange);
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const RAIN_FRAGMENT = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  varying float vFade;
  #include <fog_pars_fragment>
  void main() {
    gl_FragColor = vec4(uColor, uOpacity * vFade);
    #include <fog_fragment>
  }
`;

export interface RainHandle {
  /** Both rain layers — add it to the scene. */
  readonly object: THREE.LineSegments;
  /** Advance the shower. intensity 0 = hidden + silent. */
  update(dt: number, focus: THREE.Vector3, intensity: number): void;
  /** Layer sizes for debug handles. */
  readonly counts: { near: number; far: number };
  dispose(): void;
}

/** Creation options — mobile LOW tier passes a smaller far-streak budget. */
export interface RainOptions {
  /** Far-field streak count (default FAR_DROPS = 120000). Clamped to
   *  [5000, FAR_DROPS]; ~40k reads identically but sheds 160k vertices
   *  per frame and ~4.5MB of GPU buffers. */
  farDrops?: number;
}

/** Creates the whole-terrain rain + light player bump. Starts hidden. */
export function createRain(
  scene: THREE.Scene,
  options: RainOptions = {}
): RainHandle {
  const farDrops = Math.max(
    5000,
    Math.min(FAR_DROPS, Math.round(options.farDrops ?? FAR_DROPS))
  );
  // ---------- main field: world-fixed, GPU-animated, whole terrain ----------
  const positions = new Float32Array(farDrops * 2 * 3);
  const data = new Float32Array(farDrops * 2 * 4);

  for (let i = 0; i < farDrops; i++) {
    const sx = (Math.random() * 2 - 1) * WORLD_HALF;
    const sz = (Math.random() * 2 - 1) * WORLD_HALF;
    const phase = Math.random(); // position along the fall column at t=0
    const spd = FAR_SPEED_MIN + Math.random() * (FAR_SPEED_MAX - FAR_SPEED_MIN);
    const len = FAR_LENGTH_MIN + Math.random() * (FAR_LENGTH_MAX - FAR_LENGTH_MIN);
    const bright = 0.55 + Math.random() * 0.45;
    for (let v = 0; v < 2; v++) {
      const vi = (i * 2 + v) * 3;
      positions[vi + 0] = sx;
      positions[vi + 1] = phase;
      positions[vi + 2] = sz;
      const di = (i * 2 + v) * 4;
      data[di + 0] = spd;
      data[di + 1] = len;
      data[di + 2] = bright;
      data[di + 3] = v; // 0 = head vertex, 1 = tail vertex
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aData', new THREE.BufferAttribute(data, 4));

  const material = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        uTime: { value: 0 },
        uWind: { value: WIND.clone() },
        uTop: { value: FAR_TOP },
        uBottom: { value: FAR_BOTTOM },
        uColor: { value: new THREE.Color(RAIN_COLOR) },
        uOpacity: { value: 0 },
        uNearGain: { value: NEAR_BOOST },
        uNearRange: { value: NEAR_RANGE },
      },
    ]),
    vertexShader: RAIN_VERTEX,
    fragmentShader: RAIN_FRAGMENT,
    transparent: true,
    depthWrite: false,
    fog: true, // far streaks fade into the aerial haze like everything else
  });

  const mesh = new THREE.LineSegments(geometry, material);
  mesh.frustumCulled = false; // vertices are displaced in the shader
  mesh.visible = false;
  mesh.renderOrder = 6; // after clouds so drops draw on top
  scene.add(mesh);

  // ---------- light near-field bump: player-following wrap box ----------
  const nearPositions = new Float32Array(NEAR_DROPS * 2 * 3);
  const nearColors = new Float32Array(NEAR_DROPS * 2 * 3);
  const head = new Float32Array(NEAR_DROPS * 3); // per-drop head position
  const nearSpeed = new Float32Array(NEAR_DROPS);
  const nearLength = new Float32Array(NEAR_DROPS);
  const nearBright = new Float32Array(NEAR_DROPS); // brightness variance

  function respawnDrop(i3: number, fx: number, fy: number, fz: number): void {
    head[i3 + 1] = fy + NEAR_TOP;
    head[i3 + 0] = fx + (Math.random() - 0.5) * 2 * NEAR_RADIUS;
    head[i3 + 2] = fz + (Math.random() - 0.5) * 2 * NEAR_RADIUS;
  }

  for (let i = 0; i < NEAR_DROPS; i++) {
    const i3 = i * 3;
    head[i3 + 0] = (Math.random() - 0.5) * 2 * NEAR_RADIUS;
    head[i3 + 1] = Math.random() * (NEAR_TOP - NEAR_BOTTOM) + NEAR_BOTTOM;
    head[i3 + 2] = (Math.random() - 0.5) * 2 * NEAR_RADIUS;
    nearSpeed[i] = FAR_SPEED_MIN + Math.random() * (FAR_SPEED_MAX - FAR_SPEED_MIN);
    nearLength[i] =
      NEAR_LENGTH_MIN + Math.random() * (NEAR_LENGTH_MAX - NEAR_LENGTH_MIN);
    nearBright[i] = 0.55 + Math.random() * 0.45;
  }

  const nearGeometry = new THREE.BufferGeometry();
  const nearPosAttr = new THREE.BufferAttribute(nearPositions, 3);
  nearPosAttr.setUsage(THREE.DynamicDrawUsage);
  nearGeometry.setAttribute('position', nearPosAttr);
  nearGeometry.setAttribute('color', new THREE.BufferAttribute(nearColors, 3));

  const nearMaterial = new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0,
    color: RAIN_COLOR,
    depthWrite: false,
  });

  const nearMesh = new THREE.LineSegments(nearGeometry, nearMaterial);
  nearMesh.frustumCulled = false; // vertices move every frame
  nearMesh.visible = false;
  nearMesh.renderOrder = 6;
  scene.add(nearMesh);

  // ---------------- rainfall audio (filtered noise loop) ----------------
  let audioCtx: AudioContext | null = null;
  let audioGain: GainNode | null = null;

  function ensureAudio(): void {
    if (audioCtx) return;
    try {
      const Ctx =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      // 2s brown-noise loop: soft "hiss" that reads as steady rainfall
      const seconds = 2;
      const buffer = ctx.createBuffer(1, ctx.sampleRate * seconds, ctx.sampleRate);
      const bufferData = buffer.getChannelData(0);
      let last = 0;
      for (let i = 0; i < bufferData.length; i++) {
        const white = Math.random() * 2 - 1;
        last = (last + 0.02 * white) / 1.02;
        bufferData[i] = last * 3.2;
      }
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.loop = true;
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 1500;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      src.connect(filter).connect(gain).connect(ctx.destination);
      src.start();
      audioCtx = ctx;
      audioGain = gain;
    } catch {
      // audio is decorative — never break the game over it
      audioCtx = null;
      audioGain = null;
    }
  }

  // ---------------- per-frame update ----------------
  let rainTime = 0; // shader clock (wrapped for float32 precision safety)

  function update(dt: number, focus: THREE.Vector3, intensity: number) {
    const active = intensity > 0.005 && dt > 0;
    mesh.visible = active;
    nearMesh.visible = active;
    material.uniforms.uOpacity.value =
      THREE.MathUtils.clamp(intensity, 0, 1) * FAR_OPACITY;
    nearMaterial.opacity = THREE.MathUtils.clamp(intensity, 0, 1) * NEAR_OPACITY;

    // audio bed follows the intensity (created lazily after a user gesture)
    if (active) {
      ensureAudio();
      if (audioCtx && audioGain) {
        if (audioCtx.state === 'suspended') {
          void audioCtx.resume().catch(() => undefined);
        }
        audioGain.gain.setTargetAtTime(
          intensity * AUDIO_MAX_GAIN,
          audioCtx.currentTime,
          0.4
        );
      }
    } else if (audioGain && audioCtx) {
      audioGain.gain.setTargetAtTime(0, audioCtx.currentTime, 0.3);
    }

    if (!active) return;

    // GPU clock for the main field (wrap keeps float32 precision safe)
    rainTime = (rainTime + dt) % 4096;
    material.uniforms.uTime.value = rainTime;

    // integrate the bump drops, re-centre on the player, wrap falls
    const fx = focus.x;
    const fy = focus.y;
    const fz = focus.z;
    for (let i = 0; i < NEAR_DROPS; i++) {
      const i3 = i * 3;
      head[i3 + 1] -= nearSpeed[i] * dt;
      head[i3 + 0] += WIND.x * dt;
      head[i3 + 2] += WIND.z * dt;
      if (head[i3 + 1] < fy + NEAR_BOTTOM) {
        respawnDrop(i3, fx, fy, fz);
      }
      // keep every drop inside the moving box (wrap x/z like the fall)
      let dx = head[i3 + 0] - fx;
      let dz = head[i3 + 2] - fz;
      if (dx > NEAR_RADIUS) head[i3 + 0] -= 2 * NEAR_RADIUS;
      else if (dx < -NEAR_RADIUS) head[i3 + 0] += 2 * NEAR_RADIUS;
      if (dz > NEAR_RADIUS) head[i3 + 2] -= 2 * NEAR_RADIUS;
      else if (dz < -NEAR_RADIUS) head[i3 + 2] += 2 * NEAR_RADIUS;

      const tailFrac = nearLength[i] / nearSpeed[i]; // stretch along fall line
      nearPositions[i3 * 2 + 0] = head[i3 + 0];
      nearPositions[i3 * 2 + 1] = head[i3 + 1];
      nearPositions[i3 * 2 + 2] = head[i3 + 2];
      nearPositions[i3 * 2 + 3] = head[i3 + 0] + WIND.x * tailFrac;
      nearPositions[i3 * 2 + 4] = head[i3 + 1] - nearSpeed[i] * tailFrac;
      nearPositions[i3 * 2 + 5] = head[i3 + 2] + WIND.z * tailFrac;

      const b = nearBright[i];
      // head brighter, tail faded — cheap motion-blur look
      nearColors[i3 * 2 + 0] = b;
      nearColors[i3 * 2 + 1] = b;
      nearColors[i3 * 2 + 2] = b;
      nearColors[i3 * 2 + 3] = b * 0.25;
      nearColors[i3 * 2 + 4] = b * 0.25;
      nearColors[i3 * 2 + 5] = b * 0.25;
    }
    nearPosAttr.needsUpdate = true;
    nearGeometry.getAttribute('color').needsUpdate = true;
  }

  function dispose() {
    mesh.removeFromParent();
    geometry.dispose();
    material.dispose();
    nearMesh.removeFromParent();
    nearGeometry.dispose();
    nearMaterial.dispose();
    if (audioCtx) {
      try {
        void audioCtx.close();
      } catch {
        // already closed
      }
      audioCtx = null;
      audioGain = null;
    }
  }

  return {
    object: mesh,
    update,
    counts: { near: NEAR_DROPS, far: farDrops },
    dispose,
  };
}
