// Бегущая поклонница: тот же скелет, что у велосипедиста, но анимация бега.
// Модель сделана по картинке через TRELLIS.2; бег отлаживался на манекене — стоячей модели Дани.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { buildCharacter, riderWeights, RIDER_JOINTS, solveTwoBone, aimBone, side, sideBase, V, damp, quat } from './hero.js';

// ---------- Поклонница: суставы и веса под её модель ----------
// Модель: рост = 1, лицом в +Z; платье-колокол до середины бедра, хвост сзади справа.
const WOMAN_JOINTS = {
  pelvis: V(0, -0.03, 0.05), chest: V(0, 0.08, 0.06), head: V(0, 0.2, 0.03),
  shoulder: V(0.125, 0.135, 0.06), elbow: V(0.212, 0.058, 0.06), wrist: V(0.3, -0.02, 0.06),
  hip: V(0.07, -0.06, 0.045), knee: V(0.085, -0.26, 0.045), ankle: V(0.1, -0.43, 0.04),
};
const BONE = { pelvis: 0, chest: 1, head: 2 };
const smooth = (a, b, v) => THREE.MathUtils.smoothstep(v, Math.min(a, b), Math.max(a, b));
const ramp = (from, to, v) => (from < to ? smooth(from, to, v) : 1 - smooth(to, from, v));
function womanWeights(x, y, z) {
  const J = WOMAN_JOINTS, s = x >= 0 ? 1 : -1, o = sideBase(s), ax = Math.abs(x);
  if (z < -0.055 && y > 0.14) return [[BONE.head, 1]];               // хвост и затылок — вместе с головой
  // рука: проекция на ось плечо → кисть
  const armLen = J.shoulder.distanceTo(J.wrist), elbowT = J.shoulder.distanceTo(J.elbow);
  const dx = (J.wrist.x - J.shoulder.x) / armLen, dy = (J.wrist.y - J.shoulder.y) / armLen;
  const px = ax - J.shoulder.x, py = y - J.shoulder.y;
  const t = px * dx + py * dy, rho = Math.hypot(px - t * dx, py - t * dy, z - J.shoulder.z);
  const isArm = (ax > 0.17 && y > -0.12 && y < 0.2) || (rho < 0.06 && t > 0 && ax > 0.11 && y > 0.02 && y < 0.19);
  if (isArm) {
    const wArm = smooth(-0.01, 0.035, t), wFore = smooth(elbowT - 0.025, elbowT + 0.025, t);
    return [[BONE.chest, 1 - wArm], [o, wArm * (1 - wFore)], [o + 1, wArm * wFore]];
  }
  if (y > 0.185) {
    const wHead = y > 0.215 ? 1 : ax < 0.06 ? smooth(0.185, 0.215, y) : 0;
    return [[BONE.chest, 1 - wHead], [BONE.head, wHead]];
  }
  // ноги ниже подола; бедро под юбкой, поэтому стык с тазом не виден.
  // У самого подола берём только точки рядом с осью ноги — иначе край юбки тянется за бедром.
  if (y < -0.185 || (y < -0.14 && Math.hypot(ax - 0.075, z - 0.045) < 0.038)) {
    const wShin = ramp(-0.24, -0.28, y), wFoot = ramp(-0.42, -0.45, y);
    return [[o + 2, 1 - wShin], [o + 3, wShin * (1 - wFoot)], [o + 4, wShin * wFoot]];
  }
  const wChest = smooth(0.0, 0.1, y);                                // юбка целиком держится за таз
  return [[BONE.pelvis, 1 - wChest], [BONE.chest, wChest]];
}

export const CHASER = {
  ready: true,                          // false — в игре остаётся фигурка из простых фигур
  url: 'models/chaser/woman.glb',
  joints: WOMAN_JOINTS,
  weights: womanWeights,
  height: 1.62,                         // рост в метрах
};
// запасной манекен (стоячая модель Дани) — на нём отлаживался бег
export const MANNEQUIN = { url: 'models/hero/rider.glb', joints: RIDER_JOINTS, weights: riderWeights, height: 1.7 };

export const RUN = {
  stepsPerSecond: 3.1,   // частота шагов
  stride: 0.15,          // полудлина шага (в долях роста)
  lift: 0.15,            // высота подъёма стопы в переносе
  crouch: 0.03,          // насколько присажена в беге
  bob: 0.016,            // подпрыгивание таза
  lean: 12,              // наклон корпуса вперёд, градусы
  armSwing: 0.12,        // размах рук
  reach: 0.3,            // как далеко тянет руки к Дане, когда близко
};

export async function loadChaser() {
  const gltf = await new GLTFLoader().loadAsync(CHASER.url);
  const J = CHASER.joints;
  const body = buildCharacter(gltf.scene, { joints: J, weights: CHASER.weights, scale: CHASER.height });
  const group = new THREE.Group();          // смотрит в +Z, ступни на y = 0
  body.group.position.y = 0.5 * CHASER.height;
  group.add(body.group);

  const [bPelvis, bChest, bHead] = body.bones;
  const limbs = {};
  for (const s of [1, -1]) {
    const o = sideBase(s);
    const [upper, fore, thigh, shin, foot] = [0, 1, 2, 3, 4].map((k) => body.bones[o + k]);
    limbs[s] = { upper, fore, thigh, shin, foot, armHalf: (upper.userData.len + fore.userData.len) / 2, legHalf: (thigh.userData.len + shin.userData.len) / 2 };
  }
  const st = { phase: 0, close: 0, still: 0, kneel: 0, fast: 0 }; // still: 1 — добежала и стоит; kneel: 1 — присела к упавшему

  function pose() {
    const p = st.phase, c = st.close, go = 1 - st.still; // go — доля бега в позе
    const kn = st.kneel * st.kneel * (3 - 2 * st.kneel);     // присела на корточки: таз вниз, колени вперёд, корпус к лежащему
    const f = st.fast;                                       // 0 — обычный бег на месте, 1 — рывок: шаг шире, выше, корпус ниже
    const stride = RUN.stride * (1 + 0.75 * f), lift = RUN.lift * (1 + 0.6 * f);
    const lean = (RUN.lean + c * 6 + 10 * f) * (0.25 + 0.75 * go) + 34 * kn;
    // таз подпрыгивает дважды за цикл и слегка разворачивается за шагающей ногой
    const pelvisPos = J.pelvis.clone().add(V(0, (-RUN.crouch + RUN.bob * (1 + f) * Math.cos(2 * p)) * go - 0.2 * kn, -0.05 * kn));
    const qPelvis = quat(-0.14 * Math.sin(p), 0.04 * Math.sin(p), lean * 0.6);
    const qChest = quat(0.22 * Math.sin(p) * (1 - c * 0.7), -0.03 * Math.sin(p), lean * 1.2);
    const qHead = quat(0, 0, 2 - c * 10 * (1 - kn) + 30 * kn); // когда близко — задирает голову, смотрит на Даню
    const chestPos = pelvisPos.clone().add(J.chest.clone().sub(J.pelvis).applyQuaternion(qPelvis));
    const headPos = chestPos.clone().add(J.head.clone().sub(J.chest).applyQuaternion(qChest));
    bPelvis.position.copy(pelvisPos); bPelvis.quaternion.copy(qPelvis);
    bChest.position.copy(chestPos); bChest.quaternion.copy(qChest);
    bHead.position.copy(headPos); bHead.quaternion.copy(qHead);

    for (const s of [1, -1]) {
      const L = limbs[s];
      const ps = p + (s > 0 ? 0 : Math.PI);          // ноги в противофазе
      const sin = Math.sin(ps), cos = Math.cos(ps);
      // нога: по земле едет назад (опора), по воздуху возвращается вперёд (перенос)
      const hip = pelvisPos.clone().add(side(J.hip, s).sub(J.pelvis).applyQuaternion(qPelvis));
      const ankle = V(s * J.ankle.x * 0.85, J.ankle.y + (lift * Math.max(0, cos) ** 0.8 + 0.05 * Math.max(0, -sin) * Math.max(0, cos)) * go, J.ankle.z + stride * sin * go);
      const leg = solveTwoBone(hip, ankle, L.legHalf, L.legHalf, V(s * 0.1, 0.15, 1));
      aimBone(L.thigh, hip, leg.mid, L.legHalf);
      aimBone(L.shin, leg.mid, leg.end, L.legHalf);
      L.foot.position.copy(leg.end);
      L.foot.quaternion.copy(quat(0, 0, (32 * Math.max(0, -sin) - 14 * Math.max(0, sin)) * go)); // носок вниз при толчке, вверх при постановке
      // рука: согнута в локте и машет в противоход ноге; когда близко — тянется вперёд
      const shoulder = chestPos.clone().add(side(J.shoulder, s).sub(J.chest).applyQuaternion(qChest));
      const swing = -sin;
      const running = shoulder.clone().add(V(s * 0.03, -0.17 + 0.05 * swing, 0.09 + RUN.armSwing * (1 + 0.6 * f) * swing));
      const reaching = shoulder.clone().add(V(-s * 0.03 - s * 0.03 * kn, 0.03 + 0.025 * Math.sin(p * 2 + s) * (1 - kn) - (0.2 + 0.012 * Math.sin(st.idle * 2.2 + s)) * kn, RUN.reach - 0.08 * kn));
      const wrist = running.lerp(reaching, c);
      const arm = solveTwoBone(shoulder, wrist, L.armHalf, L.armHalf, V(s * 0.25, -0.4, -1).lerp(V(s * 0.5, -1, 0), c));
      aimBone(L.upper, shoulder, arm.mid, L.armHalf);
      aimBone(L.fore, arm.mid, arm.end, L.armHalf);
    }
  }
  // close — насколько она близко к Дане (0..1): бежит быстрее и тянет руки
  // speed — с какой скоростью она на самом деле бежит по земле (м/с); по ней подбирается частота и длина шага, чтобы ноги не скользили
  function update(dt, { close = 0, still = 0, kneel = 0, speed = null } = {}) {
    const fast = speed === null ? 0 : THREE.MathUtils.clamp((speed - 2) / 5, 0, 1);
    st.fast = damp(st.fast, fast, 6, dt);
    st.idle = (st.idle ?? 0) + dt;
    st.kneel = damp(st.kneel, kneel, 5, dt);
    st.close = damp(st.close, close, 5, dt);
    st.still = damp(st.still, still, 6, dt);
    // за один цикл (два шага) нога проходит по земле 4 длины полушага; в рывке добавляется фаза полёта — ещё около 40% пути
    const cycle = 4 * RUN.stride * (1 + 0.75 * st.fast) * CHASER.height * (1 + 0.4 * st.fast);
    const rate = speed === null ? Math.PI * RUN.stepsPerSecond * (1 + 0.25 * st.close) : Math.min(2 * Math.PI * speed / cycle, Math.PI * 5.6);
    st.phase += dt * rate * (1 - st.still);
    pose();
  }
  pose();
  return { group, update, pose, state: st };
}
