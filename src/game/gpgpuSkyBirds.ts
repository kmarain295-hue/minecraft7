import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { GPUComputationRenderer } from 'three/examples/jsm/misc/GPUComputationRenderer.js';

/**
 * GPGPU flocking birds in the sky, adapted from the three.js example
 * "webgl_gpgpu_birds_gltf" (r185, MIT license) — Parrot model by mirada
 * from ro.me. The flock is simulated on the GPU (GPUComputationRenderer):
 * a position + velocity texture pair drives boids separation / alignment /
 * cohesion, and ONE merged mesh renders every bird with per-bird wing-flap
 * animation baked from the GLTF morph targets.
 *
 * Tuned for this game's world (12,800 x 12,800 units, 100-unit terrain
 * blocks, ~190-unit tall character): the flight box matches the whole map
 * and wraps at its edges, the cluster pull is replaced by a soft altitude
 * spring plus per-bird wander, so birds stay spread out across the entire
 * sky, each on its own random course. The flock is a handful of rare
 * loners (2.5% of the simulated population) flying fast, straight
 * HORIZONTAL courses at a constant altitude, with slow, relaxed wing beats.
 */

/* TEXTURE WIDTH FOR SIMULATION */
const WIDTH = 32;
const BIRDS = WIDTH * WIDTH; // 32 x 32 = 1024 simulated birds

/** Birds actually rendered (drawRange): 2.5% of the 1024-bird simulation —
 *  a handful of rare loners spread across the whole world. */
const DRAW_FRACTION = 0.025;
const DRAW_COUNT = Math.max(1, Math.round(BIRDS * DRAW_FRACTION)); // 26

/** Flight box: matches the 12,800-unit terrain footprint (+/- 6,400), so
 *  birds roam the entire world edge-to-edge and wrap around at borders. */
const BOUNDS = 12800;

/** Flock plane height above the terrain — raised high into the sky,
 *  well above every hill, so birds cross overhead like distant specks. */
const SKY_HEIGHT = 2000;

/** Parrot scale: raw model is ~100 units -> ~160-200 unit birds. */
const BIRD_SIZE = 1.6;

const BIRD_MODEL_URL = '/models/gltf/Parrot.glb';

/* ------------------------------------------------------------------ */
/* Compute shaders (adapted from the three.js example, r185)           */
/* ------------------------------------------------------------------ */

/** Shader for bird position (and wing-flap phase in .w). */
const fragmentShaderPosition = /* glsl */ `
        uniform float time;
        uniform float delta;

        void main() {

                vec2 uv = gl_FragCoord.xy / resolution.xy;
                vec4 tmpPos = texture2D( texturePosition, uv );
                vec3 position = tmpPos.xyz;
                vec3 velocity = texture2D( textureVelocity, uv ).xyz;

                float phase = tmpPos.w;

                phase = mod( ( phase + delta +
                        length( velocity.xz ) * delta * 3. +
                        max( velocity.y, 0.0 ) * delta * 6. ), 62.83 );

                position += velocity * delta * 15.;

                // Wrap around the flight box: a bird leaving one edge
                // re-enters at the opposite one, keeping the sky populated
                // over the whole map instead of leaking away.
                const float HALF_BOUNDS = BOUNDS * 0.5;

                if ( position.x < - HALF_BOUNDS ) position.x += BOUNDS;
                else if ( position.x > HALF_BOUNDS ) position.x -= BOUNDS;
                if ( position.y < - HALF_BOUNDS ) position.y += BOUNDS;
                else if ( position.y > HALF_BOUNDS ) position.y -= BOUNDS;
                if ( position.z < - HALF_BOUNDS ) position.z += BOUNDS;
                else if ( position.z > HALF_BOUNDS ) position.z -= BOUNDS;

                gl_FragColor = vec4( position, phase );

        }
`;

/** Shader for bird velocity (boids rules + per-bird wander). */
const fragmentShaderVelocity = /* glsl */ `
        uniform float time;
        uniform float testing;
        uniform float delta; // about 0.016
        uniform float separationDistance; // 20
        uniform float alignmentDistance; // 40
        uniform float cohesionDistance; //
        uniform float freedomFactor;
        uniform vec3 predator;

        const float width = resolution.x;
        const float height = resolution.y;

        const float PI = 3.141592653589793;
        const float PI_2 = PI * 2.0;

        float zoneRadius = 40.0;
        float zoneRadiusSquared = 1600.0;

        float separationThresh = 0.45;
        float alignmentThresh = 0.65;

        const float UPPER_BOUNDS = BOUNDS;
        const float LOWER_BOUNDS = -UPPER_BOUNDS;

        // Cruise speed cap — raised 4x (9 -> 36): birds streak across the
        // 12,800-unit map, covering the whole sky in roughly 20 seconds
        // (the position pass advances positions by velocity * delta * 15).
        const float SPEED_LIMIT = 36.0;

        float rand( vec2 co ){
                return fract( sin( dot( co.xy, vec2(12.9898,78.233) ) ) * 43758.5453 );
        }

        void main() {

                zoneRadius = separationDistance + alignmentDistance + cohesionDistance;
                separationThresh = separationDistance / zoneRadius;
                alignmentThresh = ( separationDistance + alignmentDistance ) / zoneRadius;
                zoneRadiusSquared = zoneRadius * zoneRadius;


                vec2 uv = gl_FragCoord.xy / resolution.xy;
                vec3 birdPosition, birdVelocity;

                vec3 selfPosition = texture2D( texturePosition, uv ).xyz;
                vec3 selfVelocity = texture2D( textureVelocity, uv ).xyz;

                float dist;
                vec3 dir; // direction
                float distSquared;

                float separationSquared = separationDistance * separationDistance;
                float cohesionSquared = cohesionDistance * cohesionDistance;

                float f;
                float percent;

                vec3 velocity = selfVelocity;

                // Per-bird cruise speed: some birds simply fly faster than
                // others, which keeps the sky lively and unaligned.
                float limit = SPEED_LIMIT * ( 0.75 + rand( uv + vec2( 0.37, 0.71 ) ) * 0.5 );

                dir = predator * UPPER_BOUNDS - selfPosition;
                dir.z = 0.;
                dist = length( dir );
                distSquared = dist * dist;

                float preyRadius = 150.0;
                float preyRadiusSq = preyRadius * preyRadius;

                // move birds away from predator
                if ( dist < preyRadius ) {

                        f = ( distSquared / preyRadiusSq - 1.0 ) * delta * 100.;
                        velocity += normalize( dir ) * f;
                        limit += 5.0;

                }

                // Keep every bird at flight altitude: a soft vertical spring
                // toward the flock plane, critically damped so birds do NOT
                // oscillate up and down — they settle onto the level flight
                // plane and then fly straight. No horizontal center pull —
                // birds roam the whole sky and wrap at the flight box edges.
                velocity.y -= selfPosition.y * delta * 0.6;
                velocity.y -= velocity.y * min( delta * 1.5, 0.05 );

                // Per-bird wander: each bird drifts on its own slow
                // HORIZONTAL sinusoidal course (unique phase from its
                // texel), so paths differ while staying perfectly level.
                // No vertical force here — vertical bobbing is unwanted.
                float seed = rand( uv );
                float wSpeed = 0.25 + seed * 0.5;
                velocity.x += sin( time * wSpeed + seed * 6.2831 ) * delta * 2.0;
                velocity.z += cos( time * wSpeed * 0.83 + seed * 12.566 ) * delta * 2.0;

                for ( float y = 0.0; y < height; y++ ) {
                        for ( float x = 0.0; x < width; x++ ) {

                                vec2 ref = vec2( x + 0.5, y + 0.5 ) / resolution.xy;
                                birdPosition = texture2D( texturePosition, ref ).xyz;

                                dir = birdPosition - selfPosition;
                                dist = length( dir );

                                if ( dist < 0.0001 ) continue;

                                distSquared = dist * dist;

                                if ( distSquared > zoneRadiusSquared ) continue;

                                percent = distSquared / zoneRadiusSquared;

                                if ( percent < separationThresh ) { // low

                                        // Separation - Move apart for comfort
                                        f = ( separationThresh / percent - 1.0 ) * delta;
                                        velocity -= normalize( dir ) * f;

                                } else if ( percent < alignmentThresh ) { // high

                                        // Alignment - fly the same direction
                                        float threshDelta = alignmentThresh - separationThresh;
                                        float adjustedPercent = ( percent - separationThresh ) / threshDelta;

                                        birdVelocity = texture2D( textureVelocity, ref ).xyz;

                                        f = ( 0.5 - cos( adjustedPercent * PI_2 ) * 0.5 + 0.5 ) * delta;
                                        velocity += normalize( birdVelocity ) * f;

                                } else {

                                        // Attraction / Cohesion - move closer
                                        float threshDelta = 1.0 - alignmentThresh;
                                        float adjustedPercent;
                                        if( threshDelta == 0. ) adjustedPercent = 1.;
                                        else adjustedPercent = ( percent - alignmentThresh ) / threshDelta;

                                        f = ( 0.5 - ( cos( adjustedPercent * PI_2 ) * -0.5 + 0.5 ) ) * delta;

                                        velocity += normalize( dir ) * f;

                                }

                        }

                }

                // Speed Limits
                if ( length( velocity ) > limit ) {
                        velocity = normalize( velocity ) * limit;
                }

                gl_FragColor = vec4( velocity, 1.0 );

        }
`;

/* ------------------------------------------------------------------ */
/* Public interface                                                    */
/* ------------------------------------------------------------------ */

export interface BirdFlock {
  /** Advances the GPGPU simulation and the wing-flap time. */
  update(delta: number): void;
  /** Frees every GPU resource owned by the flock. */
  dispose(): void;
}

/** Debug mirror exposed on window. */
interface BirdsDebugInfo {
  ready: boolean;
  simulated: number;
  rendered: number;
  simTime: number;
}

/* ------------------------------------------------------------------ */
/* Factory                                                             */
/* ------------------------------------------------------------------ */

export function createBirdFlock(
  scene: THREE.Scene,
  renderer: THREE.WebGLRenderer
): BirdFlock {
  const debug: BirdsDebugInfo = {
    ready: false,
    simulated: BIRDS,
    rendered: DRAW_COUNT,
    simTime: 0,
  };
  (window as unknown as { __parrots?: BirdsDebugInfo }).__parrots = debug;

  // Set when dispose() runs before/while the model is still loading, so a
  // late GLTF callback cannot leak a mesh into a dead scene.
  let disposed = false;

  function nextPowerOf2(n: number) {
    return Math.pow(2, Math.ceil(Math.log(n) / Math.log(2)));
  }

  /* ---------------- GPGPU compute renderer ---------------- */

  let gpuCompute: GPUComputationRenderer | null = null;
  let velocityVariable: ReturnType<
    GPUComputationRenderer['addVariable']
  > | null = null;
  let positionVariable: ReturnType<
    GPUComputationRenderer['addVariable']
  > | null = null;
  let positionUniforms: Record<string, THREE.IUniform> | null = null;
  let velocityUniforms: Record<string, THREE.IUniform> | null = null;

  function fillPositionTexture(texture: THREE.DataTexture) {
    const theArray = texture.image.data as Float32Array;
    const boundsHalf = BOUNDS / 2;
    // Start the flock flatter on Y: keeps every bird sky-high from the
    // first frame instead of diving near the terrain before converging.
    const yHalf = BOUNDS * 0.04;

    for (let k = 0, kl = theArray.length; k < kl; k += 4) {
      theArray[k + 0] = Math.random() * BOUNDS - boundsHalf;
      theArray[k + 1] = Math.random() * yHalf * 2 - yHalf;
      theArray[k + 2] = Math.random() * BOUNDS - boundsHalf;
      theArray[k + 3] = 1;
    }
  }

  function fillVelocityTexture(texture: THREE.DataTexture) {
    const theArray = texture.image.data as Float32Array;

    // Launch every bird on its own random HORIZONTAL heading at a fast
    // random cruise speed matching the raised speed limit — zero vertical
    // component, so every bird flies level from the first frame instead
    // of climbing or diving.
    for (let k = 0, kl = theArray.length; k < kl; k += 4) {
      const theta = Math.random() * Math.PI * 2;
      const speed = 27 + Math.random() * 18;

      theArray[k + 0] = Math.cos(theta) * speed;
      theArray[k + 1] = 0;
      theArray[k + 2] = Math.sin(theta) * speed;
      theArray[k + 3] = 1;
    }
  }

  function initComputeRenderer() {
    gpuCompute = new GPUComputationRenderer(WIDTH, WIDTH, renderer);

    const dtPosition = gpuCompute.createTexture();
    const dtVelocity = gpuCompute.createTexture();
    fillPositionTexture(dtPosition);
    fillVelocityTexture(dtVelocity);

    velocityVariable = gpuCompute.addVariable(
      'textureVelocity',
      fragmentShaderVelocity,
      dtVelocity
    );
    positionVariable = gpuCompute.addVariable(
      'texturePosition',
      fragmentShaderPosition,
      dtPosition
    );

    gpuCompute.setVariableDependencies(velocityVariable, [
      positionVariable,
      velocityVariable,
    ]);
    gpuCompute.setVariableDependencies(positionVariable, [
      positionVariable,
      velocityVariable,
    ]);

    positionUniforms = positionVariable.material.uniforms;
    velocityUniforms = velocityVariable.material.uniforms;

    positionUniforms['time'] = { value: 0.0 };
    positionUniforms['delta'] = { value: 0.0 };
    velocityUniforms['time'] = { value: 1.0 };
    velocityUniforms['delta'] = { value: 0.0 };
    velocityUniforms['testing'] = { value: 1.0 };
    // Loose flocking: separation dominates the zone, alignment/cohesion are
    // weak — small local groups instead of one dense murmuration.
    velocityUniforms['separationDistance'] = { value: 26.0 };
    velocityUniforms['alignmentDistance'] = { value: 14.0 };
    velocityUniforms['cohesionDistance'] = { value: 10.0 };
    velocityUniforms['freedomFactor'] = { value: 0.75 };
    // Parked far away: no predator disturbs the loners' courses.
    velocityUniforms['predator'] = { value: new THREE.Vector3(1e6, 1e6, 0) };
    velocityVariable.material.defines.BOUNDS = BOUNDS.toFixed(2);
    positionVariable.material.defines.BOUNDS = BOUNDS.toFixed(2);

    velocityVariable.wrapS = THREE.RepeatWrapping;
    velocityVariable.wrapT = THREE.RepeatWrapping;
    positionVariable.wrapS = THREE.RepeatWrapping;
    positionVariable.wrapT = THREE.RepeatWrapping;

    const error = gpuCompute.init();

    if (error !== null) {
      console.error(error);
    }
  }

  /* ---------------- birds mesh (built after GLTF load) ---------------- */

  let birdMesh: THREE.Mesh | null = null;
  let materialShader: THREE.WebGLProgramParametersWithUniforms | null = null;
  let textureAnimation: THREE.DataTexture | null = null;

  const disposeList: Array<() => void> = [];

  new GLTFLoader().load(BIRD_MODEL_URL, function (gltf) {
    if (disposed) return; // scene died before the model arrived

    // Find the first mesh with morph-target animation frames (the parrot).
    let birdGeo: THREE.BufferGeometry | null = null;
    gltf.scene.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (
        !birdGeo &&
        mesh.isMesh &&
        mesh.geometry &&
        mesh.geometry.morphAttributes.position &&
        mesh.geometry.morphAttributes.position.length > 0
      ) {
        birdGeo = mesh.geometry;
      }
    });
    if (!birdGeo || !birdGeo.index || gltf.animations.length === 0) return;

    const animations = gltf.animations;
    const durationAnimation = Math.round(animations[0].duration * 60);
    const morphAttributes = birdGeo.morphAttributes.position;
    const tHeight = nextPowerOf2(durationAnimation);
    const tWidth = nextPowerOf2(birdGeo.getAttribute('position').count);
    const indicesPerBird = birdGeo.index.count;
    const tData = new Float32Array(4 * tWidth * tHeight);

    // Bake the wing-flap morph animation into a float texture.
    for (let i = 0; i < tWidth; i++) {
      for (let j = 0; j < tHeight; j++) {
        const offset = j * tWidth * 4;

        const curMorph = Math.floor(
          (j / durationAnimation) * morphAttributes.length
        );
        const nextMorph =
          (Math.floor((j / durationAnimation) * morphAttributes.length) + 1) %
          morphAttributes.length;
        const lerpAmount = ((j / durationAnimation) * morphAttributes.length) % 1;

        if (j < durationAnimation) {
          let d0: number | undefined, d1: number | undefined;

          d0 = morphAttributes[curMorph].array[i * 3];
          d1 = morphAttributes[nextMorph].array[i * 3];

          if (d0 !== undefined && d1 !== undefined)
            tData[offset + i * 4] = THREE.MathUtils.lerp(d0, d1, lerpAmount);

          d0 = morphAttributes[curMorph].array[i * 3 + 1];
          d1 = morphAttributes[nextMorph].array[i * 3 + 1];

          if (d0 !== undefined && d1 !== undefined)
            tData[offset + i * 4 + 1] = THREE.MathUtils.lerp(d0, d1, lerpAmount);

          d0 = morphAttributes[curMorph].array[i * 3 + 2];
          d1 = morphAttributes[nextMorph].array[i * 3 + 2];

          if (d0 !== undefined && d1 !== undefined)
            tData[offset + i * 4 + 2] = THREE.MathUtils.lerp(d0, d1, lerpAmount);

          tData[offset + i * 4 + 3] = 1;
        }
      }
    }

    textureAnimation = new THREE.DataTexture(
      tData,
      tWidth,
      tHeight,
      THREE.RGBAFormat,
      THREE.FloatType
    );
    textureAnimation.needsUpdate = true;

    // Merge one parrot per simulated bird, tagged with a reference (which
    // simulation texel) and seeds (per-bird phase / size variance).
    const BirdGeometry = new THREE.BufferGeometry();
    const vertices = [],
      color = [],
      reference = [],
      seeds = [],
      indices = [];
    const birdVertexCount = birdGeo.getAttribute('position').count;
    const totalVertices = birdVertexCount * 3 * BIRDS;
    for (let i = 0; i < totalVertices; i++) {
      const bIndex = i % (birdVertexCount * 3);
      vertices.push(birdGeo.getAttribute('position').array[bIndex]);
      color.push(birdGeo.getAttribute('color').array[bIndex]);
    }

    let r = Math.random();
    for (let i = 0; i < birdVertexCount * BIRDS; i++) {
      const bIndex = i % birdVertexCount;
      const bird = Math.floor(i / birdVertexCount);
      if (bIndex == 0) r = Math.random();
      const j = Math.floor(bird);
      const x = (j % WIDTH) / WIDTH;
      const y = Math.floor(j / WIDTH) / WIDTH;
      reference.push(x, y, bIndex / tWidth, durationAnimation / tHeight);
      seeds.push(bird, r, Math.random(), Math.random());
    }

    for (let i = 0; i < birdGeo.index.array.length * BIRDS; i++) {
      const offset =
        Math.floor(i / birdGeo.index.array.length) * birdVertexCount;
      indices.push(
        birdGeo.index.array[i % birdGeo.index.array.length] + offset
      );
    }

    BirdGeometry.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array(vertices), 3)
    );
    BirdGeometry.setAttribute(
      'birdColor',
      new THREE.BufferAttribute(new Float32Array(color), 3)
    );
    BirdGeometry.setAttribute(
      'color',
      new THREE.BufferAttribute(new Float32Array(color), 3)
    );
    BirdGeometry.setAttribute(
      'reference',
      new THREE.BufferAttribute(new Float32Array(reference), 4)
    );
    BirdGeometry.setAttribute(
      'seeds',
      new THREE.BufferAttribute(new Float32Array(seeds), 4)
    );
    BirdGeometry.setIndex(indices);

    initComputeRenderer();

    // The example's MeshStandardMaterial + onBeforeCompile injection: the
    // vertex shader places every bird at its simulated position, orients it
    // along its velocity and adds the wing-flap animation offset.
    const m = new THREE.MeshStandardMaterial({
      vertexColors: true,
      flatShading: true,
      roughness: 1,
      metalness: 0,
    });

    m.onBeforeCompile = (shader) => {
      shader.uniforms.texturePosition = { value: null };
      shader.uniforms.textureVelocity = { value: null };
      shader.uniforms.textureAnimation = { value: textureAnimation };
      shader.uniforms.time = { value: 1.0 };
      shader.uniforms.size = { value: BIRD_SIZE };
      shader.uniforms.delta = { value: 0.0 };

      let token = '#define STANDARD';

      let insert = /* glsl */ `
                                attribute vec4 reference;
                                attribute vec4 seeds;
                                attribute vec3 birdColor;
                                uniform sampler2D texturePosition;
                                uniform sampler2D textureVelocity;
                                uniform sampler2D textureAnimation;
                                uniform float size;
                                uniform float time;
                        `;

      shader.vertexShader = shader.vertexShader.replace(token, token + insert);

      token = '#include <begin_vertex>';

      insert = /* glsl */ `
                                vec4 tmpPos = texture2D( texturePosition, reference.xy );

                                vec3 pos = tmpPos.xyz;
                                vec3 velocity = normalize(texture2D( textureVelocity, reference.xy ).xyz);
                                // Slow, relaxed wing beats — the squadron
                                // soars across the map with calm flapping
                                // instead of speedy fluttering.
                                vec3 aniPos = texture2D( textureAnimation, vec2( reference.z, mod( time * 0.55 + ( seeds.x ) * ( ( 0.0004 + seeds.y / 10000.0) + normalize( velocity ) / 20000.0 ), reference.w ) ) ).xyz;
                                vec3 newPosition = position;

                                newPosition = mat3( modelMatrix ) * ( newPosition + aniPos );
                                newPosition *= size + seeds.y * size * 0.2;

                                velocity.z *= -1.;
                                float xz = length( velocity.xz );
                                float xyz = 1.;
                                float x = sqrt( 1. - velocity.y * velocity.y );

                                float cosry = velocity.x / xz;
                                float sinry = velocity.z / xz;

                                float cosrz = x / xyz;
                                float sinrz = velocity.y / xyz;

                                mat3 maty =  mat3( cosry, 0, -sinry, 0    , 1, 0     , sinry, 0, cosry );
                                mat3 matz =  mat3( cosrz , sinrz, 0, -sinrz, cosrz, 0, 0     , 0    , 1 );

                                newPosition =  maty * matz * newPosition;
                                newPosition += pos;

                                vec3 transformed = vec3( newPosition );
                        `;

      shader.vertexShader = shader.vertexShader.replace(token, insert);

      materialShader = shader;
    };

    birdMesh = new THREE.Mesh(BirdGeometry, m);
    birdMesh.rotation.y = Math.PI / 2;
    // The simulation is local: park the flock plane at SKY_HEIGHT above the
    // map center while the flight box covers the whole world in XZ.
    birdMesh.position.set(0, SKY_HEIGHT, 0);
    // Bird positions are displaced in the shader: the computed bounding
    // sphere is meaningless, so never cull the flock.
    birdMesh.frustumCulled = false;
    birdMesh.castShadow = false;
    birdMesh.receiveShadow = false;
    birdMesh.geometry.setDrawRange(0, indicesPerBird * DRAW_COUNT);

    scene.add(birdMesh);

    disposeList.push(() => {
      BirdGeometry.dispose();
      textureAnimation?.dispose();
      m.dispose();
    });

    debug.ready = true;
  });

  /* ---------------- per-frame update ---------------- */

  function update(delta: number) {
    const d = Math.min(delta, 1); // safety cap on large deltas
    debug.simTime += d;

    const posVar = positionVariable;
    const velVar = velocityVariable;

    if (
      !gpuCompute ||
      !posVar ||
      !velVar ||
      !positionUniforms ||
      !velocityUniforms ||
      !materialShader
    ) {
      return;
    }

    positionUniforms['time'].value = debug.simTime;
    positionUniforms['delta'].value = d;
    velocityUniforms['time'].value = debug.simTime;
    velocityUniforms['delta'].value = d;
    materialShader.uniforms['time'].value = debug.simTime;
    materialShader.uniforms['delta'].value = d;

    gpuCompute.compute();

    materialShader.uniforms['texturePosition'].value =
      gpuCompute.getCurrentRenderTarget(posVar).texture;
    materialShader.uniforms['textureVelocity'].value =
      gpuCompute.getCurrentRenderTarget(velVar).texture;
  }

  function dispose() {
    disposed = true;
    delete (window as unknown as { __parrots?: BirdsDebugInfo }).__parrots;
    if (birdMesh) {
      scene.remove(birdMesh);
      birdMesh = null;
    }
    for (const fn of disposeList) fn();
    disposeList.length = 0;
    gpuCompute?.dispose();
    gpuCompute = null;
    materialShader = null;
    positionUniforms = null;
    velocityUniforms = null;
    positionVariable = null;
    velocityVariable = null;
  }

  return { update, dispose };
}
