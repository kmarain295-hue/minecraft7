/**
 * Ultra-realistic procedural clouds for the RATFIRE sky — slow drift +
 * continuous structure morphing, paired with aerial fog on the terrain.
 *
 * Two independent layers are drawn as huge camera-following planes whose
 * fragment shaders build the clouds entirely procedurally (no textures):
 *  - A low cumulus deck: iq-style domain-warped 3D value-noise FBM. The
 *    noise's third dimension is a very slow "morph" clock, so the clouds
 *    literally change their shape over time instead of just translating.
 *  - A high cirrus veil: anisotropically stretched noise for long wispy
 *    streaks, drifting on its own slower wind.
 *
 * Realism details:
 *  - The pattern is anchored to WORLD coordinates (the plane re-anchors to
 *    the camera every frame but samples world-space positions), so clouds
 *    keep true parallax while the player crosses the 12800-unit map.
 *  - A second field sample offset toward the active light (sun by day,
 *    moon by night) shades sun-facing rims bright ("silver lining") and
 *    leaves far edges in shadow, faking volume.
 *  - Dense cores darken; the whole deck melts into the sky colour toward
 *    the horizon (aerial perspective) and fades out before the plane edge.
 *  - The palette is driven by the day/night cycle: white at noon, orange
 *    at dusk/dawn, dim blue moonlit silhouettes at night.
 *
 * The "fog" the user asked for comes from two places: these layers soften
 * into the sky colour at grazing angles, and page.tsx adds a FogExp2 whose
 * colour tracks the sky every frame so distant terrain sinks into haze.
 */

import * as THREE from 'three';

/** Per-frame inputs from the day/night driver in page.tsx. */
export interface CloudFrameInfo {
  dt: number;
  cameraPos: THREE.Vector3;
  /** Current sky colour (mutated in place every frame by updateSky). */
  skyColor: THREE.Color;
  /** Direction of the ACTIVE light (sun by day, moon by night). */
  lightDir: THREE.Vector3;
  /** 0 at night .. 1 at full day. */
  sunUp: number;
  /** 1 when the sun sits on the horizon (dawn/dusk), else 0. */
  horizonGlow: number;
  /** Current directional light colour (silver-lining tint). */
  lightColor: THREE.Color;
  /** 0 = clear .. 1 = full storm: clouds darken + thicken with rain. */
  storm: number;
}

export interface SkyCloudsHandle {
  update(info: CloudFrameInfo): void;
  dispose(): void;
  setCoverage(value: number): void;
  getCoverage(): number;
  stats(): { drift: number[]; morph: number[]; coverage: number; layers: number };
}

/* ---------------- layer layout (heights above the camera) ---------------- */
const CUMULUS_HEIGHT = 1000; // low, foggy deck the player can nearly touch
const CIRRUS_HEIGHT = 2000; // high wispy veil
const CUMULUS_RADIUS = 13000; // plane half-size (world units)
const CIRRUS_RADIUS = 16000;

/* ---------------- noise / wind tuning ---------------- */
const CUMULUS_SCALE = 2800; // world units per noise cell (cloud size)
const CIRRUS_SCALE = 3000;
/** Wind drift in world units / second — deliberately VERY slow. */
const CUMULUS_WIND = new THREE.Vector2(12, 5.5);
const CIRRUS_WIND = new THREE.Vector2(-17, 8);
/** Morph clock rates in noise units / second — shape evolution, very slow. */
const CUMULUS_MORPH_RATE = 0.015;
const CIRRUS_MORPH_RATE = 0.025;

/** Coverage: 0 = clear sky, 1 = overcast. Debug/user tunable. */
const DEFAULT_COVERAGE = 0.6;

/* ---------------- day/night palette ---------------- */
const DAY_LIT = new THREE.Color(0xffffff); // sunlit tops
const DAY_SHADOW = new THREE.Color(0x8d9cb5); // grey-blue bellies
const SET_LIT = new THREE.Color(0xffc088); // sunset-lit rims
const SET_SHADOW = new THREE.Color(0x5c5670); // purple-grey dusk bellies
const NIGHT_LIT = new THREE.Color(0x44557c); // moonlit
const NIGHT_SHADOW = new THREE.Color(0x11182b); // near-black silhouettes
const STORM_LIT = new THREE.Color(0x8a94a2); // wet grey storm tops
const STORM_SHADOW = new THREE.Color(0x3d4450); // dark rain-cloud bellies

/* ---------------- shaders ---------------- */

const cloudVertex = /* glsl */ `
varying vec3 vWorld;

void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

function cloudFragment(octaves: number, shaded: boolean): string {
  return /* glsl */ `
#define OCTAVES ${octaves}
${shaded ? '#define SHADED 1' : ''}

varying vec3 vWorld;

uniform vec2 uDrift;        // accumulated wind offset (noise units)
uniform float uMorphTime;   // accumulated morph clock (noise units)
uniform vec3 uLightDir;     // active sun/moon direction
uniform vec3 uLitColor;
uniform vec3 uShadowColor;
uniform vec3 uSkyColor;
uniform vec3 uSunTint;      // directional light colour (rim tint)
uniform float uOpacity;
uniform float uCoverageLo;
uniform float uCoverageHi;
uniform float uRadius;      // plane half-size (world units)
uniform vec2 uCenter;       // plane centre (world xz)
uniform vec2 uAniso;        // per-axis noise multipliers (streaking)
uniform float uNoiseScale;  // world units per noise cell
uniform float uWarp;        // domain-warp strength
uniform float uShade;       // sun-side shading strength
uniform float uSilver;      // silver-lining strength

float hash(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

float vnoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hash(i + vec3(0.0, 0.0, 0.0)), hash(i + vec3(1.0, 0.0, 0.0)), f.x),
        mix(hash(i + vec3(0.0, 1.0, 0.0)), hash(i + vec3(1.0, 1.0, 0.0)), f.x), f.y),
    mix(mix(hash(i + vec3(0.0, 0.0, 1.0)), hash(i + vec3(1.0, 0.0, 1.0)), f.x),
        mix(hash(i + vec3(0.0, 1.0, 1.0)), hash(i + vec3(1.0, 1.0, 1.0)), f.x), f.y),
    f.z);
}

float fbm(vec3 p) {
  float sum = 0.0;
  float amp = 0.5;
  for (int i = 0; i < OCTAVES; i++) {
    sum += amp * vnoise(p);
    p = p * 2.03 + vec3(11.3, 17.7, 9.1);
    amp *= 0.5;
  }
  return sum;
}

/** Domain-warped FBM field; z of pp is the slow morph clock. */
float cloudField(vec3 pp) {
  if (uWarp > 0.001) {
    float q = fbm(pp + vec3(31.7, 5.3, 0.0));
    float r = fbm(pp + vec3(q * uWarp, q * uWarp * 0.8, 0.0) + vec3(8.3, 2.8, 0.0));
    return fbm(pp + vec3(r * uWarp, r * uWarp * 0.8, 0.0));
  }
  return fbm(pp);
}

void main() {
  // world-anchored pattern: the plane moves, the clouds do not follow it
  vec2 p = vWorld.xz / uNoiseScale * uAniso + uDrift;
  vec3 pp = vec3(p, uMorphTime);

  float f = cloudField(pp);
  float cov = smoothstep(uCoverageLo, uCoverageHi, f);
  if (cov < 0.004) discard;

#ifdef SHADED
  // sample the field a step toward the light's azimuth: if the cloud thins
  // toward the light this fragment is a lit rim, otherwise it faces away
  vec2 lightAz = normalize(uLightDir.xz + vec2(1e-4, 0.0));
  float f2 = cloudField(pp + vec3(lightAz * 0.16, 0.0));
  float shade = clamp(0.5 + (f - f2) * uShade, 0.0, 1.0);
#else
  float shade = 0.62;
#endif

  vec3 col = mix(uShadowColor, uLitColor, shade);

  // dense cores read darker — thicker cloud, less light punching through
  float thick = smoothstep(uCoverageLo, uCoverageHi + 0.14, f);
  col = mix(col, uShadowColor * 0.72, thick * 0.45);

  // silver lining on the brightest sun-facing rims
  col += uSunTint * pow(shade, 4.0) * (1.0 - thick) * uSilver;

  // melt into the sky toward the horizon (aerial perspective), then out
  float rad = length(vWorld.xz - uCenter) / uRadius;
  float horizon = smoothstep(0.55, 0.95, rad);
  col = mix(col, uSkyColor, horizon * 0.9);

  float alpha = cov * uOpacity * (1.0 - smoothstep(0.72, 0.98, rad));
  gl_FragColor = vec4(col, alpha);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;
}

/* ---------------- layer plumbing ---------------- */

interface LayerSpec {
  height: number;
  radius: number;
  noiseScale: number;
  wind: THREE.Vector2; // world units / s
  morphRate: number; // noise units / s
  aniso: THREE.Vector2;
  warp: number;
  shade: number;
  octaves: number;
  shaded: boolean;
  opacity: number;
  renderOrder: number;
}

interface Layer extends LayerSpec {
  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;
  drift: THREE.Vector2; // accumulated, noise units (anisotropic space)
  driftRate: THREE.Vector2; // noise units / s
  morph: number; // accumulated morph clock
}

function buildLayer(scene: THREE.Scene, spec: LayerSpec): Layer {
  const geometry = new THREE.PlaneGeometry(spec.radius * 2, spec.radius * 2);
  geometry.rotateX(Math.PI / 2); // face the ground

  const material = new THREE.ShaderMaterial({
    vertexShader: cloudVertex,
    fragmentShader: cloudFragment(spec.octaves, spec.shaded),
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    uniforms: {
      uDrift: { value: new THREE.Vector2() },
      uMorphTime: { value: 0 },
      uLightDir: { value: new THREE.Vector3(0, 1, 0) },
      uLitColor: { value: DAY_LIT.clone() },
      uShadowColor: { value: DAY_SHADOW.clone() },
      uSkyColor: { value: new THREE.Color(0xbfd1e5) },
      uSunTint: { value: new THREE.Color(0xffffff) },
      uOpacity: { value: spec.opacity },
      uCoverageLo: { value: 0.49 },
      uCoverageHi: { value: 0.79 },
      uRadius: { value: spec.radius },
      uCenter: { value: new THREE.Vector2() },
      uAniso: { value: spec.aniso.clone() },
      uNoiseScale: { value: spec.noiseScale },
      uWarp: { value: spec.warp },
      uShade: { value: spec.shade },
      uSilver: { value: 0.18 },
    },
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false; // re-anchored to the camera every frame
  mesh.renderOrder = spec.renderOrder; // after sun/moon (0) and stars (1)
  scene.add(mesh);

  const driftRate = spec.wind
    .clone()
    .multiply(spec.aniso)
    .divideScalar(spec.noiseScale);

  return { ...spec, mesh, material, drift: new THREE.Vector2(), driftRate, morph: 0 };
}

/** Maps coverage 0..1 onto the smoothstep window of the field value. */
function coverageWindow(coverage: number): { lo: number; hi: number } {
  const lo = THREE.MathUtils.lerp(0.68, 0.3, coverage);
  return { lo, hi: lo + 0.3 };
}

/** Creation options — mobile LOW tier lowers the FBM octave counts. */
export interface SkyCloudsOptions {
  /** Fewer noise octaves per fragment (5/4 -> 3/3): a big fill-rate save
   *  over the huge sky area with only a subtle softening of the shapes. */
  lowQuality?: boolean;
}

/**
 * Creates the two cloud layers. Call `handle.update` once per frame from the
 * day/night driver; dispose when the scene tears down.
 */
export function createSkyClouds(
  scene: THREE.Scene,
  options: SkyCloudsOptions = {}
): SkyCloudsHandle {
  const lowQ = options.lowQuality === true;
  const layers: Layer[] = [
    buildLayer(scene, {
      height: CUMULUS_HEIGHT,
      radius: CUMULUS_RADIUS,
      noiseScale: CUMULUS_SCALE,
      wind: CUMULUS_WIND,
      morphRate: CUMULUS_MORPH_RATE,
      aniso: new THREE.Vector2(1, 1),
      warp: 1.35,
      shade: 2.6,
      octaves: lowQ ? 3 : 5,
      shaded: true,
      opacity: 0.9,
      renderOrder: 3,
    }),
    buildLayer(scene, {
      height: CIRRUS_HEIGHT,
      radius: CIRRUS_RADIUS,
      noiseScale: CIRRUS_SCALE,
      wind: CIRRUS_WIND,
      morphRate: CIRRUS_MORPH_RATE,
      aniso: new THREE.Vector2(0.35, 1.0), // stretched into long streaks
      warp: 0.7,
      shade: 0,
      octaves: lowQ ? 3 : 4,
      shaded: false,
      opacity: 0.42,
      renderOrder: 4,
    }),
  ];

  let coverage = DEFAULT_COVERAGE;
  {
    const win = coverageWindow(coverage);
    for (const layer of layers) {
      layer.material.uniforms.uCoverageLo.value = win.lo;
      layer.material.uniforms.uCoverageHi.value = win.hi;
    }
  }

  // scratch colours so no per-frame allocation
  const lit = new THREE.Color();
  const shadow = new THREE.Color();
  const stormWin = { lo: 0, hi: 0 };

  return {
    update(info: CloudFrameInfo) {
      // rain storms darken the deck and thicken the cover while they pour
      const storm = THREE.MathUtils.clamp(info.storm ?? 0, 0, 1);
      const effCoverage = Math.min(1, coverage + storm * 0.35);
      {
        const win = coverageWindow(effCoverage);
        stormWin.lo = win.lo;
        stormWin.hi = win.hi;
      }

      for (const layer of layers) {
        layer.drift.x += layer.driftRate.x * info.dt;
        layer.drift.y += layer.driftRate.y * info.dt;
        layer.morph += layer.morphRate * info.dt;

        const u = layer.material.uniforms;
        (u.uDrift.value as THREE.Vector2).copy(layer.drift);
        u.uMorphTime.value = layer.morph;
        (u.uLightDir.value as THREE.Vector3).copy(info.lightDir);
        (u.uSkyColor.value as THREE.Color).copy(info.skyColor);
        (u.uSunTint.value as THREE.Color).copy(info.lightColor);
        // clouds stay slightly visible at night: moonlit silhouettes
        u.uOpacity.value = layer.opacity * (0.86 + 0.14 * info.sunUp);
        u.uCoverageLo.value = stormWin.lo;
        u.uCoverageHi.value = stormWin.hi;

        layer.mesh.position.set(
          info.cameraPos.x,
          info.cameraPos.y + layer.height,
          info.cameraPos.z
        );
        (u.uCenter.value as THREE.Vector2).set(info.cameraPos.x, info.cameraPos.z);
      }

      // shared day/night palette
      lit.copy(NIGHT_LIT).lerp(DAY_LIT, info.sunUp);
      lit.lerp(SET_LIT, info.horizonGlow * 0.65);
      shadow.copy(NIGHT_SHADOW).lerp(DAY_SHADOW, info.sunUp);
      shadow.lerp(SET_SHADOW, info.horizonGlow * 0.55);
      // storm cells flatten everything toward wet grey
      lit.lerp(STORM_LIT, storm * 0.85);
      shadow.lerp(STORM_SHADOW, storm * 0.85);
      const silver =
        (0.08 + 0.4 * info.horizonGlow + 0.06 * info.sunUp) * (1 - 0.85 * storm);

      for (const layer of layers) {
        (layer.material.uniforms.uLitColor.value as THREE.Color).copy(lit);
        (layer.material.uniforms.uShadowColor.value as THREE.Color).copy(shadow);
        layer.material.uniforms.uSilver.value = silver;
      }
    },

    dispose() {
      for (const layer of layers) {
        scene.remove(layer.mesh);
        layer.mesh.geometry.dispose();
        layer.material.dispose();
      }
    },

    setCoverage(value: number) {
      coverage = THREE.MathUtils.clamp(value, 0, 1);
      const win = coverageWindow(coverage);
      for (const layer of layers) {
        layer.material.uniforms.uCoverageLo.value = win.lo;
        layer.material.uniforms.uCoverageHi.value = win.hi;
      }
    },

    getCoverage: () => coverage,

    stats() {
      return {
        drift: layers.map((l) => [l.drift.x, l.drift.y]),
        morph: layers.map((l) => l.morph),
        coverage,
        layers: layers.length,
      };
    },
  };
}
