// Герой: велосипедист на шоссейном велосипеде.
// Две цельные модели (персонаж в позе стоя и велосипед) превращаются в анимированного ездока:
//  - велосипед режется на раму, колёса, шатуны и педали, которые вращаются;
//  - персонажу кодом ставится скелет, он сажается в седло, ноги следуют за педалями.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const X_AXIS = V(1, 0, 0), Y_AXIS = V(0, 1, 0);
const rotX = (deg) => new THREE.Quaternion().setFromAxisAngle(X_AXIS, THREE.MathUtils.degToRad(deg));
const smooth = (a, b, v) => THREE.MathUtils.smoothstep(v, Math.min(a, b), Math.max(a, b));
const ramp = (from, to, v) => (from < to ? smooth(from, to, v) : 1 - smooth(to, from, v)); // 0 у from, 1 у to

// ---------- Настройки посадки (подбираются на глаз) ----------
export const TUNE = {
  bikeScale: 1.6,        // длина велосипеда в метрах
  riderScale: 1.8,       // рост персонажа в метрах
  seatUp: 0.035,         // насколько таз выше седла (в долях роста)
  seatForward: 0.0,      // сдвиг таза вперёд по седлу
  leanPelvis: 30,        // наклон таза вперёд, градусы
  leanChest: 63,         // наклон груди вперёд (руки в нижнем хвате)
  leanHead: 8,           // наклон головы (меньше — смотрит выше)
  ankleUp: 0.075,        // высота щиколотки над педалью (в долях роста)
  ankleBack: 0.055,      // щиколотка позади оси педали
  legStraight: 0.95,     // насколько выпрямляется нога в нижней точке (1 — полностью)
  armStraight: 0.93,
  handUp: 0.0, handLen: 0.05, // кисть: подъём над рулём и длина от запястья до середины ладони
  cadence: 0.42,         // оборотов шатуна (в радианах) на метр пути
  // --- живость ---
  standUp: 0.11, standForward: 0.07,       // куда смещается таз, когда встаёт с седла (в долях роста)
  standLeanPelvis: 10, standLeanChest: 6,  // дополнительный наклон стоя, градусы
  standEvery: [9, 17], standFor: [2.2, 3.6], // раз во сколько секунд встаёт сам и на сколько
  rock: 0.11,            // раскачивание велосипеда при езде стоя, радианы
  sway: 0.035,           // покачивание корпуса при езде сидя
  bodyLean: 0.03,        // наклон корпуса в поворот (на м/с боковой скорости)
  signalTime: 0.75,      // сколько секунд держит руку в сторону при перестроении
  landDip: 1.1,          // сила приседания при приземлении
  crashForward: 4.8,     // с какой скоростью (м/с) вылетает вперёд при аварии
  crashAside: 1.0,       // насколько отлетает вбок (в долях роста)
  tuckPelvis: 6, tuckChest: 14, tuckHead: 14,
  duckPelvis: 6, duckChest: 13, duckHead: 55, // пригнуться под шлагбаум: ещё ниже, голова опущена // аэропосадка на скорости: насколько сильнее наклон, градусы
};

// ---------- Размеры велосипеда (в единицах модели, длина = 1, перёд смотрит в +Z) ----------
const B = {
  bottom: -0.309,
  wheelR: 0.222, wheelY: -0.0875, wheelZ: 0.279, wheelCutW: 0.028, tireR: 0.017,
  bb: V(0, -0.135, -0.039),          // ось каретки, вокруг неё крутятся шатуны
  crankReach: 0.135, crankXL: -0.042, crankXR: 0.047, pedalX: 0.07,
  saddle: V(0, 0.303, -0.19),
  drop: V(0.13, 0.155, 0.235),       // нижний хват руля («рога»), за него держится ездок
};

// ---------- Суставы персонажа (в единицах модели, рост = 1, лицом в +Z; для стороны +X) ----------
const J = {
  pelvis: V(0, -0.10, -0.005), chest: V(0, 0.04, 0), head: V(0, 0.225, 0),
  shoulder: V(0.115, 0.185, 0), elbow: V(0.218, 0.072, 0), wrist: V(0.32, -0.04, 0),
  hip: V(0.06, -0.11, -0.01), knee: V(0.085, -0.27, -0.03), ankle: V(0.105, -0.43, -0.035),
};
const side = (v, s) => V(v.x * s, v.y, v.z);
const BONE = { pelvis: 0, chest: 1, head: 2 };
const sideBase = (s) => (s > 0 ? 3 : 8); // +0 плечо, +1 предплечье, +2 бедро, +3 голень, +4 стопа

// ---------- Велосипед: разрезка на части ----------
function subGeometry(src, indices) {
  const g = new THREE.BufferGeometry();
  for (const name of Object.keys(src.attributes)) g.setAttribute(name, src.attributes[name]);
  g.setIndex(indices);
  return g;
}
function textureBrightness(map) { // функция: яркость текстуры (0..1) в точке u, v
  if (!map || !map.image) return () => 0;
  const w = map.image.width, h = map.image.height;
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(map.image, 0, 0);
  const px = ctx.getImageData(0, 0, w, h).data;
  return (u, v) => {
    const x = Math.min(w - 1, Math.max(0, Math.floor(u * w))), y = Math.min(h - 1, Math.max(0, Math.floor((map.flipY ? 1 - v : v) * h)));
    const i = (y * w + x) * 4;
    return (px[i] * 0.3 + px[i + 1] * 0.59 + px[i + 2] * 0.11) / 255;
  };
}
function makeWheel() { // ровное колесо в единицах модели велосипеда, ось вращения — X
  const g = new THREE.Group();
  const black = new THREE.MeshStandardMaterial({ color: 0x17171a, roughness: 0.85 });
  const steel = new THREE.MeshStandardMaterial({ color: 0x9a9fa6, roughness: 0.5, metalness: 0.4 });
  const ringR = B.wheelR - B.tireR;
  const tire = new THREE.Mesh(new THREE.TorusGeometry(ringR, B.tireR, 7, 22), black);
  tire.rotation.y = Math.PI / 2;
  const rim = new THREE.Mesh(new THREE.TorusGeometry(ringR - B.tireR - 0.004, 0.007, 5, 22), black);
  rim.rotation.y = Math.PI / 2;
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.011, 0.011, 0.05, 8), black);
  hub.rotation.z = Math.PI / 2;
  g.add(tire, rim, hub);
  const spokeLen = (ringR - B.tireR) * 2;
  for (let i = 0; i < 8; i++) { // 8 спиц насквозь = 16 лучей
    const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.003, spokeLen, 0.003), steel);
    spoke.rotation.x = (i / 8) * Math.PI;
    spoke.position.x = i % 2 ? 0.005 : -0.005;
    g.add(spoke);
  }
  // диск-«смаз»: проявляется на скорости
  const blur = new THREE.Mesh(new THREE.CircleGeometry(ringR - B.tireR, 22), new THREE.MeshBasicMaterial({ color: 0xaab0b8, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false }));
  blur.rotation.y = Math.PI / 2;
  g.add(blur);
  steel.transparent = true;
  g.userData = { blur, spokes: steel };
  return g;
}
function buildBike(scene) {
  let mesh;
  scene.traverse((o) => { if (o.isMesh) mesh = o; });
  const geo = mesh.geometry, pos = geo.attributes.position, uv = geo.attributes.uv, idx = geo.index;
  const brightness = textureBrightness(mesh.material.map);
  const parts = { frame: [], wheelF: [], wheelR: [], crank: [], pedalP: [], pedalN: [] };
  const p = [V(), V(), V()];
  for (let i = 0; i < idx.count; i += 3) {
    const ids = [idx.getX(i), idx.getX(i + 1), idx.getX(i + 2)];
    ids.forEach((id, k) => p[k].fromBufferAttribute(pos, id));
    const all = (fn) => fn(p[0]) && fn(p[1]) && fn(p[2]);
    let part = 'frame';
    // Родные колёса модели неровные, поэтому вырезаем их целиком и ставим свои, идеально круглые.
    // Вырезаем только тёмное (покрышка, спицы) и только в узком слое — вилка и белая рама остаются.
    const inWheel = (cz) => (v) => Math.abs(v.x) < B.wheelCutW && Math.hypot(v.y - B.wheelY, v.z - cz) < B.wheelR * 1.02;
    const dark = () => brightness((uv.getX(ids[0]) + uv.getX(ids[1]) + uv.getX(ids[2])) / 3, (uv.getY(ids[0]) + uv.getY(ids[1]) + uv.getY(ids[2])) / 3) < 0.55;
    if (all(inWheel(B.wheelZ)) && dark()) part = 'wheelF';
    else if (all(inWheel(-B.wheelZ)) && dark()) part = 'wheelR';
    else if (all((v) => (v.x < B.crankXL || v.x > B.crankXR) && Math.hypot(v.y - B.bb.y, v.z - B.bb.z) < B.crankReach)) {
      if (all((v) => v.x > B.pedalX)) part = 'pedalP';
      else if (all((v) => v.x < -B.pedalX)) part = 'pedalN';
      else part = 'crank';
    }
    parts[part].push(...ids);
  }
  const make = (name) => new THREE.Mesh(subGeometry(geo, parts[name]), mesh.material);
  const centroid = (name) => {
    const c = V(), seen = new Set(parts[name]);
    for (const id of seen) c.add(p[0].fromBufferAttribute(pos, id));
    return c.multiplyScalar(1 / Math.max(1, seen.size));
  };
  const pivoted = (name, center) => { // группа с осью вращения в center
    const g = new THREE.Group(); g.position.copy(center);
    const m = make(name); m.position.copy(center).negate(); g.add(m);
    return g;
  };

  const group = new THREE.Group();
  group.add(make('frame'));
  const wheelF = makeWheel(); wheelF.position.set(0, B.wheelY, B.wheelZ);
  const wheelR = makeWheel(); wheelR.position.set(0, B.wheelY, -B.wheelZ);
  const crank = pivoted('crank', B.bb);
  const pedals = {};
  for (const [name, s] of [['pedalP', 1], ['pedalN', -1]]) {
    const c = centroid(name);
    const axle = V(0, c.y, c.z);
    const g = pivoted(name, axle);
    g.position.sub(B.bb);          // внутри группы шатунов
    crank.add(g);
    pedals[s] = { group: g, x: c.x, rest: V(0, c.y - B.bb.y, c.z - B.bb.z) };
  }
  group.add(wheelF, wheelR, crank);
  group.scale.setScalar(TUNE.bikeScale);
  group.position.y = -B.bottom * TUNE.bikeScale; // колёса стоят на земле
  return { group, wheelF, wheelR, crank, pedals };
}

// ---------- Персонаж: скелет и веса ----------
function skinWeights(x, y, z) {
  const s = x >= 0 ? 1 : -1, o = sideBase(s), ax = Math.abs(x);
  // рука: проекция на ось плечо → кисть
  const armLen = J.shoulder.distanceTo(J.wrist), elbowT = J.shoulder.distanceTo(J.elbow);
  const dx = (J.wrist.x - J.shoulder.x) / armLen, dy = (J.wrist.y - J.shoulder.y) / armLen;
  const px = ax - J.shoulder.x, py = y - J.shoulder.y;
  const t = px * dx + py * dy;
  const rho = Math.hypot(px - t * dx, py - t * dy, z);
  const isArm = (ax > 0.13 && y > -0.14) || (rho < 0.07 && t > 0 && ax > 0.1 && y > 0.08);
  if (isArm) {
    const wArm = smooth(-0.015, 0.035, t), wFore = smooth(elbowT - 0.03, elbowT + 0.03, t);
    return [[BONE.chest, 1 - wArm], [o, wArm * (1 - wFore)], [o + 1, wArm * wFore]];
  }
  if (y > 0.205) {
    const wHead = y > 0.24 ? 1 : ax < 0.085 ? smooth(0.205, 0.24, y) : 0;
    return [[BONE.chest, 1 - wHead], [BONE.head, wHead]];
  }
  if (y < -0.09) {
    const wLeg = ramp(-0.09, -0.15, y), wShin = ramp(-0.25, -0.29, y), wFoot = ramp(-0.42, -0.45, y);
    return [[BONE.pelvis, 1 - wLeg], [o + 2, wLeg * (1 - wShin)], [o + 3, wLeg * wShin * (1 - wFoot)], [o + 4, wLeg * wShin * wFoot]];
  }
  const wChest = smooth(-0.02, 0.1, y);
  return [[BONE.pelvis, 1 - wChest], [BONE.chest, wChest]];
}
function limbBone(from, to) { // кость, ось Y которой смотрит вдоль конечности
  const b = new THREE.Bone();
  b.position.copy(from);
  b.quaternion.setFromUnitVectors(Y_AXIS, to.clone().sub(from).normalize());
  b.userData = { q0: b.quaternion.clone(), dir: to.clone().sub(from).normalize(), len: from.distanceTo(to) };
  return b;
}
function plainBone(at) {
  const b = new THREE.Bone(); b.position.copy(at);
  b.userData = { q0: new THREE.Quaternion() };
  return b;
}
// joints и weights можно подменить — так тот же код ставит скелет другому персонажу
function buildRider(scene, { joints = J, weights = skinWeights, scale = TUNE.riderScale } = {}) {
  const J = joints;
  let src;
  scene.traverse((o) => { if (o.isMesh) src = o; });
  const geo = src.geometry.clone(), pos = geo.attributes.position;
  const si = new Uint16Array(pos.count * 4), sw = new Float32Array(pos.count * 4);
  for (let i = 0; i < pos.count; i++) {
    const w = weights(pos.getX(i), pos.getY(i), pos.getZ(i)).filter((e) => e[1] > 1e-4);
    const sum = w.reduce((a, e) => a + e[1], 0);
    w.forEach((e, k) => { si[i * 4 + k] = e[0]; sw[i * 4 + k] = e[1] / sum; });
  }
  geo.setAttribute('skinIndex', new THREE.BufferAttribute(si, 4));
  geo.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));

  const bones = [plainBone(J.pelvis), plainBone(J.chest), plainBone(J.head)];
  for (const s of [1, -1]) {
    bones.push(
      limbBone(side(J.shoulder, s), side(J.elbow, s)), limbBone(side(J.elbow, s), side(J.wrist, s)),
      limbBone(side(J.hip, s), side(J.knee, s)), limbBone(side(J.knee, s), side(J.ankle, s)),
      plainBone(side(J.ankle, s)),
    );
  }
  const group = new THREE.Group();
  bones.forEach((b) => group.add(b));       // плоский скелет: положение каждой кости считаем сами
  group.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton(bones); // запоминает исходную позу
  const mesh = new THREE.SkinnedMesh(geo, src.material);
  mesh.frustumCulled = false;
  group.add(mesh);
  mesh.bind(skeleton, new THREE.Matrix4());
  group.scale.setScalar(scale);
  return { group, bones };
}

// ---------- Обратная кинематика для двух костей (бедро+голень, плечо+предплечье) ----------
function solveTwoBone(root, target, a, b, pole) {
  const u = target.clone().sub(root);
  const len = Math.min(u.length(), a + b - 1e-4);
  u.normalize();
  const cos = THREE.MathUtils.clamp((a * a + len * len - b * b) / (2 * a * len), -1, 1);
  const w = pole.clone().addScaledVector(u, -pole.dot(u)).normalize();
  const mid = root.clone().addScaledVector(u, a * cos).addScaledVector(w, a * Math.sqrt(1 - cos * cos));
  return { mid, end: root.clone().addScaledVector(u, len) };
}
function aimBone(bone, from, to, length) {
  const d = to.clone().sub(from).normalize();
  bone.position.copy(from);
  bone.quaternion.setFromUnitVectors(bone.userData.dir, d).multiply(bone.userData.q0);
  bone.scale.set(1, length / bone.userData.len, 1); // растягиваем кость вдоль её оси
}

// общие детали скелета — ими пользуется и бегущая поклонница (runner.js)
export { buildRider as buildCharacter, skinWeights as riderWeights, J as RIDER_JOINTS, solveTwoBone, aimBone, side, sideBase, V };

// ---------- Сборка ----------
export const damp = (a, b, rate, dt) => a + (b - a) * (1 - Math.exp(-rate * dt)); // плавное приближение a к b
const rnd = ([a, b]) => a + Math.random() * (b - a);
export const quat = (yaw, roll, pitchDeg) => new THREE.Quaternion().setFromEuler(new THREE.Euler(THREE.MathUtils.degToRad(pitchDeg), yaw, roll, 'YZX'));

export async function loadHero() {
  const loader = new GLTFLoader();
  const [bikeGltf, riderGltf] = await Promise.all([loader.loadAsync('models/hero/bike.glb'), loader.loadAsync('models/hero/rider.glb')]);
  const bike = buildBike(bikeGltf.scene);
  const rider = buildRider(riderGltf.scene);
  const bikeRoll = new THREE.Group(); // раскачивание велосипеда вокруг линии касания с землёй
  bikeRoll.add(bike.group);
  const group = new THREE.Group();    // герой смотрит в +Z, колёса на y = 0
  group.add(bikeRoll, rider.group);

  const SB = TUNE.bikeScale, SR = TUNE.riderScale;
  // Состояние позы. Всё меняется плавно, отсюда ощущение веса.
  const st = {
    angle: 0.6,            // угол шатунов
    stand: 0,              // 0 — сидит, 1 — стоит на педалях
    standLeft: 0, nextStand: rnd(TUNE.standEvery),
    sig: { 1: 0, [-1]: 0 }, sigLeft: { 1: 0, [-1]: 0 }, // сигнал рукой по сторонам
    lat: 0,                // боковая скорость (в системе героя)
    crouch: 0, crouchV: 0, // приседание после приземления (пружина)
    airLift: 0,            // в прыжке: вытягивается на взлёте, группируется на спуске
    rock: 0,
    crash: -1,             // время с начала падения; -1 — не падает
    tuck: 0,               // аэропосадка: 0 — обычная, 1 — прижался к рулю
    duck: 0,               // пригнулся под шлагбаум
    look: 0,               // оглядывается: -1..1, знак — в какую сторону
  };
  // точка велосипеда → единицы персонажа, с учётом раскачивания велосипеда
  const toRider = (v) => {
    const x = v.x * SB, y = (v.y - B.bottom) * SB, c = Math.cos(st.rock), s = Math.sin(st.rock);
    return V((x * c - y * s) / SR, (x * s + y * c) / SR, (v.z * SB) / SR);
  };
  const pedalPoint = (s, angle) => {
    const p = bike.pedals[s], c = Math.cos(angle), sn = Math.sin(angle);
    return toRider(V(p.x, B.bb.y + p.rest.y * c - p.rest.z * sn, B.bb.z + p.rest.y * sn + p.rest.z * c));
  };
  const ankleTarget = (s, angle) => pedalPoint(s, angle).add(V(0, TUNE.ankleUp, -TUNE.ankleBack));
  // запястье стоит так, чтобы середина ладони легла на нижний хват руля
  const wristOnBar = (s, shoulder) => {
    const grip = toRider(side(B.drop, s));
    return grip.clone().addScaledVector(grip.clone().sub(shoulder).normalize(), -TUNE.handLen).add(V(0, TUNE.handUp, 0));
  };
  const frontPhase = Math.atan2(bike.pedals[1].rest.y, bike.pedals[1].rest.z); // угол, при котором педаль +X впереди

  const [bPelvis, bChest, bHead] = rider.bones;
  const limbs = {};
  // длины ног и рук считаем один раз по спокойной посадке (у модели они короткие — растягиваем)
  {
    const qPelvis = quat(0, 0, TUNE.leanPelvis), qChest = quat(0, 0, TUNE.leanChest);
    const pelvisPos = toRider(B.saddle).add(V(0, TUNE.seatUp, TUNE.seatForward));
    const chestPos = pelvisPos.clone().add(J.chest.clone().sub(J.pelvis).applyQuaternion(qPelvis));
    for (const s of [1, -1]) {
      const o = sideBase(s);
      const hip = pelvisPos.clone().add(side(J.hip, s).sub(J.pelvis).applyQuaternion(qPelvis));
      const shoulder = chestPos.clone().add(side(J.shoulder, s).sub(J.chest).applyQuaternion(qChest));
      const wrist = wristOnBar(s, shoulder);
      let reach = 0;
      for (let i = 0; i < 48; i++) reach = Math.max(reach, hip.distanceTo(ankleTarget(s, (i / 48) * Math.PI * 2)));
      const thigh = rider.bones[o + 2], shin = rider.bones[o + 3], upper = rider.bones[o], fore = rider.bones[o + 1];
      limbs[s] = {
        thigh, shin, foot: rider.bones[o + 4], upper, fore,
        legHalf: Math.max((thigh.userData.len + shin.userData.len) / 2, reach / TUNE.legStraight / 2),
        armHalf: Math.max((upper.userData.len + fore.userData.len) / 2, shoulder.distanceTo(wrist) / TUNE.armStraight / 2),
      };
    }
  }

  function pose() {
    const S = st.stand;
    const push = Math.cos(frontPhase - st.angle);      // +1, когда давит нога со стороны +X
    st.rock = S * TUNE.rock * push;                    // стоя велосипед отклоняется от давящей ноги
    bikeRoll.rotation.z = st.rock;
    bike.crank.rotation.x = st.angle;
    const sway = -(1 - S) * TUNE.sway * push;          // сидя корпус слегка качается к давящей ноге
    const roll = THREE.MathUtils.clamp(-st.lat * TUNE.bodyLean, -0.35, 0.35); // наклон в поворот
    const twist = st.sig[1] - st.sig[-1] + st.look * 1.6; // куда показывает рукой или оглядывается
    const up = Math.abs(st.look);                      // оглядываясь, выпрямляется

    const T = Math.max(st.tuck, st.duck) * (1 - S);    // стоя не прижимается
    const D = st.duck * (1 - S);                       // пригнулся: ещё ниже и голову вниз
    const qPelvis = quat(0, roll * 0.4 + sway - st.rock * 0.5, TUNE.leanPelvis + S * TUNE.standLeanPelvis + T * TUNE.tuckPelvis + D * TUNE.duckPelvis - up * 8);
    const qChest = quat(twist * 0.2, roll + sway * 1.6 - st.rock * 0.8, TUNE.leanChest + S * TUNE.standLeanChest + T * TUNE.tuckChest + D * TUNE.duckChest - Math.min(1, Math.abs(twist)) * 7 - up * 20);
    const qHead = quat(twist * 0.6 + THREE.MathUtils.clamp(st.lat * 0.03, -0.3, 0.3), roll * 0.3, TUNE.leanHead - T * TUNE.tuckHead + D * TUNE.duckHead); // голову запрокидывает, чтобы смотреть вперёд

    const pelvisPos = toRider(B.saddle).add(V(0, TUNE.seatUp + S * TUNE.standUp + st.crouch * S + st.airLift, TUNE.seatForward + S * TUNE.standForward));
    // не выше, чем позволяет длина ног: поэтому стоя таз ходит вверх-вниз вместе с педалями
    const hipOff = {}, ankle = {};
    let drop = 0;
    for (const s of [1, -1]) {
      hipOff[s] = side(J.hip, s).sub(J.pelvis).applyQuaternion(qPelvis);
      ankle[s] = ankleTarget(s, st.angle);
      const hip = pelvisPos.clone().add(hipOff[s]);
      const R = 2 * limbs[s].legHalf * 0.985;
      const h2 = R * R - (hip.x - ankle[s].x) ** 2 - (hip.z - ankle[s].z) ** 2;
      drop = Math.max(drop, hip.y - (ankle[s].y + Math.sqrt(Math.max(0, h2))));
    }
    pelvisPos.y -= drop;
    const chestPos = pelvisPos.clone().add(J.chest.clone().sub(J.pelvis).applyQuaternion(qPelvis));
    const headPos = chestPos.clone().add(J.head.clone().sub(J.chest).applyQuaternion(qChest));
    st.lastPelvis = pelvisPos.clone();
    bPelvis.position.copy(pelvisPos); bPelvis.quaternion.copy(qPelvis);
    bChest.position.copy(chestPos); bChest.quaternion.copy(qChest);
    bHead.position.copy(headPos); bHead.quaternion.copy(qHead);

    for (const s of [1, -1]) {
      const L = limbs[s];
      bike.pedals[s].group.rotation.x = -st.angle; // педаль остаётся горизонтальной
      // нога
      const hip = pelvisPos.clone().add(hipOff[s]);
      const leg = solveTwoBone(hip, ankle[s], L.legHalf, L.legHalf, V(s * 0.12, 0.2, 1));
      aimBone(L.thigh, hip, leg.mid, L.legHalf);
      aimBone(L.shin, leg.mid, leg.end, L.legHalf);
      L.foot.position.copy(leg.end);
      L.foot.quaternion.identity();
      // рука: на руле или вытянута в сторону (сигнал поворота)
      const shoulder = chestPos.clone().add(side(J.shoulder, s).sub(J.chest).applyQuaternion(qChest));
      const w = st.sig[s] * st.sig[s] * (3 - 2 * st.sig[s]);
      const onBar = wristOnBar(s, shoulder);
      const out = shoulder.clone().addScaledVector(V(s, 0.02, -0.12).normalize(), 2 * L.armHalf * 0.97);
      const wrist = onBar.lerp(out, w);
      const pole = V(s * (0.7 - 0.45 * T), -1, -0.2).lerp(V(0, -1, -0.3), w); // в аэропосадке локти прижаты
      const arm = solveTwoBone(shoulder, wrist, L.armHalf, L.armHalf, pole);
      aimBone(L.upper, shoulder, arm.mid, L.armHalf);
      aimBone(L.fore, arm.mid, arm.end, L.armHalf);
    }
  }

  // Главный вызов каждый кадр.
  // tuck — аэропосадка 0..1; step — метров проехали за кадр; latVel — боковая скорость в системе героя (+X); air — в прыжке; vy — вертикальная скорость
  // Падение: велосипед встаёт на переднее колесо и заваливается набок, ездок перелетает через руль,
  // приземляется плашмя и проезжает по асфальту. Поза задаётся от корпуса: руки вперёд, ноги назад.
  function poseCrash() {
    const t = st.crash, g = 13 / SR, sd = st.crashSide;
    const endo = Math.min(1, t / 0.32), fall = THREE.MathUtils.smoothstep(t, 0.28, 0.95);
    bikeRoll.rotation.x = 1.15 * Math.sin(endo * Math.PI * 0.5) * (1 - fall * 0.85);
    bikeRoll.rotation.z = fall * 1.45 * sd;
    // st.wall — сколько метров до борта машины впереди: ни велосипед, ни ездок дальше него не улетают
    const wall = st.wall ?? Infinity;
    bikeRoll.position.set(-sd * 0.5 * fall, Math.sin(endo * Math.PI) * 0.35 * (1 - fall) + fall * 0.12, Math.min(1.4 * (1 - Math.exp(-3 * t)), Math.max(0, wall - 0.95)));
    bike.crank.rotation.x = st.angle;

    const p0 = st.crashFrom, v = st.crashVel, floorY = 0.13;
    let y = p0.y + v.y * t - 0.5 * g * t * t, z = p0.z + v.z * t;
    if (st.crashLand === null && y <= floorY && t > 0.1) st.crashLand = t;
    const air = st.crashLand === null;
    if (!air) { // приземлился: подпрыгнул разок и проехал по асфальту
      const k = t - st.crashLand;
      y = floorY + Math.abs(Math.sin(k * 9)) * 0.035 * Math.exp(-k * 5);
      z = p0.z + v.z * st.crashLand + (v.z / 3.5) * (1 - Math.exp(-3.5 * k));
    }
    const zWall = wall / SR - 0.42; // голова и руки впереди таза
    if (z > zWall) { z = Math.max(zWall, st.crashZ ?? p0.z); st.crashHit = true; }
    st.crashZ = z;
    const pitch = air ? THREE.MathUtils.lerp(TUNE.leanChest, 102, Math.min(1, t / 0.4)) : THREE.MathUtils.lerp(102, 90, Math.min(1, (t - st.crashLand) / 0.3));
    const qT = quat(sd * 0.3 * Math.min(1, t * 2), air ? Math.sin(t * 9) * 0.2 : 0.07 * sd, pitch);
    const qHead = qT.clone().multiply(rotX(air ? -28 : -12));
    const aside = Math.min(TUNE.crashAside * (1 - Math.exp(-2.6 * t)), Math.max(0.15, (st.sideWall ?? Infinity) / SR)); // сбоку машина — дальше её борта не отлетает
    const pelvisPos = V(p0.x + sd * aside, y, z); // отлетает в сторону от машины
    const chestPos = pelvisPos.clone().add(J.chest.clone().sub(J.pelvis).applyQuaternion(qT));
    const headPos = chestPos.clone().add(J.head.clone().sub(J.chest).applyQuaternion(qT));
    bPelvis.position.copy(pelvisPos); bPelvis.quaternion.copy(qT);
    bChest.position.copy(chestPos); bChest.quaternion.copy(qT);
    bHead.position.copy(headPos); bHead.quaternion.copy(qHead);
    const flail = air ? Math.sin(t * 16) : 0;
    for (const s of [1, -1]) {
      const L = limbs[s];
      const reach = (from, dir, len, minY) => { const p = from.clone().addScaledVector(dir.normalize().applyQuaternion(qT), len); p.y = Math.max(minY, p.y); return p; };
      const shoulder = chestPos.clone().add(side(J.shoulder, s).sub(J.chest).applyQuaternion(qT));
      const wrist = reach(shoulder, air ? V(s * 0.45, 0.85, 0.3 + 0.3 * flail * s) : V(s * 0.8, 0.6, 0.1), 2 * L.armHalf * 0.9, 0.04);
      const arm = solveTwoBone(shoulder, wrist, L.armHalf, L.armHalf, V(s, 0, -0.4).applyQuaternion(qT));
      aimBone(L.upper, shoulder, arm.mid, L.armHalf);
      aimBone(L.fore, arm.mid, arm.end, L.armHalf);
      const hip = pelvisPos.clone().add(side(J.hip, s).sub(J.pelvis).applyQuaternion(qT));
      const ankle = reach(hip, air ? V(s * 0.22, -0.9, -0.25 - 0.35 * flail * s) : V(s * 0.3, -0.95, -0.06), 2 * L.legHalf * 0.88, 0.05);
      const leg = solveTwoBone(hip, ankle, L.legHalf, L.legHalf, V(s * 0.3, 0, 1).applyQuaternion(qT));
      aimBone(L.thigh, hip, leg.mid, L.legHalf);
      aimBone(L.shin, leg.mid, leg.end, L.legHalf);
      L.foot.position.copy(leg.end); L.foot.quaternion.copy(qT);
    }
  }
  function crash(sideSign = Math.random() < 0.5 ? 1 : -1) { // начать падение
    st.crash = 0; st.crashSide = sideSign; st.crashLand = null; st.crashZ = null; st.wall = Infinity; st.sideWall = Infinity;
    st.crashFrom = (st.lastPelvis ?? V(0, 0.55, 0)).clone();
    st.crashVel = V(0, 3.6 / SR, TUNE.crashForward / SR);
    for (const s of [1, -1]) st.sig[s] = st.sigLeft[s] = 0;
  }
  function reset() { // поднять после падения
    st.crash = -1; st.look = 0; st.stand = 0; st.crouch = 0; st.crouchV = 0; st.tuck = 0; st.duck = 0;
    bikeRoll.rotation.set(0, 0, 0); bikeRoll.position.set(0, 0, 0);
    pose();
  }
  function update(dt, { step = 0, latVel = 0, air = false, vy = 0, tuck = 0, duck = 0, look = 0 } = {}) {
    if (st.crash >= 0) { // падает: обычная посадка отключена
      st.crash += dt; st.angle += step * 0.6;
      for (const w of [bike.wheelF, bike.wheelR]) w.rotation.x += Math.min(step / (B.wheelR * SB), 0.16) + 0.02;
      poseCrash();
      return;
    }
    st.tuck = damp(st.tuck, tuck, 1.5, dt);
    st.duck = damp(st.duck, duck, duck ? 18 : 9, dt);
    st.look = damp(st.look, look, 5, dt);
    if (duck) st.standLeft = 0;
    // На скорости колесо за кадр проворачивается больше, чем на шаг между спицами, и глазу кажется,
    // что оно крутится назад (как в кино). Поэтому видимый поворот за кадр ограничен,
    // а скорость передаёт полупрозрачный «смаз» спиц.
    const turn = Math.min(step / (B.wheelR * SB), 0.16);
    const blur = THREE.MathUtils.clamp((step / Math.max(dt, 1e-4) - 6) / 16, 0, 1);
    for (const w of [bike.wheelF, bike.wheelR]) {
      w.rotation.x += turn;
      w.userData.blur.material.opacity = 0.34 * blur;
      w.userData.spokes.opacity = 1 - 0.55 * blur;
    }
    // сам иногда встаёт на педали, как при реальной езде
    st.nextStand -= dt;
    if (st.nextStand <= 0 && !air) { st.standLeft = rnd(TUNE.standFor); st.nextStand = st.standLeft + rnd(TUNE.standEvery); }
    st.standLeft = Math.max(0, st.standLeft - dt);
    st.stand = damp(st.stand, air || st.standLeft > 0 ? 1 : 0, air ? 16 : 4.5, dt);
    if (air) { // в прыжке не крутит: шатуны выравниваются горизонтально
      const level = frontPhase - Math.PI * Math.round((frontPhase - st.angle) / Math.PI);
      st.angle = damp(st.angle, level, 12, dt);
    } else {
      st.angle += step * TUNE.cadence * (1 - 0.3 * st.stand); // стоя крутит реже и мощнее
    }
    st.airLift = damp(st.airLift, air ? 0.03 * THREE.MathUtils.clamp(vy / 9, -1, 1) : 0, 10, dt);
    for (const s of [1, -1]) {
      st.sigLeft[s] = Math.max(0, st.sigLeft[s] - dt);
      st.sig[s] = damp(st.sig[s], st.sigLeft[s] > 0 ? 1 : 0, st.sigLeft[s] > 0 ? 11 : 7, dt);
    }
    st.lat = damp(st.lat, latVel, 7, dt);
    st.crouchV += (-st.crouch * 110 - st.crouchV * 13) * dt; // пружина амортизации
    st.crouch += st.crouchV * dt;
    pose();
  }
  const signal = (s) => { st.sigLeft[s] = TUNE.signalTime; st.sigLeft[-s] = 0; }; // вытянуть руку со стороны s (+1 или -1 по оси X героя)
  const land = (impact = 1) => { st.crouchV = -TUNE.landDip * impact; st.standLeft = Math.max(st.standLeft, 0.35); };
  pose();
  const riderPos = (v) => bPelvis.getWorldPosition(v); // где сейчас таз ездока в мире (после падения — где он лежит)
  return { group, update, signal, land, crash, reset, pose, poseCrash, riderPos, state: st, bike, rider };
}
