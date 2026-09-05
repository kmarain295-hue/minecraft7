/**
 * Realistic bullets + gun VFX for RATFIRE.
 *
 * Fired from the active weapon's muzzle (page.tsx computes the nozzle world
 * position). One call to fireFrom() spawns the whole shot package:
 *
 *   - BULLET: a pooled FMJ round built from a LatheGeometry profile (brass
 *     cartridge -> cannelure groove -> copper-jacket ogive nose) wrapped in a
 *     procedural canvas texture (metal bands + shading). Flies with a slight
 *     gravity drop, dies on terrain contact or range expiry.
 *   - TRACER: two crossed additive gradient planes riding the bullet (a "+"
 *     cross-section reads as a glowing streak from ANY viewing angle, no
 *     per-frame billboarding needed).
 *   - MUZZLE FLASH: additive star-burst quads that pop, spin and fade in
 *     ~90 ms, camera-facing.
 *   - SPARKS: one THREE.Points pool; particles eject in a cone, fall under
 *     gravity and fade to black (additive black = invisible, so no per-
 *     particle alpha attribute is needed).
 *   - SMOKE: pooled sprites that rise, drift, expand and fade.
 *
 * LOW_SPEC (phones) runs smaller pools + fewer particles per shot. A slowmo
 * factor (setSlowmo) exists purely so tools/screenshots can freeze a shot
 * mid-flight; gameplay always runs at 1.
 */

import * as THREE from 'three';

/* ------------------------------- tuning ---------------------------------- */
const BULLET_SPEED = 1500; // world units / s (~15 m/s at this world scale:
                           // fast enough to feel like a gun, slow enough to SEE)
const BULLET_GRAVITY = 260; // gentle drop over long shots
const BULLET_LIFE = 1.5; // s before range expiry
const WORLD_LIMIT = 6300; // beyond the terrain edge -> recycle

const BULLET_POOL = 10;
const BULLET_POOL_LOW = 6;

const TRACER_W = 1.7;
const TRACER_L = 17;
const TRACER_OPACITY = 0.9;

const FLASH_PER_SHOT = 2;
const FLASH_PER_SHOT_LOW = 1;
const FLASH_POOL = 3;
const FLASH_SIZE = 30;
const FLASH_LIFE = 0.09;

const SPARKS_PER_SHOT = 16;
const SPARKS_PER_SHOT_LOW = 7;
const SPARKS_PER_IMPACT = 10;
const SPARKS_PER_IMPACT_LOW = 4;
const SPARK_POOL = 160;
const SPARK_POOL_LOW = 64;
const SPARK_SIZE = 6;
const SPARK_SPEED_MIN = 240;
const SPARK_SPEED_MAX = 560;
const SPARK_SPREAD = 0.5; // rad of cone around the fire axis
const SPARK_GRAVITY = 1000;
const SPARK_LIFE_MIN = 0.3;
const SPARK_LIFE_MAX = 0.65;

const SMOKE_PER_SHOT = 3;
const SMOKE_PER_SHOT_LOW = 1;
const SMOKE_PER_IMPACT = 1;
const SMOKE_POOL = 18;
const SMOKE_POOL_LOW = 8;
const SMOKE_LIFE = 0.9;
const SMOKE_SCALE_START = 9;
const SMOKE_SCALE_GROW = 15;
const SMOKE_RISE = 26;
const SMOKE_OPACITY = 0.4;

/* --------------------------- procedural textures ------------------------- */

function canvasTexture(
  width: number,
  height: number,
  draw: (ctx: CanvasRenderingContext2D) => void
): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (ctx) draw(ctx);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 2;
  return tex;
}

/** FMJ round jacket: brass cartridge base -> dark cannelure -> copper nose.
 *  v=0 (image bottom) is the bullet base, v=1 (top) is the tip. */
function bulletJacketTexture(): THREE.CanvasTexture {
  return canvasTexture(128, 128, (ctx) => {
    // vertical metal gradient (bottom brass -> top copper)
    const grad = ctx.createLinearGradient(0, 128, 0, 0);
    grad.addColorStop(0.0, '#6e4a1c'); // case rim shadow
    grad.addColorStop(0.08, '#c9a24a'); // brass rim shine
    grad.addColorStop(0.3, '#e8c469'); // brass body highlight
    grad.addColorStop(0.52, '#b98f3e'); // brass lower mid
    grad.addColorStop(0.56, '#2e2318'); // cannelure groove (dark ring)
    grad.addColorStop(0.62, '#c98544'); // copper jacket start
    grad.addColorStop(0.8, '#e8a25f'); // copper highlight
    grad.addColorStop(1.0, '#8f4f22'); // nose tip shading
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 128, 128);
    // horizontal machining streaks (u axis = around the bullet)
    ctx.globalAlpha = 0.16;
    for (let i = 0; i < 42; i++) {
      const y = Math.random() * 128;
      const w = 20 + Math.random() * 90;
      ctx.fillStyle = Math.random() > 0.5 ? '#ffffff' : '#000000';
      ctx.fillRect(Math.random() * (128 - w), y, w, 1);
    }
    ctx.globalAlpha = 1;
    // primer circle on the base
    const primer = ctx.createRadialGradient(64, 124, 2, 64, 124, 12);
    primer.addColorStop(0, '#f4e6c0');
    primer.addColorStop(1, 'rgba(244,230,192,0)');
    ctx.fillStyle = primer;
    ctx.fillRect(0, 110, 128, 18);
  });
}

/** Tracer streak: bright at the bullet end (v=1) fading down the tail. */
function tracerTexture(): THREE.CanvasTexture {
  return canvasTexture(32, 128, (ctx) => {
    const grad = ctx.createLinearGradient(0, 128, 0, 0);
    grad.addColorStop(0.0, 'rgba(255,240,190,0)');
    grad.addColorStop(0.55, 'rgba(255,210,120,0.55)');
    grad.addColorStop(0.88, 'rgba(255,236,180,1)');
    grad.addColorStop(1.0, 'rgba(255,255,230,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 32, 128);
    // soften across the width
    const side = ctx.createLinearGradient(0, 0, 32, 0);
    side.addColorStop(0, 'rgba(0,0,0,1)');
    side.addColorStop(0.5, 'rgba(0,0,0,0)');
    side.addColorStop(1, 'rgba(0,0,0,1)');
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = side;
    ctx.fillRect(0, 0, 32, 128);
  });
}

/** Muzzle flash: hot core + random tapered spikes. */
function flashTexture(): THREE.CanvasTexture {
  return canvasTexture(128, 128, (ctx) => {
    ctx.translate(64, 64);
    // spikes first (behind the core)
    for (let i = 0; i < 7; i++) {
      const angle = (i / 7) * Math.PI * 2 + Math.random() * 0.5;
      const len = 34 + Math.random() * 26;
      const w = 4 + Math.random() * 5;
      ctx.rotate(angle);
      const spike = ctx.createLinearGradient(0, 0, len, 0);
      spike.addColorStop(0, 'rgba(255,220,120,0.95)');
      spike.addColorStop(1, 'rgba(255,120,20,0)');
      ctx.fillStyle = spike;
      ctx.beginPath();
      ctx.moveTo(0, -w);
      ctx.lineTo(len, 0);
      ctx.lineTo(0, w);
      ctx.closePath();
      ctx.fill();
      ctx.rotate(-angle);
    }
    // hot core
    const core = ctx.createRadialGradient(0, 0, 2, 0, 0, 30);
    core.addColorStop(0, 'rgba(255,255,235,1)');
    core.addColorStop(0.35, 'rgba(255,214,110,0.9)');
    core.addColorStop(0.7, 'rgba(255,130,30,0.45)');
    core.addColorStop(1, 'rgba(255,90,10,0)');
    ctx.fillStyle = core;
    ctx.beginPath();
    ctx.arc(0, 0, 30, 0, Math.PI * 2);
    ctx.fill();
  });
}

/** Soft grey smoke puff. */
function smokeTexture(): THREE.CanvasTexture {
  return canvasTexture(128, 128, (ctx) => {
    const grad = ctx.createRadialGradient(64, 64, 6, 64, 64, 60);
    grad.addColorStop(0, 'rgba(210,206,198,0.55)');
    grad.addColorStop(0.55, 'rgba(190,188,182,0.28)');
    grad.addColorStop(1, 'rgba(180,180,178,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 128, 128);
    // break up the perfect circle a little
    for (let i = 0; i < 10; i++) {
      const x = 30 + Math.random() * 68;
      const y = 30 + Math.random() * 68;
      const r = 10 + Math.random() * 22;
      const puff = ctx.createRadialGradient(x, y, 1, x, y, r);
      puff.addColorStop(0, 'rgba(215,212,205,0.20)');
      puff.addColorStop(1, 'rgba(215,212,205,0)');
      ctx.fillStyle = puff;
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
    }
  });
}

/** Soft dot for spark points. */
function sparkTexture(): THREE.CanvasTexture {
  return canvasTexture(32, 32, (ctx) => {
    const grad = ctx.createRadialGradient(16, 16, 1, 16, 16, 15);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.4, 'rgba(255,255,255,0.7)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 32, 32);
  });
}

/* ------------------------------ geometry --------------------------------- */

/** FMJ bullet profile (lathe, radius/y before the rotateX to +Z). */
function bulletGeometry(): THREE.LatheGeometry {
  const pts: THREE.Vector2[] = [
    new THREE.Vector2(0.0, 0.0), // flat base centre
    new THREE.Vector2(1.3, 0.0), // base rim
    new THREE.Vector2(1.3, 0.4),
    new THREE.Vector2(1.16, 3.2), // cartridge body taper
    new THREE.Vector2(1.16, 3.5), // case mouth
    new THREE.Vector2(1.28, 3.75), // jacket seat ring
    new THREE.Vector2(1.08, 4.1), // nose start
  ];
  // ogive curve to the tip
  for (let i = 1; i <= 6; i++) {
    const t = i / 6;
    pts.push(new THREE.Vector2(1.08 * (1 - Math.pow(t, 1.6)), 4.1 + 2.1 * t));
  }
  const geo = new THREE.LatheGeometry(pts, 14);
  geo.rotateX(Math.PI / 2); // tip now points +Z (flight axis)
  return geo;
}

function tracerGeometry(): THREE.PlaneGeometry {
  const geo = new THREE.PlaneGeometry(TRACER_W, TRACER_L);
  geo.rotateX(Math.PI / 2); // lies along Z, bright end (v=1) at +Z
  geo.translate(0, 0, -TRACER_L / 2 + 0.6); // front edge at the bullet tail
  return geo;
}

/* ------------------------------- types ----------------------------------- */

interface FlyingBullet {
  group: THREE.Group;
  vel: THREE.Vector3;
  life: number;
  active: boolean;
}

interface FlashQuad {
  mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  spin: number;
  age: number;
  active: boolean;
}

interface SmokePuff {
  sprite: THREE.Sprite;
  age: number;
  life: number;
  rise: number;
  drift: THREE.Vector3;
  spin: number;
  active: boolean;
}

export interface BulletSystem {
  /** Spawn a full shot package (bullet + tracer + flash + sparks + smoke). */
  fireFrom(origin: THREE.Vector3, dir: THREE.Vector3): void;
  /** Advance bullets + every VFX pool. Call once per frame. */
  update(dt: number, camera: THREE.Camera): void;
  /** Verification helper: <1 slows bullets down (VFX unaffected). */
  setSlowmo(factor: number): void;
  stats(): { flying: number; sparks: number; smoke: number; flashes: number };
  dispose(): void;
}

/* ------------------------------- system ---------------------------------- */

export function createBulletSystem(
  scene: THREE.Scene,
  opts: { lowSpec?: boolean; heightAt?: (x: number, z: number) => number } = {}
): BulletSystem {
  const low = opts.lowSpec === true;
  const heightAt = opts.heightAt ?? (() => 0);

  const bulletTex = bulletJacketTexture();
  const tracerTex = tracerTexture();
  const flashTex = flashTexture();
  const smokeTex = smokeTexture();
  const sparkTex = sparkTexture();

  /* ----- bullets ----- */
  const bulletGeo = bulletGeometry();
  const tracerGeo = tracerGeometry();
  const tracerMat = new THREE.MeshBasicMaterial({
    map: tracerTex,
    transparent: true,
    opacity: TRACER_OPACITY,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: false,
  });
  const bulletMat = new THREE.MeshStandardMaterial({
    map: bulletTex,
    metalness: 0.85,
    roughness: 0.3,
    emissive: new THREE.Color(0x38200a),
    emissiveIntensity: 0.55,
  });

  const bulletPoolSize = low ? BULLET_POOL_LOW : BULLET_POOL;
  const bullets: FlyingBullet[] = [];
  for (let i = 0; i < bulletPoolSize; i++) {
    const group = new THREE.Group();
    const round = new THREE.Mesh(bulletGeo, bulletMat);
    round.frustumCulled = false;
    group.add(round);
    for (const spin of [0, Math.PI / 2]) {
      const tracer = new THREE.Mesh(tracerGeo, tracerMat);
      tracer.rotation.z = spin;
      tracer.frustumCulled = false;
      group.add(tracer);
    }
    group.visible = false;
    scene.add(group);
    bullets.push({
      group,
      vel: new THREE.Vector3(),
      life: 0,
      active: false,
    });
  }
  let bulletCursor = 0;

  /* ----- muzzle flashes ----- */
  const flashGeo = new THREE.PlaneGeometry(1, 1);
  const flashPoolSize = Math.max(FLASH_POOL, low ? 2 : FLASH_POOL);
  const flashes: FlashQuad[] = [];
  for (let i = 0; i < flashPoolSize; i++) {
    const mat = new THREE.MeshBasicMaterial({
      map: flashTex,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    });
    const mesh = new THREE.Mesh(flashGeo, mat);
    mesh.visible = false;
    mesh.frustumCulled = false;
    scene.add(mesh);
    flashes.push({ mesh, spin: 0, age: 0, active: false });
  }
  let flashCursor = 0;

  /* ----- sparks (single Points pool) ----- */
  const sparkMax = low ? SPARK_POOL_LOW : SPARK_POOL;
  const sparkPos = new Float32Array(sparkMax * 3);
  const sparkCol = new Float32Array(sparkMax * 3);
  const sparkVel = new Float32Array(sparkMax * 3);
  const sparkLife = new Float32Array(sparkMax);
  const sparkMaxLife = new Float32Array(sparkMax);
  for (let i = 0; i < sparkMax; i++) {
    sparkPos[i * 3 + 1] = -1e5; // parked underground
  }
  const sparkGeo = new THREE.BufferGeometry();
  sparkGeo.setAttribute('position', new THREE.BufferAttribute(sparkPos, 3));
  sparkGeo.setAttribute('color', new THREE.BufferAttribute(sparkCol, 3));
  const sparkMat = new THREE.PointsMaterial({
    size: SPARK_SIZE,
    map: sparkTex,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexColors: true,
    sizeAttenuation: true,
    fog: false,
  });
  const sparkPoints = new THREE.Points(sparkGeo, sparkMat);
  sparkPoints.frustumCulled = false;
  sparkPoints.renderOrder = 5;
  scene.add(sparkPoints);
  let sparkCursor = 0;

  function sparkBurst(
    origin: THREE.Vector3,
    dir: THREE.Vector3,
    count: number,
    speedScale = 1
  ) {
    for (let n = 0; n < count; n++) {
      const i = sparkCursor;
      sparkCursor = (sparkCursor + 1) % sparkMax;
      // cone around dir with tangential scatter
      const speed =
        (SPARK_SPEED_MIN + Math.random() * (SPARK_SPEED_MAX - SPARK_SPEED_MIN)) *
        speedScale;
      const px = (Math.random() - 0.5) * 2 * SPARK_SPREAD;
      const py = (Math.random() - 0.5) * 2 * SPARK_SPREAD;
      const vel = new THREE.Vector3(
        dir.x + px,
        dir.y + py + 0.18, // slight upward bias -> arcs read better
        dir.z + (Math.random() - 0.5) * 2 * SPARK_SPREAD
      )
        .normalize()
        .multiplyScalar(speed);
      sparkPos[i * 3] = origin.x;
      sparkPos[i * 3 + 1] = origin.y;
      sparkPos[i * 3 + 2] = origin.z;
      sparkVel[i * 3] = vel.x;
      sparkVel[i * 3 + 1] = vel.y;
      sparkVel[i * 3 + 2] = vel.z;
      const life = SPARK_LIFE_MIN + Math.random() * (SPARK_LIFE_MAX - SPARK_LIFE_MIN);
      sparkLife[i] = life;
      sparkMaxLife[i] = life;
      // hot white-yellow -> orange mix
      const hot = Math.random();
      sparkCol[i * 3] = 1.0;
      sparkCol[i * 3 + 1] = 0.75 + hot * 0.25;
      sparkCol[i * 3 + 2] = 0.25 + hot * 0.45;
    }
  }

  /* ----- smoke sprites ----- */
  const smokePoolSize = low ? SMOKE_POOL_LOW : SMOKE_POOL;
  const smokeBaseMat = new THREE.SpriteMaterial({
    map: smokeTex,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    color: new THREE.Color(0xcac6be),
  });
  const smoke: SmokePuff[] = [];
  for (let i = 0; i < smokePoolSize; i++) {
    const mat = smokeBaseMat.clone();
    const sprite = new THREE.Sprite(mat);
    sprite.visible = false;
    scene.add(sprite);
    smoke.push({
      sprite,
      age: 0,
      life: SMOKE_LIFE,
      rise: SMOKE_RISE,
      drift: new THREE.Vector3(),
      spin: 0,
      active: false,
    });
  }
  let smokeCursor = 0;

  function smokePuff(origin: THREE.Vector3, scale: number) {
    const s = smoke[smokeCursor];
    smokeCursor = (smokeCursor + 1) % smokePoolSize;
    s.sprite.position.copy(origin);
    s.sprite.material.opacity = SMOKE_OPACITY;
    s.sprite.material.rotation = Math.random() * Math.PI * 2;
    s.sprite.scale.setScalar(SMOKE_SCALE_START * scale);
    s.age = 0;
    s.life = SMOKE_LIFE * (0.8 + Math.random() * 0.4);
    s.rise = SMOKE_RISE * (0.7 + Math.random() * 0.6);
    s.drift.set((Math.random() - 0.5) * 14, 0, (Math.random() - 0.5) * 14);
    s.spin = (Math.random() - 0.5) * 1.6;
    s.sprite.visible = true;
    s.active = true;
  }

  /* ----- shot package ----- */
  const tmpQuat = new THREE.Quaternion();
  const tmpDir = new THREE.Vector3();
  const FORWARD = new THREE.Vector3(0, 0, 1);

  function fireFrom(origin: THREE.Vector3, dirIn: THREE.Vector3) {
    const dir = tmpDir.copy(dirIn).normalize();

    // bullet (+ tracer) from the pool — recycle the oldest if exhausted
    let b: FlyingBullet | null = null;
    for (const cand of bullets) {
      if (!cand.active) {
        b = cand;
        break;
      }
    }
    if (!b) {
      b = bullets[bulletCursor];
      bulletCursor = (bulletCursor + 1) % bullets.length;
    }
    b.group.position.copy(origin);
    b.vel.copy(dir).multiplyScalar(BULLET_SPEED);
    b.life = BULLET_LIFE;
    b.active = true;
    b.group.visible = true;
    tmpQuat.setFromUnitVectors(FORWARD, dir);
    b.group.quaternion.copy(tmpQuat);

    // muzzle flash quads
    const flashCount = low ? FLASH_PER_SHOT_LOW : FLASH_PER_SHOT;
    for (let n = 0; n < flashCount; n++) {
      const f = flashes[flashCursor];
      flashCursor = (flashCursor + 1) % flashes.length;
      f.mesh.position.copy(origin).addScaledVector(dir, 4 + n * 6);
      f.mesh.scale.setScalar(FLASH_SIZE * (0.8 + Math.random() * 0.6));
      f.mesh.material.opacity = 1;
      f.spin = Math.random() * Math.PI * 2;
      f.age = 0;
      f.active = true;
      f.mesh.visible = true;
    }

    // fire + smoke
    sparkBurst(origin, dir, low ? SPARKS_PER_SHOT_LOW : SPARKS_PER_SHOT);
    const puffs = low ? SMOKE_PER_SHOT_LOW : SMOKE_PER_SHOT;
    for (let n = 0; n < puffs; n++) {
      smokePuff(
        new THREE.Vector3(
          origin.x - dir.x * 6 + (Math.random() - 0.5) * 4,
          origin.y + 2 + n * 2,
          origin.z - dir.z * 6 + (Math.random() - 0.5) * 4
        ),
        0.8 + Math.random() * 0.5
      );
    }
  }

  /* ----- per-frame update ----- */
  function update(dt: number, camera: THREE.Camera) {
    // bullets (slowmo scales ONLY the round so screenshots can catch it)
    const bdt = dt * slowmo;
    for (const b of bullets) {
      if (!b.active) continue;
      b.vel.y -= BULLET_GRAVITY * bdt;
      b.group.position.addScaledVector(b.vel, bdt);
      b.life -= bdt;
      // orient the round + tracer along the current velocity
      tmpDir.copy(b.vel).normalize();
      tmpQuat.setFromUnitVectors(FORWARD, tmpDir);
      b.group.quaternion.copy(tmpQuat);

      const p = b.group.position;
      const ground = heightAt(p.x, p.z);
      const out =
        Math.abs(p.x) > WORLD_LIMIT || Math.abs(p.z) > WORLD_LIMIT;
      if (b.life <= 0 || out || (b.vel.y <= 0 && p.y <= ground + 1)) {
        b.active = false;
        b.group.visible = false;
        if (!out) {
          // terrain impact: fire kicks BACK toward the shooter (+ up)
          tmpDir
            .set(-b.vel.x, 0, -b.vel.z)
            .normalize()
            .multiplyScalar(0.85);
          tmpDir.y = 0.75;
          tmpDir.normalize();
          sparkBurst(
            p,
            tmpDir,
            low ? SPARKS_PER_IMPACT_LOW : SPARKS_PER_IMPACT,
            0.55
          );
          smokePuff(p, 1.15);
        }
      }
    }

    // flashes: pop outward, face the camera, fade fast
    for (const f of flashes) {
      if (!f.active) continue;
      f.age += dt;
      const k = f.age / FLASH_LIFE;
      if (k >= 1) {
        f.active = false;
        f.mesh.visible = false;
        continue;
      }
      f.mesh.material.opacity = 1 - k;
      f.mesh.quaternion.copy(camera.quaternion);
      f.mesh.rotateZ(f.spin);
      f.mesh.scale.multiplyScalar(1 + 3.2 * dt);
    }

    // sparks: ballistic + fade to black (additive black = gone)
    let sparksDirty = false;
    for (let i = 0; i < sparkMax; i++) {
      if (sparkLife[i] <= 0) continue;
      sparksDirty = true;
      sparkLife[i] -= dt;
      const i3 = i * 3;
      if (sparkLife[i] <= 0) {
        sparkLife[i] = 0;
        sparkCol[i3] = 0;
        sparkCol[i3 + 1] = 0;
        sparkCol[i3 + 2] = 0;
        sparkPos[i3 + 1] = -1e5;
        continue;
      }
      sparkVel[i3 + 1] -= SPARK_GRAVITY * dt;
      sparkPos[i3] += sparkVel[i3] * dt;
      sparkPos[i3 + 1] += sparkVel[i3 + 1] * dt;
      sparkPos[i3 + 2] += sparkVel[i3 + 2] * dt;
      const fade = sparkLife[i] / sparkMaxLife[i];
      const flicker = 0.75 + Math.random() * 0.25;
      sparkCol[i3] = fade * flicker;
      sparkCol[i3 + 1] = fade * (0.55 + flicker * 0.3);
      sparkCol[i3 + 2] = fade * 0.2;
    }
    if (sparksDirty) {
      sparkGeo.attributes.position.needsUpdate = true;
      sparkGeo.attributes.color.needsUpdate = true;
    }

    // smoke: rise, drift, expand, fade
    for (const s of smoke) {
      if (!s.active) continue;
      s.age += dt;
      const k = s.age / s.life;
      if (k >= 1) {
        s.active = false;
        s.sprite.visible = false;
        continue;
      }
      s.sprite.position.y += s.rise * dt;
      s.sprite.position.x += s.drift.x * dt;
      s.sprite.position.z += s.drift.z * dt;
      s.sprite.material.rotation += s.spin * dt;
      s.sprite.material.opacity = SMOKE_OPACITY * (1 - k);
      s.sprite.scale.setScalar(
        SMOKE_SCALE_START + SMOKE_SCALE_GROW * Math.sqrt(k)
      );
    }
  }

  let slowmo = 1;

  function setSlowmo(factor: number) {
    // implemented as a time scale on the bullet only
    slowmo = Math.max(0.01, factor);
  }

  function stats() {
    return {
      flying: bullets.reduce((n, b) => n + (b.active ? 1 : 0), 0),
      sparks: sparkLife.reduce(
        (n, l, i) => n + (l > 0 && sparkPos[i * 3 + 1] > -1e4 ? 1 : 0),
        0
      ),
      smoke: smoke.reduce((n, s) => n + (s.active ? 1 : 0), 0),
      flashes: flashes.reduce((n, f) => n + (f.active ? 1 : 0), 0),
    };
  }

  function dispose() {
    for (const b of bullets) scene.remove(b.group);
    for (const f of flashes) scene.remove(f.mesh);
    scene.remove(sparkPoints);
    for (const s of smoke) scene.remove(s.sprite);
    bulletGeo.dispose();
    tracerGeo.dispose();
    tracerMat.dispose();
    bulletMat.dispose();
    bulletTex.dispose();
    tracerTex.dispose();
    flashTex.dispose();
    smokeTex.dispose();
    sparkTex.dispose();
    flashGeo.dispose();
    for (const f of flashes) f.mesh.material.dispose();
    sparkGeo.dispose();
    sparkMat.dispose();
    smokeBaseMat.dispose();
    for (const s of smoke) s.sprite.material.dispose();
  }

  return { fireFrom, update, setSlowmo, stats, dispose };
}
