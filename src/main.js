import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { loadHero } from './hero.js';
import { loadChaser, CHASER } from './runner.js';

// ---------- Изгиб мира ----------
// Дорога в игре прямая, а повороты и уклоны рисуются: каждая точка сдвигается вбок и по высоте
// тем сильнее, чем дальше она от игрока. На правила игры это не влияет, только на картинку.
// Изгиб «приезжает» издалека: uBend — кривизна под игроком, а uBendT — до четырёх переходов впереди
// (x — сколько метров до начала перехода, y — его длина, zw — на сколько меняется кривизна). Переход начинается
// за туманом и едет навстречу вместе с дорогой, поэтому город на глазах не гнётся: это обычный поворот.
const BEND_SLOTS = 4;
const mkSlots = () => Array.from({ length: BEND_SLOTS }, () => new THREE.Vector4(1e4, 1, 0, 0));
const skyH = { value: 1000 }; // высота кадра в пикселях — чтобы дымка знала, какое небо за каждой точкой
const bend = { value: new THREE.Vector2(0, 0) }, noBend = { value: new THREE.Vector2(0, 0) };
const bendT = { value: mkSlots() }, noBendT = { value: mkSlots() };
// Дымка растворяет дальние дома не в один цвет, а ровно в тот цвет неба, что у них за спиной —
// поэтому новый квартал появляется невидимым и проступает постепенно.
THREE.ShaderChunk.fog_fragment = THREE.ShaderChunk.fog_fragment.replace('gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );',
  'float skyF = 1.0 - gl_FragCoord.y / uSkyH;\n vec3 skyC = skyF < 0.45 ? mix(vec3(0.498, 0.663, 0.839), vec3(0.725, 0.812, 0.886), skyF / 0.45) : mix(vec3(0.725, 0.812, 0.886), vec3(0.914, 0.847, 0.784), clamp((skyF - 0.45) / 0.17, 0.0, 1.0));\n gl_FragColor.rgb = mix( gl_FragColor.rgb, skyC, fogFactor );');
THREE.ShaderChunk.common = `uniform float uSkyH;
uniform vec2 uBend;
uniform vec4 uBendT[${BEND_SLOTS}];
float bendF(float t, float L) { t = max(t, 0.0); return t < L ? t * t * t / (6.0 * L) : L * L / 6.0 + 0.5 * L * (t - L) + 0.5 * (t - L) * (t - L); }
float bendG(float t, float L) { t = max(t, 0.0); return t < L ? t * t / (2.0 * L) : 0.5 * L + (t - L); }
` + THREE.ShaderChunk.common;
THREE.ShaderChunk.project_vertex = THREE.ShaderChunk.project_vertex.replace('mvPosition = modelViewMatrix * mvPosition;',
  `vec4 bendPos = modelMatrix * mvPosition;
 float bendD = max(0.0, 4.0 - bendPos.z);
 vec2 bendOff = uBend * bendD * bendD;
 for (int i = 0; i < ${BEND_SLOTS}; i++) { vec4 bt = uBendT[i]; bendOff += bt.zw * 2.0 * (bendF(bendD - bt.x, bt.y) - bendF(-bt.x, bt.y) - bendD * bendG(-bt.x, bt.y)); }
 bendPos.xy += bendOff;
 mvPosition = viewMatrix * bendPos;`);
// тени считаются в «прямом» мире, поэтому для карт теней изгиб выключен
THREE.Material.prototype.onBeforeCompile = function (shader) { shader.uniforms.uSkyH = skyH; const flat = this.isMeshDepthMaterial || this.isMeshDistanceMaterial; shader.uniforms.uBend = flat ? noBend : bend; shader.uniforms.uBendT = flat ? noBendT : bendT; };

// ---------- Настройки (их удобно крутить) ----------
const LANES = [-3.2, 0, 3.2];      // центры трёх полос
const START_SPEED = 18;            // м/с на старте
const MAX_SPEED = 38;              // м/с максимум
const FULL_DIFFICULTY_AT = 1800; // метров до максимальной сложности
const TRAFFIC_SPEED = 5;           // машины едут вперёд с этой скоростью
const SPAWN_Z = -210;              // где появляются препятствия
const JUMP_V = 9;
const GRAVITY = 26;
const tmpV = new THREE.Vector3();
const CHASE_FAR = 9.5;             // женщина далеко (за камерой)
const CHASE_NEAR = 3.3;            // женщина близко
const CHASE_TIME = 7;              // сколько секунд она держится рядом после ошибки
const TUCK_FROM = 1000;             // с этой отметки (м) Даня начинает прижиматься к рулю
const TUCK_FULL = 2000;             // а к этой — полностью в аэропосадке
const STEER_SPRING = 150;           // жёсткость перестроения (больше — резче)
const STEER_DAMPING = 20;           // затухание (меньше — сильнее занос)
const DUCK_TIME = 0.8;               // сколько секунд Даня пригибается
const RAMP_V = 12.5;                // с какой скоростью эвакуатор подбрасывает вверх
const SPRING_TIME = 12;              // длительность пружины, с
const SUPER_JUMP_V = 14;            // скорость суперпрыжка (обычный — JUMP_V): хватает на крышу автобуса
const MAGNET_TIME = 8;              // длительность магнита, с
const BOOST_TIME = 3.5;             // длительность батончика, с
const BOOST_SPEED = 1.45;           // во сколько раз батончик ускоряет
const BONUS_CHANCE = 0.3;          // шанс бонуса в ряду
const ROW_TIME_START = 1.35;         // секунд между рядами препятствий на старте
const ROW_TIME_END = 0.8;           // и на полной сложности
const ONCOMING_SPEED = 8;            // скорость встречных машин, м/с
const TWOWAY_FROM = 600;            // с какой отметки (м) появляются участки со встречной полосой
const J_HALF = 7;                   // половина ширины перекрёстка, м
const BEND_TURN = 0.0013;           // крутизна поворотов (0 — дорога всегда прямая)
const BEND_HILL = 0.0004;           // крутизна подъёмов и спусков
const CHUNK_LEN = 40;              // длина блока обочины

const SKY = 0xe9d8c8;                // цвет дымки у горизонта (тёплый вечерний)
const rand = (a, b) => a + Math.random() * (b - a);
const damp = (a, b, rate, dt) => a + (b - a) * (1 - Math.exp(-rate * dt)); // плавное приближение a к b
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

// ---------- Сцена ----------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.prepend(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(SKY);
scene.fog = new THREE.Fog(SKY, 70, 230);

const camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.1, 400);
camera.position.copy(new THREE.Vector3(2.7, 1.25, -3.3)); // стартуем с заставки

// небо: градиент от голубого вверху к тёплой дымке у горизонта
{
  const c = document.createElement('canvas'); c.width = 4; c.height = 256;
  const ctx = c.getContext('2d'), grad = ctx.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, '#7fa9d6'); grad.addColorStop(0.45, '#b9cfe2'); grad.addColorStop(0.62, '#e9d8c8'); grad.addColorStop(1, '#e9d8c8');
  ctx.fillStyle = grad; ctx.fillRect(0, 0, 4, 256);
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
  scene.background = tex;
}
// свет: мягкое небо плюс низкое тёплое солнце слева-спереди, от него длинные тени
scene.add(new THREE.HemisphereLight(0xcfe0f5, 0x8a7a66, 1.25));
const sun = new THREE.DirectionalLight(0xffdcb0, 2.3);
sun.position.set(-14, 46, -52); // светит вдоль дороги: тени башен ложатся на обочину, а не на проезжую часть
sun.target.position.set(0, 0, -18);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -38, right: 38, top: 46, bottom: -46, near: 1, far: 160 });
sun.shadow.bias = -0.0006; sun.shadow.normalBias = 0.04;
scene.add(sun, sun.target);
// Склейка: сотни мелких неподвижных деталей (стены, окна, деревья, ларьки) превращаются в несколько больших — по одной на материал.
// Видеокарте это в разы легче: она рисует не две тысячи предметов, а пару сотен. keep(o) — что оставить отдельным (движется или меняется).
function mergeStatic(root, keep = () => false) {
  root.updateMatrixWorld(true);
  const inv = root.matrixWorld.clone().invert(), buckets = new Map(), gone = [], m4 = new THREE.Matrix4();
  const skip = (o) => { for (let p = o; p && p !== root; p = p.parent) if (keep(p)) return true; return false; };
  root.traverse((o) => {
    if (!o.isMesh || o.isSkinnedMesh || o.isInstancedMesh || skip(o) || !o.geometry.attributes.position) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    const src = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry, total = src.attributes.position.count;
    const groups = Array.isArray(o.material) && src.groups.length ? src.groups : [{ start: 0, count: total, materialIndex: 0 }];
    m4.multiplyMatrices(inv, o.matrixWorld);
    for (const gr of groups) {
      const mm = mats[gr.materialIndex]; if (!mm) continue;
      const cnt = Math.min(gr.count, total - gr.start), geo = new THREE.BufferGeometry();
      for (const [name, size] of [['position', 3], ['normal', 3], ['uv', 2]]) {
        const a = src.attributes[name], arr = new Float32Array(cnt * size);
        if (a) for (let i = 0; i < cnt; i++) for (let k = 0; k < size; k++) arr[i * size + k] = a.getComponent(gr.start + i, k);
        geo.setAttribute(name, new THREE.BufferAttribute(arr, size));
      }
      geo.applyMatrix4(m4);
      const key = mm.uuid + '|' + (o.castShadow ? 1 : 0) + (o.receiveShadow ? 1 : 0) + '|' + o.renderOrder;
      if (!buckets.has(key)) buckets.set(key, { mm, cast: o.castShadow, recv: o.receiveShadow, order: o.renderOrder, geos: [] });
      buckets.get(key).geos.push(geo);
    }
    gone.push(o);
  });
  for (const o of gone) { o.parent.remove(o); if (o.userData.ownGeo) o.geometry.dispose(); }
  const made = [];
  for (const b of buckets.values()) {
    const mesh = new THREE.Mesh(mergeGeometries(b.geos, false), b.mm);
    mesh.castShadow = b.cast; mesh.receiveShadow = b.recv; mesh.renderOrder = b.order; mesh.userData.merged = true;
    for (const gg of b.geos) gg.dispose();
    root.add(mesh); made.push(mesh);
  }
  root.userData.mergedMeshes = made;
}
const dropMerged = (root) => { for (const m of root.userData.mergedMeshes || []) m.geometry.dispose(); }; // освободить память склеенного
const castShadows = (obj) => obj.traverse((m) => { if (m.isMesh && !m.material.transparent && m.material.type !== 'MeshBasicMaterial') m.castShadow = true; });

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---------- Вспомогательное ----------
const matCache = new Map();
function mat(color, opts = {}) {
  const key = color + JSON.stringify(opts);
  if (!matCache.has(key)) matCache.set(key, new THREE.MeshLambertMaterial({ color, ...opts }));
  return matCache.get(key);
}
function box(w, h, d, color, x = 0, y = 0, z = 0) {
  // длинные коробки режем вдоль дороги на отрезки по ~8 м: тогда на повороте здание идёт по дуге, а не прямой хордой
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d, w > 12 ? Math.ceil(w / 8) : 1, 1, d > 12 ? Math.ceil(d / 8) : 1), typeof color === 'number' ? mat(color) : color);
  m.position.set(x, y, z);
  return m;
}
function canvasTexture(w, h, draw) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// ---------- Запечённый свет: то, что в играх художник рисует прямо в текстуре ----------
// поверх нарисованного фасада кладём затемнение у земли, тень под карнизом, потёки и пятна
function bakeLight(c, w, h) {
  const low = Math.min(h * 0.3, 90);
  let g = c.createLinearGradient(0, h - low, 0, h);
  g.addColorStop(0, 'rgba(25,18,35,0)'); g.addColorStop(1, 'rgba(25,18,35,0.42)');
  c.fillStyle = g; c.fillRect(0, h - low, w, low);
  g = c.createLinearGradient(0, 0, 0, Math.min(h * 0.5, 200));
  g.addColorStop(0, 'rgba(255,250,235,0.16)'); g.addColorStop(1, 'rgba(255,250,235,0)');
  c.fillStyle = g; c.fillRect(0, 0, w, Math.min(h * 0.5, 200));
  g = c.createLinearGradient(0, 0, 0, 12);
  g.addColorStop(0, 'rgba(0,0,0,0.32)'); g.addColorStop(1, 'rgba(0,0,0,0)');
  c.fillStyle = g; c.fillRect(0, 0, w, 12);
  for (let i = 0; i < w / 22; i++) { // потёки от дождя
    const x = Math.random() * w, len = h * (0.15 + Math.random() * 0.5), sw = 2 + Math.random() * 5;
    g = c.createLinearGradient(0, 0, 0, len);
    g.addColorStop(0, 'rgba(30,25,20,0.13)'); g.addColorStop(1, 'rgba(30,25,20,0)');
    c.fillStyle = g; c.fillRect(x, 0, sw, len);
  }
  for (let i = 0; i < 40; i++) { // пятна: панели чуть разного тона
    c.fillStyle = Math.random() < 0.5 ? 'rgba(0,0,0,0.045)' : 'rgba(255,255,255,0.045)';
    c.fillRect(Math.random() * w, Math.random() * h, 20 + Math.random() * 70, 16 + Math.random() * 50);
  }
}
const bakedTexture = (w, h, draw) => canvasTexture(w, h, (c, cw, ch) => { draw(c, cw, ch); bakeLight(c, cw, ch); });
// гладкие стены: светлее вверху, темнее у земли
const wallGrad = canvasTexture(8, 128, (c, w, h) => {
  const g = c.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, '#ffffff'); g.addColorStop(0.55, '#ecebf0'); g.addColorStop(1, '#a3a0b0');
  c.fillStyle = g; c.fillRect(0, 0, w, h);
});
const wallMats = new Map();
function wallMat(color) {
  if (!wallMats.has(color)) wallMats.set(color, new THREE.MeshLambertMaterial({ color, map: wallGrad }));
  return wallMats.get(color);
}
// мягкая тень-пятно на земле: «приземляет» предметы
const softRect = canvasTexture(128, 128, (c) => { c.shadowColor = '#000'; c.shadowBlur = 22; c.fillStyle = '#000'; c.fillRect(28, 28, 72, 72); });
const softRound = canvasTexture(128, 128, (c) => { const g = c.createRadialGradient(64, 64, 6, 64, 64, 62); g.addColorStop(0, 'rgba(0,0,0,1)'); g.addColorStop(1, 'rgba(0,0,0,0)'); c.fillStyle = g; c.fillRect(0, 0, 128, 128); });
const blobMats = new Map();
function blob(w, d, opacity = 0.5, round = false) {
  const key = (round ? 'r' : 's') + opacity;
  if (!blobMats.has(key)) blobMats.set(key, new THREE.MeshBasicMaterial({ map: round ? softRound : softRect, transparent: true, opacity, depthWrite: false }));
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), blobMats.get(key));
  m.rotation.x = -Math.PI / 2; m.position.y = 0.05; m.renderOrder = 1;
  return m;
}

// ---------- Дорога ----------
const scrolling = []; // текстуры покрытий, которые едут вместе с дорогой: [текстура, длина плитки в метрах]
const grassTex = canvasTexture(256, 256, (c, w, h) => { // газон: пятна травы, проплешины
  c.fillStyle = '#7d9058'; c.fillRect(0, 0, w, h);
  for (let i = 0; i < 260; i++) { c.fillStyle = pick(['rgba(110,140,70,0.35)', 'rgba(90,120,60,0.3)', 'rgba(140,150,90,0.25)', 'rgba(120,105,75,0.18)']); c.beginPath(); c.arc(Math.random() * w, Math.random() * h, 5 + Math.random() * 20, 0, 7); c.fill(); }
});
grassTex.wrapS = grassTex.wrapT = THREE.RepeatWrapping; grassTex.repeat.set(500 / 30, 500 / 30);
scrolling.push([grassTex, 30]);
const ground = new THREE.Mesh(new THREE.PlaneGeometry(900, 500, 1, 100), new THREE.MeshLambertMaterial({ map: grassTex })); // дальний фон под блоками
ground.rotation.x = -Math.PI / 2;
ground.position.set(0, -1.0, -120);
ground.receiveShadow = true;
scene.add(ground);

// фактура покрытий: едет вместе с разметкой
function surface(w, len, tile, x, y, draw, tw, th) {
  const tex = canvasTexture(tw, th, draw);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.repeat.set(1, len / tile);
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, len), new THREE.MeshLambertMaterial({ map: tex }));
  m.rotation.x = -Math.PI / 2; m.position.set(x, y, -150); m.receiveShadow = true;
  scene.add(m); scrolling.push([tex, tile]);
}
const asphaltMat = new THREE.MeshLambertMaterial({ map: canvasTexture(256, 1024, (c, w, h) => { // асфальт: крошка, накатанные колеи, заплатки, трещины
  c.fillStyle = '#41444a'; c.fillRect(0, 0, w, h);
  for (let i = 0; i < 9000; i++) { c.fillStyle = Math.random() < 0.5 ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.07)'; c.fillRect(Math.random() * w, Math.random() * h, 2, 2); }
  for (const lane of [0.2, 0.5, 0.8]) for (const dx of [-0.045, 0.045]) { const g = c.createLinearGradient((lane + dx) * w - 9, 0, (lane + dx) * w + 9, 0); g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(0.5, 'rgba(0,0,0,0.13)'); g.addColorStop(1, 'rgba(0,0,0,0)'); c.fillStyle = g; c.fillRect((lane + dx) * w - 9, 0, 18, h); }
  for (let i = 0; i < 5; i++) { const x = Math.random() * (w - 50), y = Math.random() * (h - 60), pw = 16 + Math.random() * 30, ph = 20 + Math.random() * 40; c.fillStyle = 'rgba(20,22,26,0.2)'; c.fillRect(x, y, pw, ph); c.strokeStyle = 'rgba(120,125,130,0.2)'; c.strokeRect(x + 0.5, y + 0.5, pw, ph); }
  c.strokeStyle = 'rgba(15,15,18,0.55)'; c.lineWidth = 1.2;
  for (let i = 0; i < 9; i++) { let x = Math.random() * w, y = Math.random() * h; c.beginPath(); c.moveTo(x, y); for (let k = 0; k < 7; k++) { x += (Math.random() - 0.5) * 26; y += Math.random() * 26; c.lineTo(x, y); } c.stroke(); }
  for (const e of [0, w - 14]) { const g = c.createLinearGradient(e, 0, e + 14, 0); g.addColorStop(e ? 0 : 1, 'rgba(150,140,120,0)'); g.addColorStop(e ? 1 : 0, 'rgba(150,140,120,0.28)'); c.fillStyle = g; c.fillRect(e, 0, 14, h); } // пыль у бордюра
}) });
const road = (m) => { m.receiveShadow = true; scene.add(m); };
// асфальт, газон, бордюры, тротуары и разметка строятся в блоках дороги (roadKit): так они изгибаются вместе
const sidewalkTex = canvasTexture(128, 256, (c, w, h) => { // тротуарная плитка
  for (let y = 0; y < h; y += 16) for (let x = 0; x < w; x += 16) { const v = 138 + Math.floor(Math.random() * 26); c.fillStyle = `rgb(${v},${v},${v + 4})`; c.fillRect(x + ((y / 16) % 2 ? 8 : 0) - 8, y, 15, 15); }
  for (let i = 0; i < 12; i++) { c.fillStyle = 'rgba(60,55,50,0.14)'; c.beginPath(); c.arc(Math.random() * w, Math.random() * h, 6 + Math.random() * 14, 0, 7); c.fill(); }
});

// ---------- Велосипедист ----------
function makeWheel(z) {
  const holder = new THREE.Group();
  const tire = new THREE.Mesh(new THREE.TorusGeometry(0.34, 0.035, 8, 22), mat(0x151515));
  tire.rotation.y = Math.PI / 2;
  holder.add(tire, box(0.02, 0.66, 0.03, 0xcccccc), box(0.02, 0.03, 0.66, 0xcccccc));
  holder.position.set(0, 0.375, z);
  return holder;
}
function makeBike() {
  const g = new THREE.Group();
  const frame = 0xe63946;
  const wheelF = makeWheel(-0.55), wheelR = makeWheel(0.55);
  g.add(wheelF, wheelR);
  const top = box(0.05, 0.05, 0.95, frame, 0, 0.92, -0.02);
  const down = box(0.05, 0.05, 0.8, frame, 0, 0.62, -0.2); down.rotation.x = -0.75;
  const seatTube = box(0.05, 0.6, 0.05, frame, 0, 0.66, 0.2);
  const stay = box(0.04, 0.04, 0.6, frame, 0, 0.62, 0.4); stay.rotation.x = 0.85;
  const fork = box(0.04, 0.62, 0.04, frame, 0, 0.66, -0.5);
  const bar = box(0.5, 0.04, 0.04, 0x222222, 0, 1.0, -0.56);
  const saddle = box(0.14, 0.05, 0.28, 0x222222, 0, 1.0, 0.24);
  g.add(top, down, seatTube, stay, fork, bar, saddle);
  // ездок
  const torso = box(0.38, 0.62, 0.24, 0x1d7fd6, 0, 1.36, -0.08); torso.rotation.x = -0.75;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.15, 12, 10), mat(0xf1c8a4)); head.position.set(0, 1.68, -0.4);
  const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.17, 12, 10, 0, Math.PI * 2, 0, Math.PI / 2), mat(0xf4d35e)); helmet.position.set(0, 1.71, -0.4);
  const armL = box(0.08, 0.5, 0.08, 0xf1c8a4, -0.2, 1.24, -0.42); armL.rotation.x = -0.5;
  const armR = armL.clone(); armR.position.x = 0.2;
  const legL = box(0.11, 0.62, 0.11, 0x222831, -0.11, 0.78, 0.1);
  const legR = legL.clone(); legR.position.x = 0.11;
  g.add(torso, head, helmet, armL, armR, legL, legR);
  // анимация запасной фигурки из кубиков (пока не загрузилась настоящая модель)
  g.userData.animate = (step, time) => {
    wheelF.rotation.x -= step / 0.34; wheelR.rotation.x -= step / 0.34;
    legL.position.y = 0.78 + Math.sin(time * 14) * 0.09;
    legR.position.y = 0.78 - Math.sin(time * 14) * 0.09;
  };
  return g;
}
const bike = makeBike();
castShadows(bike);
scene.add(bike);
// Настоящий герой: модель по фото. Когда загрузится — заменяет фигурку из кубиков.
loadHero().then((hero) => {
  hero.group.rotation.y = Math.PI; // модель смотрит в +Z, а едем мы в -Z
  bike.clear();
  bike.add(hero.group);
  castShadows(hero.group);
  bike.userData.animate = (step, time, m) => {
    // герой развёрнут на 180°, поэтому его ось X направлена в обратную сторону
    hero.update(m.dt, { step, latVel: -m.vx, air: m.air, vy: m.vy, tuck: m.tuck, duck: m.duck, look: m.look ?? 0 });
    if (m.landed) hero.land(m.impact);
  };
  bike.userData.signal = (dir) => hero.signal(-dir);
  bike.userData.crash = (gameSide) => hero.crash(-gameSide); // ось X героя направлена в обратную сторону
  bike.userData.uncrash = () => hero.reset();
  bike.userData.wall = (m, sideM = Infinity) => { hero.state.wall = m; hero.state.sideWall = sideM; };
  bike.userData.riderPos = (v) => hero.riderPos(v);
}).catch((e) => console.warn('Модель героя не загрузилась, остаётся фигурка из кубиков', e));

// ---------- Влюблённая женщина ----------
const heartTex = canvasTexture(128, 128, (c) => {
  c.font = '100px serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
  c.fillText('❤️', 64, 70);
});
function makeWoman() {
  const g = new THREE.Group();
  const dress = new THREE.Mesh(new THREE.ConeGeometry(0.46, 1.15, 14), mat(0xff5d8f)); dress.position.y = 0.72;
  const torso = box(0.38, 0.42, 0.24, 0xff5d8f, 0, 1.3, 0);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.17, 12, 10), mat(0xf1c8a4)); head.position.set(0, 1.68, 0);
  const hair = new THREE.Mesh(new THREE.SphereGeometry(0.21, 12, 10), mat(0x6b3a1e)); hair.position.set(0, 1.7, 0.08);
  const armL = box(0.08, 0.08, 0.6, 0xf1c8a4, -0.24, 1.38, -0.32);
  const armR = armL.clone(); armR.position.x = 0.24;
  const legL = box(0.1, 0.4, 0.1, 0xf1c8a4, -0.1, 0.2, 0);
  const legR = legL.clone(); legR.position.x = 0.1;
  const bouquet = new THREE.Mesh(new THREE.SphereGeometry(0.14, 8, 8), mat(0xd62828)); bouquet.position.set(0.24, 1.42, -0.66);
  const heart = new THREE.Sprite(new THREE.SpriteMaterial({ map: heartTex, transparent: true, fog: false }));
  heart.position.y = 2.35; heart.scale.set(0.7, 0.7, 1);
  g.add(dress, torso, head, hair, armL, armR, legL, legR, bouquet, heart);
  g.userData = { legL, legR, heart };
  return g;
}
const woman = makeWoman();
castShadows(woman);
scene.add(woman);
// Модель поклонницы со скелетом и бегом. Включается флагом CHASER.ready в runner.js.
if (CHASER.ready) loadChaser().then((chaser) => {
  const heart = woman.userData.heart;
  chaser.group.rotation.y = Math.PI; // модель смотрит в +Z, а бежит в -Z
  woman.clear();
  woman.add(chaser.group, heart);
  castShadows(chaser.group);
  woman.userData = { heart, heartY: CHASER.height + 0.35, animate: chaser.update };
}).catch((e) => console.warn('Модель поклонницы не загрузилась, остаётся фигурка', e));

// ---------- Транспорт и препятствия ----------
const CAR_COLORS = [0xc0c0c0, 0x2f3e46, 0xffffff, 0x9d0208, 0x1d3557, 0x52796f, 0x111111, 0xbc6c25];
const wheelGeo = new THREE.CylinderGeometry(0.34, 0.34, 0.25, 12);
function addWheels(g, halfW, zs) {
  for (const z of zs) for (const s of [-1, 1]) {
    const w = new THREE.Mesh(wheelGeo, mat(0x151515));
    w.rotation.z = Math.PI / 2; w.position.set(s * halfW, 0.34, z);
    g.add(w);
  }
}
// Готовые модели машин (Kenney Car Kit, CC0). Пока не загрузились — рисуются коробки.
const CAR_FILES = {
  car: [],                                                                  // легковые теперь только отечественные (наборы ниже)
  van: ['van', 'delivery', 'truck', 'truck-flat', 'delivery-flat'],          // без «скорой», мусоровоза и пожарной из набора
};
const CAR_WIDTH = { car: 2.0, van: 2.25 };
const carModels = { car: [], van: [] };
const gltfLoader = new GLTFLoader();
for (const kind of Object.keys(CAR_FILES)) for (const name of CAR_FILES[kind]) {
  gltfLoader.load(`models/cars/${name}.glb`, (gltf) => {
    const model = gltf.scene;
    const size = new THREE.Box3().setFromObject(model).getSize(new THREE.Vector3());
    const k = CAR_WIDTH[kind] / size.x;
    model.scale.setScalar(k);
    const b = new THREE.Box3().setFromObject(model);
    const c = b.getCenter(new THREE.Vector3());
    model.position.set(-c.x, -b.min.y, -c.z);
    const template = new THREE.Group();
    template.add(model);
    template.rotation.y = Math.PI; // капотом вперёд по ходу движения
    carModels[kind].push({ template, len: size.z * k, height: size.y * k });
  });
}
// «Жигули», «Волги», «Нива» и другие из набора Low Poly Soviet Cars Pack (Vitaly Tyavin, Unity Asset Store).
// Все машины красятся одной палитрой-картинкой; вершины кузова помечены в файле, и цвет меняется сдвигом их координат в палитре.
const USSR_FILES = ['vz01', 'vz02', 'vz03', 'vz04', 'vz05', 'vz05r', 'vz06', 'vz07', 'vz08', 'vz09', 'vz099', 'vz21', 'vz31', 'gz21', 'gz24'];
const USSR_WIDTH = { gz21: 1.85, gz24: 1.85, vz21: 1.75 };
const USSR_PALETTE = { white: [0.945, 0.28], red: [0.278, 0.78], blue: [0.5, 0.78], green: [0.055, 0.78], yellow: [0.385, 0.78], black: [0.94, 0.79], gray: [0.725, 0.78], sand: [0.838, 0.79], purple: [0.61, 0.78], lightblue: [0.168, 0.79] };
const USSR_COLORS = ['white', 'white', 'red', 'red', 'blue', 'green', 'green', 'yellow', 'black', 'gray', 'gray', 'sand', 'sand', 'purple', 'lightblue', 'lightblue'];
const ussrTex = new THREE.TextureLoader().load('models/cars/ussr/albedo.png');
ussrTex.colorSpace = THREE.SRGBColorSpace; ussrTex.flipY = false; ussrTex.magFilter = ussrTex.minFilter = THREE.NearestFilter; ussrTex.generateMipmaps = false;
const ussrMat = new THREE.MeshLambertMaterial({ map: ussrTex, flatShading: true });
for (const name of USSR_FILES) gltfLoader.load(`models/cars/ussr/${name}.glb`, (gltf) => {
  const m = gltf.scene;
  m.traverse((o) => { if (o.isMesh) o.material = ussrMat; });
  const pivot = new THREE.Group(); pivot.add(m);
  const s0 = new THREE.Box3().setFromObject(pivot).getSize(new THREE.Vector3());
  if (s0.x > s0.z) m.rotation.y += Math.PI / 2;
  const s1 = new THREE.Box3().setFromObject(pivot).getSize(new THREE.Vector3()), k = (USSR_WIDTH[name] ?? 1.7) / s1.x;
  pivot.scale.setScalar(k);
  const b = new THREE.Box3().setFromObject(pivot), c = b.getCenter(new THREE.Vector3());
  pivot.position.set(-c.x, -b.min.y, -c.z);
  const template = new THREE.Group(); template.add(pivot);
  template.rotation.y = USSR_TURN;
  const entry = { template, len: s1.z * k, height: s1.y * k, uvPaint: true, name };
  carModels.car.push(entry); ussrByName[name] = entry;
});
const USSR_TURN = Math.PI, ussrByName = {}; // в файлах машины смотрят назад
function paintUssr(obj, color = pick(USSR_COLORS)) { // перекрасить кузов: помеченные вершины переезжают в нужную клетку палитры
  const [u, v] = USSR_PALETTE[color];
  obj.traverse((o) => {
    const flag = o.isMesh && o.geometry.attributes._paint; if (!flag) return;
    const geo = o.geometry.clone(), uv = geo.attributes.uv.clone();
    for (let i = 0; i < flag.count; i++) if (flag.getX(i) > 0.5) uv.setXY(i, u, v);
    geo.setAttribute('uv', uv); o.geometry = geo; o.userData.ownGeo = true;
  });
}
// Советские и российские машины из набора пользователя: «копейка», «Таврия», УАЗ-469, грузовая «Газель», автобус ЛиАЗ-677
const SOVIET = { Vaz2101: ['car', 1.72], Tavria: ['car', 1.62], Uaz469: ['car', 1.9], Gazelle_Cargo: ['van', 2.2], Liaz_677_Bus: ['bus', 2.5] };
const SOVIET_PAINT = [0xc8402f, 0xe6dcc0, 0x3f6fa8, 0x5a8f4e, 0xd9a521, 0xf2f1ea, 0x8a2d2d, 0x6b7f8e, 0x2f4f6b, 0xb9c4c9];
const SOVIET_FIXED = { Glass: 0x26303c, Black: 0x1c1d20, 'Black 2': 0x1c1d20, Frontlight: 0xfff0b8, StopLight: 0xd3262c, Backlight: 0xd3262c, TurnLight: 0xff9d1c };
const SOVIET_COLORS = { Vaz2101: SOVIET_PAINT, Tavria: SOVIET_PAINT, Uaz469: [0x4f5d3a, 0x5d6b47, 0x7a7f6a, 0x6b7f8e, 0xc9bfa0], Gazelle_Cargo: [0xf2f1ea, 0xf2f1ea, 0x3f6fa8, 0xb9c4c9], Liaz_677_Bus: [0xf2f1ea, 0xe0a81e, 0xe6b93a] };
const sovietBuses = [], sovietByName = {};
gltfLoader.load('models/cars/soviet.glb', (gltf) => {
  for (const node of [...gltf.scene.children]) {
    const conf = SOVIET[node.name]; if (!conf) continue;
    const [kind, width] = conf;
    node.position.set(0, 0, 0); node.updateMatrixWorld(true);
    node.traverse((o) => { // простые материалы, как у всего транспорта; кузов помечаем — его красим при появлении машины
      if (!o.isMesh) return;
      o.userData.matName = o.material.name;
      o.material = mat(SOVIET_FIXED[o.material.name] ?? o.material.color.getHex());
    });
    // кузов — самая большая деталь не из стекла, фар и чёрного пластика: её и перекрашиваем
    let bodyMesh = null, most = 0;
    node.traverse((o) => { if (o.isMesh && !(o.userData.matName in SOVIET_FIXED) && !/Metal/.test(o.userData.matName)) { const cnt = (o.geometry.index ?? o.geometry.attributes.position).count; if (cnt > most) { most = cnt; bodyMesh = o; } } });
    if (bodyMesh) bodyMesh.userData.paint = true;
    const pivot = new THREE.Group(); pivot.add(node);
    const s0 = new THREE.Box3().setFromObject(pivot).getSize(new THREE.Vector3());
    if (s0.x > s0.z) node.rotation.y += Math.PI / 2;                 // длинной стороной вдоль дороги
    const s1 = new THREE.Box3().setFromObject(pivot).getSize(new THREE.Vector3()), k = width / s1.x;
    pivot.scale.setScalar(k);
    const b = new THREE.Box3().setFromObject(pivot), c = b.getCenter(new THREE.Vector3());
    pivot.position.set(-c.x, -b.min.y, -c.z);
    const template = new THREE.Group(); template.add(pivot);
    template.rotation.y = Math.PI; // в файле машины смотрят назад — разворачиваем капотом по ходу
    const entry = { template, len: s1.z * k, height: s1.y * k, paint: SOVIET_COLORS[node.name], width };
    sovietByName[node.name] = entry;
    if (kind === 'bus') sovietBuses.push(entry); else carModels[kind].push(entry, entry); // дважды — чтобы встречались чаще иномарок из набора
  }
});
function paintCar(obj, colors) { const m = mat(pick(colors)); obj.traverse((o) => { if (o.userData.paint) o.material = m; }); }
// Службы на базе наших машин: милицейский УАЗ с синей полосой и маячком, жёлтое такси-«копейка» с шашечками
function makeService(kind) {
  const e = sovietByName[kind === 'police' ? 'Uaz469' : 'Vaz2101'], g = new THREE.Group(), t = e.template.clone();
  paintCar(t, [kind === 'police' ? 0xf2f1ea : 0xf2c230]);
  g.add(t);
  const w = e.width / 2 + 0.015, len = e.len;
  if (kind === 'police') {
    for (const sx of [-1, 1]) g.add(box(0.03, 0.2, len * 0.72, 0x2f5fb0, sx * w, e.height * 0.5, 0));
    g.add(box(0.5, 0.12, 0.2, 0x2f5fb0, -0.28, e.height + 0.05, -0.2), box(0.5, 0.12, 0.2, 0xd3262c, 0.28, e.height + 0.05, -0.2));
  } else {
    g.add(box(0.46, 0.15, 0.2, 0xfff0b8, 0, e.height + 0.06, 0), box(0.48, 0.05, 0.22, 0x1c1d20, 0, e.height + 0.02, 0));
    for (const sx of [-1, 1]) for (let i = -3; i <= 3; i++) g.add(box(0.03, 0.09, 0.14, i % 2 ? 0x1c1d20 : 0xf2f1ea, sx * w, e.height * 0.52, i * 0.16));
  }
  g.userData = { type: 'vehicle', halfLen: len / 2, height: e.height, moving: true };
  return g;
}
function makeLiaz() { // ЛиАЗ-677: жёлтый городской автобус, по крыше можно ехать
  const e = sovietBuses[0], g = new THREE.Group(), t = e.template.clone();
  paintCar(t, e.paint);
  g.add(t);
  g.userData = { type: 'vehicle', halfLen: e.len / 2, height: e.height, moving: true, roof: e.height };
  return g;
}
// ---------- Крупный транспорт: автобусы, троллейбус, фура ----------
const bigWheelGeo = new THREE.CylinderGeometry(0.5, 0.5, 0.32, 14);
function addBigWheels(g, halfW, zs) {
  for (const z of zs) for (const s of [-1, 1]) {
    const w = new THREE.Mesh(bigWheelGeo, mat(0x17171a)); w.rotation.z = Math.PI / 2; w.position.set(s * halfW, 0.5, z);
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.34, 10), mat(0x9aa0a6)); hub.rotation.z = Math.PI / 2; hub.position.copy(w.position);
    g.add(w, hub);
  }
}
const vehTex = {};
const BUS_STYLES = {
  city: [{ body: '#f4f4f0', stripe: '#2a8f5f', skirt: '#d9d9d2' }, { body: '#f4f4f0', stripe: '#2f6fd0', skirt: '#d9d9d2' }, { body: '#f2c230', stripe: '#3a3a3a', skirt: '#d0a520' }],
  trolley: [{ body: '#e9eef5', stripe: '#2f6fd0', skirt: '#2f6fd0' }],
  coach: [{ body: '#b3202a', stripe: '#f4f4f0', skirt: '#8a1820' }, { body: '#1f3a6e', stripe: '#f2c230', skirt: '#182c54' }],
};
function busTextures(variant, i) {
  const key = variant + i, st = BUS_STYLES[variant][i], route = String(pick([339, 418, 461, 1054, 27, 5, 12, 33]));
  return (vehTex[key] ||= {
    side: canvasTexture(1024, 256, (c, w, h) => {
      c.fillStyle = st.body; c.fillRect(0, 0, w, h);
      c.fillStyle = st.skirt; c.fillRect(0, 196, w, 60);
      c.fillStyle = st.stripe; c.fillRect(0, 150, w, variant === 'coach' ? 14 : 26);
      c.fillStyle = '#1c2530'; // стёкла
      if (variant === 'coach') c.fillRect(40, 34, w - 80, 96);
      else for (let x = 30; x < w - 60; x += 92) c.fillRect(x, 30, 80, 104);
      const doors = variant === 'coach' ? [0.9] : [0.1, 0.5, 0.88];
      for (const d of doors) { c.fillStyle = '#2b3642'; c.fillRect(d * w - 34, 26, 68, 206); c.fillStyle = '#8fa3b3'; c.fillRect(d * w - 28, 34, 26, 120); c.fillRect(d * w + 2, 34, 26, 120); c.fillStyle = st.body; c.fillRect(d * w - 1, 26, 2, 206); }
      for (const f of [0.173, 0.827]) { c.fillStyle = '#15171a'; c.beginPath(); c.arc(f * w, 256, 58, Math.PI, 0); c.fill(); } // колёсные арки
      c.fillStyle = 'rgba(0,0,0,0.18)'; c.fillRect(0, 0, w, 10);
      c.fillStyle = '#111'; c.fillRect(300, 4, 110, 26); c.fillStyle = '#ffb000'; c.font = 'bold 22px sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(route, 355, 18);
    }),
    rear: canvasTexture(256, 256, (c, w, h) => {
      c.fillStyle = st.body; c.fillRect(0, 0, w, h);
      c.fillStyle = '#1c2530'; c.fillRect(24, 30, w - 48, 86);
      c.fillStyle = st.stripe; c.fillRect(0, 150, w, 22);
      c.fillStyle = '#2a2d31'; c.fillRect(60, 180, w - 120, 50); c.strokeStyle = '#111'; for (let y = 186; y < 228; y += 7) { c.beginPath(); c.moveTo(64, y); c.lineTo(w - 64, y); c.stroke(); } // решётка двигателя
      for (const x of [14, w - 46]) { c.fillStyle = '#ff2a2a'; c.fillRect(x, 176, 32, 22); c.fillStyle = '#ffa200'; c.fillRect(x, 202, 32, 12); }
      c.fillStyle = '#111'; c.fillRect(92, 6, 72, 22); c.fillStyle = '#ffb000'; c.font = 'bold 20px sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(route, 128, 18);
      c.fillStyle = '#f4f4f0'; c.fillRect(98, 232, 60, 16);
    }),
    front: canvasTexture(256, 256, (c, w, h) => {
      c.fillStyle = st.body; c.fillRect(0, 0, w, h);
      c.fillStyle = '#111'; c.fillRect(30, 8, w - 60, 30); c.fillStyle = '#ffb000'; c.font = 'bold 24px sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(route + '  ОДИНЦОВО', 128, 24, w - 70);
      c.fillStyle = '#1c2530'; c.fillRect(16, 44, w - 32, 110);
      c.fillStyle = st.stripe; c.fillRect(0, 160, w, 20);
      for (const x of [18, w - 58]) { c.fillStyle = '#fff6c8'; c.fillRect(x, 190, 40, 22); }
      c.fillStyle = '#2a2d31'; c.fillRect(70, 190, w - 140, 40);
    }),
    roof: st.body,
  });
}
function makeBus(variant = pick(['suburb', 'suburb', 'suburb', 'city', 'trolley', 'coach', 'liaz', 'liaz'])) {
  if (variant === 'liaz') { if (sovietBuses.length) return makeLiaz(); variant = 'city'; }
  if (variant === 'suburb') return makePhotoVehicle('suburb');
  const g = new THREE.Group(), len = 11, i = Math.floor(Math.random() * BUS_STYLES[variant].length), t = busTextures(variant, i);
  const L = (tex) => lambertMap('veh_' + variant + i + tex.uuid, tex);
  const body = new THREE.Mesh(new THREE.BoxGeometry(2.5, 2.65, len), [L(t.side), L(t.side), mat(new THREE.Color(t.roof).getHex()), mat(0x222428), L(t.rear), L(t.front)]);
  body.position.y = 1.775; g.add(body);
  addBigWheels(g, 1.13, [-3.6, 3.6]);
  g.add(box(2.3, 0.06, len - 0.4, 0x8d99ae, 0, 3.13, 0));                            // крыша: по ней можно ехать
  for (const z of [-2.5, 2]) g.add(box(1.1, 0.12, 1.3, 0xb8bec6, 0, 3.2, z));          // люки
  for (const s of [-1, 1]) g.add(box(0.12, 0.3, 0.2, 0x222428, s * 1.38, 2.3, -len / 2 + 0.3)); // зеркала
  g.add(box(2.56, 0.3, 0.14, 0x2a2d31, 0, 0.55, len / 2 + 0.02), box(2.56, 0.3, 0.14, 0x2a2d31, 0, 0.55, -len / 2 - 0.02)); // бамперы
  if (variant === 'trolley') for (const s of [-1, 1]) { const pole = box(0.07, 0.07, 6.2, 0x3d4046, s * 0.35, 4.25, 2.2); pole.rotation.x = 0.36; g.add(pole); } // штанги
  g.userData = { type: 'vehicle', halfLen: len / 2, height: 3.1, moving: true, roof: 3.1 };
  return g;
}
// ---------- Транспорт по фотографиям: пригородный автобус и две маршрутки ----------
// Кузов собирается из сечений вдоль машины (нос, капот, лобовое, крыша, корма), грани плоские — как у остальных машин.
// Материалы граней: [правый борт, левый борт, верх, низ, корма, перёд]; картинки на борта кладутся проекцией сбоку, на перёд и корму — спереди.
function ring(z, w, y0, y1, tumble = 0.05, ch = 0.1) {
  const yb = y0 + (y1 - y0) * 0.5, t = w - tumble;
  return { z, pts: [[-w, y0], [w, y0], [w, yb], [t, y1 - ch], [t - ch, y1], [-(t - ch), y1], [-t, y1 - ch], [-w, yb]] };
}
function loftBody(rings) {
  let xMax = 0, yMin = 1e9, yMax = -1e9;
  for (const r of rings) for (const [x, y] of r.pts) { xMax = Math.max(xMax, Math.abs(x)); yMin = Math.min(yMin, y); yMax = Math.max(yMax, y); }
  const zMin = rings[0].z, zMax = rings[rings.length - 1].z, yMid = (yMin + yMax) / 2;
  const buckets = [[], [], [], [], [], []];
  const a = new THREE.Vector3(), b = new THREE.Vector3(), n = new THREE.Vector3();
  const tri = (p, q, r, out, forced) => {
    n.crossVectors(a.subVectors(q, p), b.subVectors(r, p));
    if (n.lengthSq() < 1e-10) return null;
    n.normalize();
    if (out(n) < 0) { n.negate(); [q, r] = [r, q]; }
    const m = forced ?? (n.y < -0.7 ? 3 : Math.abs(n.x) > 0.55 ? (n.x > 0 ? 0 : 1) : n.y > 0.75 ? 2 : n.z < 0 ? 5 : 4);
    for (const v of [p, q, r]) {
      const uv = m < 2 ? [(m === 0 ? zMax - v.z : v.z - zMin) / (zMax - zMin), (v.y - yMin) / (yMax - yMin)]
        : m >= 4 ? [(m === 5 ? xMax - v.x : v.x + xMax) / (2 * xMax), (v.y - yMin) / (yMax - yMin)] : [0.5, 0.5];
      buckets[m].push(v.x, v.y, v.z, n.x, n.y, n.z, uv[0], uv[1]);
    }
    return m;
  };
  const P = (r, i) => new THREE.Vector3(r.pts[i % 8][0], r.pts[i % 8][1], r.z);
  for (let k = 0; k < rings.length - 1; k++) for (let i = 0; i < 8; i++) {
    const p0 = P(rings[k], i), p1 = P(rings[k], i + 1), q1 = P(rings[k + 1], i + 1), q0 = P(rings[k + 1], i);
    const c = p0.clone().add(p1).add(q1).add(q0).multiplyScalar(0.25);
    const out = (nn) => nn.x * c.x + nn.y * (c.y - yMid);
    const m = tri(p0, p1, q1, out);
    tri(p0, q1, q0, out, m ?? undefined);
  }
  for (const [r, s] of [[rings[0], -1], [rings[rings.length - 1], 1]]) for (let i = 1; i < 7; i++) tri(P(r, 0), P(r, i), P(r, i + 1), (nn) => nn.z * s, s < 0 ? 5 : 4);
  const geo = new THREE.BufferGeometry(), all = buckets.flat(), cnt = all.length / 8;
  const pos = new Float32Array(cnt * 3), nor = new Float32Array(cnt * 3), uvs = new Float32Array(cnt * 2);
  for (let i = 0; i < cnt; i++) { pos.set(all.slice(i * 8, i * 8 + 3), i * 3); nor.set(all.slice(i * 8 + 3, i * 8 + 6), i * 3); uvs.set(all.slice(i * 8 + 6, i * 8 + 8), i * 2); }
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3)); geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3)); geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  let start = 0;
  buckets.forEach((bk, m) => { geo.addGroup(start, bk.length / 8, m); start += bk.length / 8; });
  return { geo, zMin, zMax, yMin, yMax, xMax };
}
// кисть в метрах: h — координата вдоль картинки (z для борта, x для переда), y — высота над землёй
function vehPainter(c, w, hpx, h0, h1, y0, y1, flip = false) {
  const kx = w / (h1 - h0), ky = hpx / (y1 - y0);
  const X = (h) => (flip ? h1 - h : h - h0) * kx, Y = (y) => (y1 - y) * ky;
  const span = (ha, hb) => [Math.min(X(ha), X(hb)), Math.abs(X(hb) - X(ha))];
  return {
    X, Y,
    rect(ha, ya, hb, yb, col) { const [x, ww] = span(ha, hb); c.fillStyle = col; c.fillRect(x, Y(yb), ww, (yb - ya) * ky); },
    glass(ha, ya, hb, yb, r = 0.06) { // стекло: отражение неба сверху, темнее книзу, косой блик
      const [x, ww] = span(ha, hb), g = c.createLinearGradient(0, Y(yb), 0, Y(ya));
      g.addColorStop(0, '#52677d'); g.addColorStop(0.55, '#2a3644'); g.addColorStop(1, '#1a222c');
      c.fillStyle = g; c.beginPath(); c.roundRect(x, Y(yb), ww, (yb - ya) * ky, r * ky); c.fill();
      c.save(); c.clip(); c.fillStyle = 'rgba(255,255,255,0.10)'; c.beginPath(); c.moveTo(x + ww * 0.55, Y(yb)); c.lineTo(x + ww * 0.8, Y(yb)); c.lineTo(x + ww * 0.45, Y(ya)); c.lineTo(x + ww * 0.2, Y(ya)); c.fill(); c.restore();
    },
    arch(h, y, r, col = '#15171a') { c.fillStyle = col; c.beginPath(); c.ellipse(X(h), Y(y), r * kx, r * ky, 0, 0, 7); c.fill(); },
    text(s, h, y, size, col, maxM = 9) { c.fillStyle = col; c.font = `bold ${Math.round(size * ky)}px sans-serif`; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(s, X(h), Y(y), maxM * kx); },
    line(ha, ya, hb, yb, col = 'rgba(0,0,0,0.3)', lw = 2) { c.strokeStyle = col; c.lineWidth = lw; c.beginPath(); c.moveTo(X(ha), Y(ya)); c.lineTo(X(hb), Y(yb)); c.stroke(); },
    shade() { const g = c.createLinearGradient(0, 0, 0, hpx); g.addColorStop(0, 'rgba(255,255,255,0.10)'); g.addColorStop(0.5, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(20,20,35,0.22)'); c.fillStyle = g; c.fillRect(0, 0, w, hpx); },
  };
}
const smallWheelGeo = {};
function addWheelsR(g, halfW, zs, r) {
  const tyre = (smallWheelGeo[r] ||= new THREE.CylinderGeometry(r, r, 0.28, 14)), hubG = (smallWheelGeo['h' + r] ||= new THREE.CylinderGeometry(r * 0.5, r * 0.5, 0.3, 10));
  for (const z of zs) for (const s of [-1, 1]) {
    const w = new THREE.Mesh(tyre, mat(0x17171a)); w.rotation.z = Math.PI / 2; w.position.set(s * halfW, r, z);
    const hub = new THREE.Mesh(hubG, mat(0xa9afb5)); hub.rotation.z = Math.PI / 2; hub.position.copy(w.position);
    g.add(w, hub);
  }
}
const V_WHITE = '#f3f3ef', V_YELLOW = '#f2b632', V_GREY = '#8a9097', V_DARK = '#1d2024';
const plate = (p, y, col = '#f4f4f0') => { p.rect(-0.28, y, 0.28, y + 0.13, col); p.text('• • • •', 0, y + 0.065, 0.1, '#333', 0.5); };
const PHOTO_VEHICLES = {
  // пригородный низкопольный автобус (белый, сплошная лента стёкол, чёрная «улыбка» под лобовым, табло с номером маршрута)
  suburb: {
    rings: () => [ring(-5.8, 1.14, 0.4, 1.3, 0.02, 0.05), ring(-5.5, 1.25, 0.4, 3.0, 0.03, 0.1), ring(-5.2, 1.25, 0.4, 3.1, 0.03, 0.12), ring(5.65, 1.25, 0.4, 3.1, 0.03, 0.12), ring(5.8, 1.2, 0.45, 3.0, 0.03, 0.1)],
    wheels: [1.12, [-3.5, 3.4], 0.5], roof: 3.1, routes: ['339', '339', '461', '418', '1054'],
    side(p, right, route) {
      p.rect(-6, 0, 6, 4, V_WHITE); p.rect(-6, 0, 6, 0.72, '#dcdcd6'); p.rect(-6, 2.96, 6, 4, '#e2e3e0');
      p.rect(-5.62, 1.5, 5.55, 2.8, V_DARK);
      for (let z = -5.5; z < 5.3; z += 1.55) p.glass(z, 1.56, Math.min(z + 1.47, 5.5), 2.74);
      p.rect(-5.8, 1.2, -5.2, 1.5, V_DARK);                                   // чёрная маска заходит на борт
      if (right) for (const [z0, z1] of [[-5.05, -3.95], [-0.9, 0.5]]) {     // двери
        p.rect(z0, 0.55, z1, 2.85, V_DARK); const m = (z0 + z1) / 2;
        p.glass(z0 + 0.07, 0.8, m - 0.03, 2.72); p.glass(m + 0.03, 0.8, z1 - 0.07, 2.72);
      }
      for (const z of [-3.5, 3.4]) p.arch(z, 0.42, 0.66);
      p.rect(3.9, 0.9, 5.4, 1.35, '#d0d1cc'); for (let y = 0.96; y < 1.33; y += 0.08) p.line(3.95, y, 5.35, y, 'rgba(0,0,0,0.25)', 1); // решётка моторного отсека
      p.rect(-3.0, 2.3, -2.3, 2.7, '#f4f4f0'); p.text(route, -2.65, 2.5, 0.34, '#c8202a', 0.6);
      p.line(-6, 1.42, 6, 1.42, 'rgba(0,0,0,0.12)'); p.shade();
    },
    front(p, route) {
      p.rect(-2, 0, 2, 4, V_WHITE);
      p.rect(-1.25, 1.2, 1.25, 3.1, V_DARK); p.glass(-1.14, 1.5, 1.14, 2.66, 0.1);
      p.rect(-1.1, 2.7, 1.1, 3.02, '#f6f6f2'); p.text(route, -0.72, 2.86, 0.3, '#c8202a', 0.6); p.text('ОДИНЦОВО — МОСКВА', 0.28, 2.86, 0.15, '#1f3a6e', 1.35);
      p.rect(-0.75, 1.24, 0.75, 1.44, '#2c3036');                           // панель под стеклом
      p.rect(-1.25, 0.4, 1.25, 1.2, V_WHITE); p.rect(-1.25, 0.4, 1.25, 0.55, '#d6d6d0');
      for (const s of [-1, 1]) { p.arch(s * 0.86, 0.86, 0.14, '#3a4048'); p.arch(s * 0.86, 0.86, 0.11, '#fff3b0'); p.arch(s * 0.6, 0.86, 0.11, '#3a4048'); p.arch(s * 0.6, 0.86, 0.085, '#e9eef2'); p.arch(s * 1.02, 1.08, 0.07, '#ff9d1c'); }
      for (let y = 0.66; y < 0.8; y += 0.05) p.line(-0.4, y, 0.4, y, 'rgba(0,0,0,0.35)', 2);
      plate(p, 0.9, '#f2c230'); p.shade();
    },
    rear(p, route) {
      p.rect(-2, 0, 2, 4, V_WHITE); p.rect(-1.25, 1.85, 1.25, 2.9, V_DARK); p.glass(-1.05, 1.95, 1.05, 2.62);
      p.rect(-0.35, 2.66, 0.35, 2.86, '#111'); p.text(route, 0, 2.76, 0.18, '#ffb000', 0.6);
      p.rect(-0.85, 0.8, 0.85, 1.55, '#d0d1cc'); for (let y = 0.88; y < 1.5; y += 0.09) p.line(-0.8, y, 0.8, y, 'rgba(0,0,0,0.3)', 2);
      for (const s of [-1, 1]) { p.rect(s * 0.95, 1.0, s * 1.17, 1.45, '#e0252b'); p.rect(s * 0.95, 1.47, s * 1.17, 1.62, '#ff9d1c'); }
      p.rect(-1.25, 0.4, 1.25, 0.62, '#2a2d31'); plate(p, 0.66, '#f2c230'); p.shade();
    },
  },
  // маршрутка с капотом: высокая крыша, белый кузов, жёлтая и серая полосы по борту
  minibus: {
    rings: () => [ring(-3.45, 0.86, 0.4, 0.95, 0.02, 0.05), ring(-3.3, 0.98, 0.4, 1.13, 0.03, 0.06), ring(-2.05, 1.03, 0.4, 1.36, 0.03, 0.06), ring(-1.2, 1.03, 0.4, 2.48, 0.1, 0.1), ring(-0.75, 1.03, 0.4, 2.75, 0.1, 0.12), ring(2.95, 1.03, 0.4, 2.75, 0.1, 0.12), ring(3.1, 0.98, 0.45, 2.66, 0.1, 0.1)],
    wheels: [0.9, [-2.35, 1.95], 0.38], roof: 0, routes: ['11к', '15к', '103', '1055', '33к'],
    side(p, right, route) {
      p.rect(-4, 0, 4, 4, V_WHITE);
      p.rect(-4, 0.4, 4, 0.62, '#2a2d31');
      p.rect(-1.9, 0.98, 3.1, 1.16, (this.stripe || V_YELLOW)); p.rect(-1.9, 0.88, 3.1, 0.94, V_GREY);
      p.glass(-1.95, 1.5, -1.05, 2.25, 0.1); p.rect(-2.3, 1.5, -1.9, 2.0, V_WHITE);     // стекло двери водителя
      p.rect(-2.05, 1.42, -1.85, 1.62, '#1d2024');                                    // зеркало
      p.rect(-0.9, 1.5, 2.9, 2.3, V_DARK); for (const [a, b] of [[-0.86, 0.3], [0.36, 1.6], [1.66, 2.86]]) p.glass(a, 1.54, b, 2.26);
      if (right) { p.line(-0.95, 0.62, -0.95, 2.6); p.line(0.38, 0.62, 0.38, 2.6); p.rect(-0.8, 1.3, -0.5, 1.36, '#555'); } // сдвижная дверь
      p.line(-1.05, 0.62, -1.05, 2.4); p.line(-2.0, 0.62, -2.0, 1.45);
      for (const z of [-2.35, 1.95]) p.arch(z, 0.4, 0.52);
      p.rect(-3.45, 0.9, -2.95, 1.1, '#e6ecf0'); p.line(-3.3, 1.14, -2.0, 1.37, 'rgba(0,0,0,0.22)');                                       // фара заходит на крыло
      p.rect(2.98, 1.1, 3.1, 2.0, '#d3262c');
      p.shade();
    },
    front(p, route) {
      p.rect(-2, 0, 2, 4, V_WHITE);
      p.rect(-1.03, 0.4, 1.03, 0.7, '#2a2d31');
      p.rect(-0.56, 0.7, 0.56, 0.93, '#22252a'); for (let y = 0.75; y < 0.92; y += 0.06) p.line(-0.5, y, 0.5, y, 'rgba(255,255,255,0.18)', 2);
      for (const s of [-1, 1]) { p.rect(s * 0.5, 0.9, s * 0.96, 1.12, '#3a4048'); p.rect(s * 0.53, 0.92, s * 0.93, 1.1, '#dfe7ec'); p.arch(s * 0.76, 1.01, 0.07, '#fff3b0'); p.arch(s * 0.78, 0.56, 0.06, '#dfe6ea'); }
      p.glass(-0.93, 1.46, 0.93, 2.42, 0.12);
      p.rect(-0.85, 2.14, -0.3, 2.38, '#f6f6f2'); p.text(route, -0.575, 2.26, 0.2, '#c8202a', 0.5);
      p.rect(-0.6, 2.52, 0.6, 2.7, (this.stripe || V_YELLOW));
      plate(p, 0.5); p.shade();
    },
    rear(p, route) {
      p.rect(-2, 0, 2, 4, V_WHITE); p.rect(-1.03, 0.4, 1.03, 0.66, '#2a2d31');
      p.rect(-1.03, 0.98, 1.03, 1.16, (this.stripe || V_YELLOW)); p.rect(-1.03, 0.88, 1.03, 0.94, V_GREY);
      for (const s of [-1, 1]) { p.glass(s * 0.06, 1.55, s * 0.8, 2.25); p.rect(s * 0.86, 1.2, s * 1.0, 2.1, '#d3262c'); p.rect(s * 0.86, 1.75, s * 1.0, 1.9, '#ff9d1c'); }
      p.line(0, 0.66, 0, 2.6); p.rect(-0.32, 2.3, 0.32, 2.5, '#f6f6f2'); p.text(route, 0, 2.4, 0.17, '#c8202a', 0.6);
      plate(p, 0.72); p.shade();
    },
  },
  // маршрутка-автобус: курносый малый автобус с чёрной маской вокруг лобового и жёлтой полосой
  midibus: {
    rings: () => [ring(-3.6, 1.04, 0.42, 1.25, 0.02, 0.05), ring(-3.38, 1.15, 0.42, 2.86, 0.04, 0.1), ring(-3.1, 1.15, 0.42, 2.95, 0.04, 0.12), ring(3.48, 1.15, 0.42, 2.95, 0.04, 0.12), ring(3.6, 1.1, 0.46, 2.88, 0.04, 0.1)],
    wheels: [1.02, [-2.55, 2.05], 0.44], roof: 2.95, routes: ['44к', '103', '2', '5', '26'],
    side(p, right, route) {
      p.rect(-4, 0, 4, 4, V_WHITE); p.rect(-3.6, 0.42, 3.6, 0.66, '#d9d9d3');
      p.rect(-3.6, 1.25, -2.95, 2.95, V_DARK);                                           // маска заходит на борт
      p.rect(-3.0, 1.5, 3.35, 2.66, V_DARK); for (let z = -2.9; z < 3.2; z += 1.26) p.glass(z, 1.56, Math.min(z + 1.18, 3.3), 2.6);
      p.rect(-0.6, 1.2, 3.6, 1.38, V_YELLOW); p.rect(-0.6, 1.1, 3.6, 1.16, V_GREY);
      if (right) { p.rect(-1.75, 0.6, -0.7, 2.75, V_DARK); p.glass(-1.69, 0.8, -1.25, 2.66); p.glass(-1.2, 0.8, -0.76, 2.66); }
      else { p.rect(-3.0, 1.2, -0.6, 1.38, V_YELLOW); p.rect(-3.0, 1.1, -0.6, 1.16, V_GREY); }
      for (const z of [-2.55, 2.05]) p.arch(z, 0.42, 0.6);
      p.rect(2.3, 2.2, 2.9, 2.55, '#f6f6f2'); p.text(route, 2.6, 2.375, 0.28, '#c8202a', 0.55);
      p.shade();
    },
    front(p, route) {
      p.rect(-2, 0, 2, 4, V_WHITE);
      p.rect(-1.15, 1.25, 1.15, 2.95, V_DARK); p.glass(-1.02, 1.42, 1.02, 2.5, 0.12);
      p.rect(-0.95, 2.56, 0.95, 2.84, '#f6f6f2'); p.text(route, -0.6, 2.7, 0.26, '#c8202a', 0.6); p.text('СТАНЦИЯ — ЦЕНТР', 0.3, 2.7, 0.13, '#222', 1.1);
      p.rect(-0.7, 0.72, 0.7, 1.08, '#22252a'); for (let y = 0.78; y < 1.06; y += 0.07) p.line(-0.65, y, 0.65, y, 'rgba(255,255,255,0.16)', 2);
      for (const s of [-1, 1]) { p.rect(s * 0.74, 0.84, s * 1.1, 1.16, '#3a4048'); p.rect(s * 0.77, 0.87, s * 1.07, 1.13, '#dfe7ec'); p.arch(s * 0.92, 1.0, 0.09, '#fff3b0'); p.arch(s * 0.92, 0.66, 0.06, '#dfe6ea'); }
      p.rect(-1.15, 0.42, 1.15, 0.6, '#2a2d31'); plate(p, 0.56); p.shade();
    },
    rear(p, route) {
      p.rect(-2, 0, 2, 4, V_WHITE); p.rect(-1.15, 1.6, 1.15, 2.95, V_DARK); p.glass(-0.95, 1.75, 0.95, 2.55);
      p.rect(-0.3, 2.62, 0.3, 2.84, '#f6f6f2'); p.text(route, 0, 2.73, 0.18, '#c8202a', 0.5);
      p.rect(-1.15, 1.2, 1.15, 1.38, V_YELLOW); p.rect(-1.15, 1.1, 1.15, 1.16, V_GREY);
      for (const s of [-1, 1]) { p.rect(s * 0.88, 0.7, s * 1.1, 1.05, '#d3262c'); p.rect(s * 0.66, 0.7, s * 0.86, 1.05, '#ff9d1c'); }
      p.rect(-1.15, 0.42, 1.15, 0.6, '#2a2d31'); plate(p, 0.76); p.shade();
    },
  },
};
PHOTO_VEHICLES.ambulance = { ...PHOTO_VEHICLES.minibus, stripe: '#d3262c', routes: ['03'] }; // скорая: та же машина с красной полосой и маячком
const photoVehCache = {};
function makePhotoVehicle(kind) {
  const mini = kind === 'minibus' || kind === 'ambulance';
  const def = PHOTO_VEHICLES[kind], route = pick(def.routes), key = kind + route;
  const body = (photoVehCache[kind] ||= loftBody(def.rings()));
  const mats = (photoVehCache[key] ||= (() => {
    const { zMin, zMax, yMin, yMax, xMax } = body;
    const side = (right) => lambertMap(key + (right ? 'R' : 'L'), canvasTexture(1024, 256, (c, w, h) => def.side(vehPainter(c, w, h, zMin, zMax, yMin, yMax, right), right, route)));
    const end = (name, flip) => lambertMap(key + name, canvasTexture(256, 256, (c, w, h) => def[name](vehPainter(c, w, h, -xMax, xMax, yMin, yMax, flip), route)));
    return [side(true), side(false), mat(0xe9e9e4), mat(0x222428), end('rear', false), end('front', true)];
  })());
  const g = new THREE.Group(), half = body.zMax;
  g.add(new THREE.Mesh(body.geo, mats));
  const [halfW, zs, r] = def.wheels;
  addWheelsR(g, halfW, zs, r);
  const top = body.yMax;
  for (const s of [-1, 1]) g.add(box(0.1, mini ? 0.26 : 0.4, 0.2, 0x1d2024, s * (body.xMax + 0.14), mini ? 1.62 : top - 0.75, -half + (mini ? 1.2 : 0.2))); // зеркала
  if (!mini) { g.add(box(body.xMax * 2 - 0.3, 0.05, half * 2 - 0.9, 0x8d99ae, 0, top + 0.02, 0.1)); for (const z of [-half * 0.4, half * 0.35]) g.add(box(0.9, 0.1, 1.0, 0xb8bec6, 0, top + 0.08, z)); } // крыша с люками
  else g.add(box(0.7, 0.08, 0.9, 0xc9ced3, 0, top + 0.04, 0.8));
  if (kind === 'ambulance') g.add(box(1.1, 0.14, 0.24, 0x2f5fb0, 0, top + 0.07, -half + 1.9), box(0.5, 0.5, 0.04, 0xd3262c, 0, 1.75, half + 0.03), box(0.16, 0.5, 0.05, 0xf3f3ef, 0, 1.75, half + 0.035), box(0.5, 0.16, 0.05, 0xf3f3ef, 0, 1.75, half + 0.035));
  const off = -(body.zMin + body.zMax) / 2; // кузов может быть несимметричным (длинный нос) — центрируем
  for (const ch of g.children) ch.position.z += off;
  g.userData = { type: 'vehicle', halfLen: (body.zMax - body.zMin) / 2, height: top, moving: true, roof: def.roof };
  return g;
}
const TRAILERS = [['ПРОДУКТЫ', '#f4f4f0', '#2a8f5f'], ['ДОСТАВКА', '#2f6fd0', '#ffffff'], ['МЕБЕЛЬ', '#e9e3d5', '#7a4a2a'], ['СТРОЙМАТЕРИАЛЫ', '#d98a2b', '#ffffff'], ['', '#c9ced3', '#c9ced3']];
function makeSemi() { // фура: тягач с длинным прицепом
  const g = new THREE.Group(), len = 13.5, half = len / 2, [text, bg, fg] = pick(TRAILERS), cab = pick([0xc1121f, 0x1d3557, 0xf4f4f0, 0x2a9d8f]);
  const key = 'semi' + text;
  const tex = (vehTex[key] ||= {
    side: canvasTexture(1024, 256, (c, w, h) => { c.fillStyle = bg; c.fillRect(0, 0, w, h); c.strokeStyle = 'rgba(0,0,0,.12)'; for (let x = 0; x < w; x += 64) c.strokeRect(x + 0.5, 0.5, 64, h); drawText(c, text, w / 2, h / 2, 110, fg, w - 120); c.fillStyle = 'rgba(0,0,0,.22)'; c.fillRect(0, h - 22, w, 22); }),
    rear: canvasTexture(256, 256, (c, w, h) => { c.fillStyle = bg; c.fillRect(0, 0, w, h); c.strokeStyle = 'rgba(0,0,0,.35)'; c.lineWidth = 3; c.strokeRect(10, 10, w / 2 - 12, h - 44); c.strokeRect(w / 2 + 2, 10, w / 2 - 12, h - 44); c.fillStyle = '#c1121f'; for (let x = 0; x < w; x += 40) c.fillRect(x, h - 30, 20, 12); c.fillStyle = '#f4d35e'; for (let x = 20; x < w; x += 40) c.fillRect(x, h - 30, 20, 12); for (const x of [8, w - 40]) { c.fillStyle = '#ff2a2a'; c.fillRect(x, h - 16, 32, 12); } }),
  });
  const trailer = new THREE.Mesh(new THREE.BoxGeometry(2.5, 2.9, 10.2), [lambertMap(key + 's', tex.side), lambertMap(key + 's', tex.side), mat(0xb8bec6), mat(0x222428), lambertMap(key + 'r', tex.rear), wallMat(0x9aa0a6)]);
  trailer.position.set(0, 2.45, half - 5.1); g.add(trailer);
  g.add(box(2.3, 0.25, 9.6, 0x2a2d31, 0, 0.95, half - 5.1));                                   // рама прицепа
  g.add(box(2.4, 2.5, 2.2, cab, 0, 1.85, -half + 1.1), box(2.44, 0.9, 0.08, 0x1c2530, 0, 2.4, -half - 0.01)); // кабина и лобовое
  g.add(box(2.42, 0.5, 0.5, cab, 0, 3.3, -half + 0.6), box(2.3, 0.35, 1.2, 0x2a2d31, 0, 0.8, -half + 2.6));  // обтекатель, седло
  addBigWheels(g, 1.13, [-half + 1.0, -half + 3.2, half - 1.2, half - 2.4, half - 3.6]);
  g.userData = { type: 'vehicle', halfLen: half, height: 3.9, moving: true, roof: 0 };
  return g;
}
function makeVehicle(kind) {
  if (kind === 'bus') return makeBus();
  if (kind === 'semi') return makeSemi();
  if (kind === 'van' && Math.random() < 0.5) return makePhotoVehicle(Math.random() < 0.12 ? 'ambulance' : Math.random() < 0.6 ? 'minibus' : 'midibus'); // маршрутки и скорая
  if (kind === 'car' && sovietByName.Uaz469 && sovietByName.Vaz2101) { const r = Math.random(); if (r < 0.05) return makeService('police'); if (r < 0.13) return makeService('taxi'); }
  const g = new THREE.Group();
  if (kind !== 'bus' && carModels[kind].length) {
    const m = pick(carModels[kind]);
    const body = m.template.clone(); if (m.paint) paintCar(body, m.paint); if (m.uvPaint) paintUssr(body);
    g.add(body);
    g.userData = { type: 'vehicle', halfLen: m.len / 2, height: m.height, moving: true };
    return g;
  }
  let len, height;
  if (kind === 'bus') {
    len = 11; height = 3.1;
    const color = pick([0x2a9d8f, 0xf4f1de, 0x3a86ff]);
    g.add(box(2.5, 2.7, len, color, 0, 1.75, 0));
    g.add(box(2.54, 0.9, len - 0.8, 0x1b263b, 0, 2.2, 0));          // окна
    g.add(box(2.1, 0.9, 0.06, 0x1b263b, 0, 2.2, len / 2 + 0.01));   // заднее стекло
    addWheels(g, 1.2, [-3.6, 3.6]);
    g.add(box(2.3, 0.06, len - 0.4, 0x8d99ae, 0, 3.12, 0)); // крыша: по ней можно ехать
  } else if (kind === 'van') {
    len = 5.6; height = 2.3;
    g.add(box(2.1, 1.9, len, 0xf6bd60, 0, 1.3, 0));
    g.add(box(2.14, 0.6, len - 1.4, 0x1b263b, 0, 1.75, -0.2));
    g.add(box(1.7, 0.6, 0.06, 0x1b263b, 0, 1.75, len / 2 + 0.01));
    addWheels(g, 1.0, [-1.8, 1.8]);
  } else {
    len = 4.3; height = 1.5;
    const color = pick(CAR_COLORS);
    g.add(box(1.9, 0.7, len, color, 0, 0.7, 0));
    g.add(box(1.7, 0.55, 2.2, color, 0, 1.3, 0.15));
    g.add(box(1.5, 0.4, 0.06, 0x1b263b, 0, 1.3, 1.27));
    addWheels(g, 0.9, [-1.35, 1.35]);
  }
  for (const s of [-1, 1]) g.add(box(0.35, 0.16, 0.06, 0xff2222, s * 0.7, 0.85, len / 2 + 0.02)); // стоп-сигналы
  g.userData = { type: 'vehicle', halfLen: len / 2, height, moving: true, roof: kind === 'bus' ? height : 0 };
  return g;
}
const stripeTex = canvasTexture(128, 32, (c, w, h) => {
  for (let i = 0; i < 8; i++) { c.fillStyle = i % 2 ? '#ffffff' : '#e63946'; c.fillRect(i * 16, 0, 16, h); }
});
function makeBarrier() {
  const g = new THREE.Group();
  g.add(new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.35, 0.12), new THREE.MeshLambertMaterial({ map: stripeTex })));
  g.children[0].position.y = 0.75;
  g.add(box(0.1, 0.9, 0.3, 0x555555, -1.05, 0.45, 0), box(0.1, 0.9, 0.3, 0x555555, 1.05, 0.45, 0));
  g.userData = { type: 'barrier', moving: false };
  return g;
}
const coinGeo = new THREE.CylinderGeometry(0.36, 0.36, 0.08, 18);
const coinMat = new THREE.MeshLambertMaterial({ color: 0xffd23f, emissive: 0x8a6500 });
function makeCoin(moving) {
  const g = new THREE.Group();
  const m = new THREE.Mesh(coinGeo, coinMat); m.rotation.x = Math.PI / 2;
  g.add(m);
  g.userData = { type: 'coin', moving };
  return g;
}

// Шлагбаум: перекладина на уровне головы, под ней нужно пригнуться
function makeGate() {
  const g = new THREE.Group();
  const bar = new THREE.Mesh(new THREE.BoxGeometry(3.0, 0.22, 0.14), new THREE.MeshLambertMaterial({ map: stripeTex }));
  bar.position.y = 1.84; // ниже головы сидящего (1,9 м), но выше пригнувшегося (1,63 м)
  g.add(bar, box(0.16, 2.1, 0.16, 0x444a50, -1.5, 1.05, 0), box(0.16, 2.1, 0.16, 0x444a50, 1.5, 1.05, 0));
  g.add(box(0.34, 0.5, 0.34, 0xe9c46a, -1.5, 0.25, 0), box(0.34, 0.5, 0.34, 0xe9c46a, 1.5, 0.25, 0));
  g.userData = { type: 'gate', moving: false };
  return g;
}
// Эвакуатор с опущенной аппарелью: заезжаешь сзади — подбрасывает, как трамплин
const chevronTex = canvasTexture(64, 128, (c, w, h) => {
  c.fillStyle = '#2b2f36'; c.fillRect(0, 0, w, h);
  c.strokeStyle = '#ffd23f'; c.lineWidth = 7;
  for (let y = 14; y < h; y += 26) { c.beginPath(); c.moveTo(10, y + 12); c.lineTo(w / 2, y); c.lineTo(w - 10, y + 12); c.stroke(); }
});
function makeRampTruck() {
  const g = new THREE.Group();
  const len = 9, half = len / 2, color = pick([0xf4a261, 0x2a9d8f, 0xe9c46a, 0x4d7ea8]);
  g.add(box(2.3, 1.7, 2.0, color, 0, 1.45, -half + 1.0));                 // кабина
  g.add(box(2.0, 0.7, 0.06, 0x1b263b, 0, 1.75, -half + 2.02));            // заднее стекло кабины
  g.add(box(2.4, 0.22, 4.2, 0x3a3f47, 0, 1.0, -half + 4.1));              // платформа
  for (const sx of [-1, 1]) g.add(box(0.08, 0.3, 4.2, 0xffd23f, sx * 1.16, 1.2, -half + 4.1)); // борта
  const ramp = new THREE.Mesh(new THREE.BoxGeometry(2.3, 0.12, 3.2), new THREE.MeshLambertMaterial({ map: chevronTex }));
  ramp.position.set(0, 0.56, half - 1.45); ramp.rotation.x = Math.atan2(1.05, 3.0); // от земли к платформе
  g.add(ramp);
  addWheels(g, 1.05, [-half + 1.2, -half + 4.6, -half + 5.6]);
  g.add(box(0.5, 0.18, 0.3, 0xffa200, 0, 2.4, -half + 1.0));              // маячок
  g.userData = { type: 'vehicle', ramp: true, halfLen: half, height: 2.4, moving: true };
  return g;
}
// Бонусы
const BONUS_KINDS = ['magnet', 'bar', 'helmet', 'spring', 'spring'];
function makeBonus(kind, moving) {
  const g = new THREE.Group(), body = new THREE.Group();
  if (kind === 'magnet') {
    const arc = new THREE.Mesh(new THREE.TorusGeometry(0.28, 0.1, 8, 14, Math.PI), mat(0xd62828));
    body.add(arc, box(0.2, 0.2, 0.2, 0xdddddd, -0.28, -0.1, 0), box(0.2, 0.2, 0.2, 0xdddddd, 0.28, -0.1, 0));
  } else if (kind === 'bar') {
    body.add(box(0.75, 0.26, 0.14, 0xffb703), box(0.2, 0.27, 0.15, 0x7f4f24, 0.3, 0, 0), box(0.5, 0.08, 0.16, 0xd62828, -0.08, 0, 0));
    body.rotation.z = 0.5;
  } else if (kind === 'spring') {
    for (let i = 0; i < 5; i++) { // витки пружины
      const coil = new THREE.Mesh(new THREE.TorusGeometry(0.24, 0.045, 6, 14), mat(0x38b000));
      coil.rotation.x = Math.PI / 2 + 0.18; coil.position.y = -0.3 + i * 0.14;
      body.add(coil);
    }
    body.add(box(0.6, 0.06, 0.6, 0x555b61, 0, -0.38, 0), box(0.6, 0.06, 0.6, 0x555b61, 0, 0.36, 0));
  } else {
    const dome = new THREE.Mesh(new THREE.SphereGeometry(0.34, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), mat(0x3a86ff));
    body.add(dome, box(0.5, 0.06, 0.2, 0x1d3557, 0, 0.02, 0.3));
    body.position.y = -0.12;
  }
  const halo = new THREE.Mesh(new THREE.TorusGeometry(0.6, 0.035, 6, 24), new THREE.MeshBasicMaterial({ color: { magnet: 0xff6b6b, bar: 0xffd23f, helmet: 0x7cc4ff, spring: 0x70e000 }[kind] }));
  g.add(body, halo);
  g.userData = { type: 'bonus', kind, moving };
  return g;
}

let things = []; // всё, что едет навстречу: машины, ограждения, монетки, бонусы
const CAR_GAP = 6; // минимальный просвет между бамперами машин в одной полосе
function laneClear(x, z, halfLen, gap = CAR_GAP) { // свободно ли место в полосе для машины такой длины
  return !things.some((o) => o.userData.type === 'vehicle' && !o.userData.flung && Math.abs(o.position.x - x) < 1.6 && Math.abs(o.position.z - z) < o.userData.halfLen + halfLen + gap);
}
const onLane = (o, l) => o.userData.lane === l || o.userData.change?.to === l || o.userData.turn?.lane === l; // едет по полосе или перестраивается в неё
function carWillHit(lane, z) { // доедет ли попутная машина до неподвижного предмета раньше, чем игрок проедет мимо неё
  return things.some((o) => {
    const d = o.userData;
    if (d.type !== 'vehicle' || d.flung || !onLane(o, lane)) return false;
    if (d.oncoming) return o.position.z < z + 4;
    if (!d.moving && !d.waiting) return Math.abs(o.position.z - z) < d.halfLen + 3;
    const gap = o.position.z - z;
    return gap > -d.halfLen - 4 && gap / TRAFFIC_SPEED < -o.position.z / Math.max(1, game.speed - TRAFFIC_SPEED) + 2;
  });
}
function place(obj, lane, z, y = 0) {
  if (obj.userData.type !== 'vehicle' && !obj.userData.moving && y < 2.6 && carWillHit(lane, z)) return false;
  if (obj.userData.type === 'vehicle' && !laneClear(LANES[lane], z, obj.userData.halfLen)) return false; // место занято — машину не ставим
  if (obj.userData.type === 'vehicle') { // и не ставим, если вместе с соседями она перекроет все попутные полосы
    const busy = (l) => l === lane || things.some((o) => o.userData.type === 'vehicle' && !o.userData.flung && onLane(o, l) && Math.abs(o.position.z - z) < o.userData.halfLen + obj.userData.halfLen + 10);
    const minLane = modeAt(z) !== 'oneway' || modeAt(z - 90) !== 'oneway' ? 1 : 0; // впереди встречка — левая полоса не в счёт: машины успеют до неё доехать
    if (![0, 1, 2].some((f) => f >= minLane && !busy(f))) return false;
  }
  obj.position.set(LANES[lane], y, z);
  obj.userData.lane = lane;
  if (obj.userData.type !== 'coin' && obj.userData.type !== 'bonus') castShadows(obj);
  if (obj.userData.type === 'vehicle') {
    obj.add(blob(3.4, obj.userData.halfLen * 2 + 1.6, 0.55)); // тень-пятно под машиной
    mergeStatic(obj);
    // на сложности часть машин перестраивается (с поворотником)
    if (!obj.userData.ramp && obj.userData.halfLen < 4 && game.distance > 300 && Math.random() < 0.1 + 0.2 * difficulty()) obj.userData.changer = true;
  }
  scene.add(obj);
  things.push(obj);
  return true;
}
function addThing(obj, x, y, z) { // поставить предмет в произвольную точку дороги
  obj.position.set(x, y, z);
  if (obj.userData.type === 'vehicle') { castShadows(obj); obj.add(blob(3.4, obj.userData.halfLen * 2 + 1.6, 0.55)); mergeStatic(obj); }
  else if (obj.userData.type === 'ped') castShadows(obj);
  scene.add(obj); things.push(obj);
}
// пешеход на переходе: идёт поперёк дороги, задеть его — ошибка
function makePed(dir) {
  const g = person();
  g.rotation.y = dir * Math.PI / 2; // лицом по ходу
  g.userData = { type: 'ped', moving: false, dir, wait: rand(0, 7), walking: true, lane: -1 };
  return g;
}
function walkPed(t, dt) {
  const d = t.userData;
  if (d.wait > 0) { d.wait -= dt; return; }
  if (!d.walking) return;
  t.position.x += d.dir * 1.5 * (t.userData.pace ?? 1) * dt;
  t.position.y = 0.02 + Math.abs(Math.sin(game.time * 8 + t.id)) * 0.03;
  stepPerson(t, game.time * 8 + t.id);
  if (t.position.x * d.dir > 6.6) { d.walking = false; d.type = 'none'; t.position.y = 0.07; stepPerson(t, 0, 0); }
}
// машина перестраивается: сначала мигает поворотником, потом смещается
const blinkMat = new THREE.MeshBasicMaterial({ color: 0xffa200 });
function canMerge(t) { // выезд с боковой улицы в правую полосу: она свободна, и после манёвра остаётся ещё одна свободная полоса
  const near = things.filter((o) => o !== t && o.userData.type === 'vehicle' && !o.userData.flung && Math.abs(o.position.z - t.position.z) < o.userData.halfLen + 24);
  const busy = (l) => near.some((o) => onLane(o, l));
  const minLane = modeAt(t.position.z) === 'oneway' ? 0 : 1;
  return !busy(2) && [0, 1].some((f) => f >= minLane && !busy(f));
}
function laneChange(t, dt) {
  const d = t.userData;
  if (!d.change) {
    if (t.position.z > -40) { d.changer = false; return; }
    if (t.position.z < -85) return;
    const minLane = modeAt(t.position.z) === 'oneway' ? 0 : 1;
    if (minLane === 1) { d.changer = false; return; } // на участке со встречкой попутных полос всего две — перестраиваться нельзя, иначе перекроет обе
    const near = things.filter((o) => o !== t && o.userData.type === 'vehicle' && !o.userData.flung && Math.abs(o.position.z - t.position.z) < o.userData.halfLen + d.halfLen + 14);
    const busy = (l) => near.some((o) => onLane(o, l));
    // после манёвра рядом должна остаться свободная попутная полоса
    const ok = [d.lane - 1, d.lane + 1].filter((l) => l >= minLane && l <= 2 && !busy(l) && [0, 1, 2].some((f) => f >= minLane && f !== l && f !== d.lane && !busy(f))); // пока машина между полосами, она занимает обе
    if (!ok.length) { d.changer = false; return; }
    const to = pick(ok), dir = Math.sign(to - d.lane);
    d.change = { t: 0, to, x0: t.position.x, dir, lamp: new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.22, 0.14), blinkMat) };
    d.change.lamp.position.set(dir * 0.72, 0.95, d.halfLen + 0.06); t.add(d.change.lamp);
  }
  const c = d.change; c.t += dt;
  c.lamp.visible = Math.floor(c.t * 5) % 2 === 0;
  if (c.t <= 1.0 && things.some((o) => o !== t && o.userData.type === 'vehicle' && !o.userData.flung && onLane(o, c.to) && Math.abs(o.position.z - t.position.z) < o.userData.halfLen + d.halfLen + 4)) {
    t.remove(c.lamp); d.change = null; d.changer = false; return; // место заняли — передумал
  }
  if (c.t > 1.0) {
    d.lane = c.to;
    const k = Math.min(1, (c.t - 1.0) / 0.9), e = k * k * (3 - 2 * k);
    t.position.x = THREE.MathUtils.lerp(c.x0, LANES[c.to], e);
    t.rotation.y = -c.dir * 0.14 * Math.sin(k * Math.PI);
    if (k >= 1) { t.remove(c.lamp); t.rotation.y = 0; d.change = null; d.changer = false; }
  }
}
// движение одного предмета за кадр: своё движение машин, съезды на перекрёстках, перестроения, пешеходы
function moveThing(t, step, dt) {
  const d = t.userData;
  let own = d.moving ? -TRAFFIC_SPEED : 0;
  if (d.type === 'vehicle' && !d.flung) {
    if (d.oncoming) {
      if (!d.halted && !d.turn) for (const o of things) { // в полосе кто-то едет в лоб — оба тормозят, а не проезжают насквозь
        const od = o.userData;
        if (o !== t && od.type === 'vehicle' && !od.oncoming && !od.flung && Math.abs(o.position.x - t.position.x) < 1.6 && o.position.z > t.position.z && o.position.z - t.position.z < od.halfLen + d.halfLen + 4) { d.halted = true; od.moving = false; od.changer = false; break; }
      }
      own = d.halted ? 0 : ONCOMING_SPEED;
    }
    if (d.waiting && t.position.z > -85 && t.position.z < -55 // ждёт на боковой улице и выезжает в правую полосу, если она свободна
      && canMerge(t)) {
      d.waiting = false;
      d.turn = { out: false, merge: true, lane: 2, t: 0, time: 2.4, x0: t.position.x, x1: LANES[2], a0: Math.PI / 2, a1: 0 };
    }
    if (d.turn) { // сворачивает на боковую улицу или выезжает с неё
      own = 0; d.turn.t += dt;
      const k = Math.min(1, d.turn.t / d.turn.time), e = k * k * (3 - 2 * k);
      t.position.x = THREE.MathUtils.lerp(d.turn.x0, d.turn.x1, d.turn.out ? k * k : 1 - (1 - k) * (1 - k));
      t.rotation.y = THREE.MathUtils.lerp(d.turn.a0, d.turn.a1, e);
      if (k >= 1) { if (d.turn.out) { d.gone = true; t.visible = false; } else { const tn = d.turn; d.turn = null; t.position.x = tn.x1; t.rotation.y = tn.merge ? 0 : Math.PI; d.lane = tn.lane ?? 0; if (tn.merge) d.moving = true; } }
    } else if (d.lane === 0) { // левая полоса на перекрёстке уходит налево — и попутные, и встречные
      const c = chunkAt(t.position.z);
      if (c && c.userData.mode === 'jIn' && Math.abs(t.position.z - c.position.z) < 4) { d.turn = { out: true, t: 0, time: 1.7, x0: t.position.x, x1: -24, a0: t.rotation.y, a1: Math.PI / 2 }; d.lane = -1; }
    }
    if (d.changer && !d.turn && !d.oncoming) laneChange(t, dt);
  } else if (d.type === 'ped') walkPed(t, dt);
  t.position.z += step + own * dt;
}
function spawnOncoming() { // встречная машина: выезжает с боковой улицы в конце участка или появляется вдали
  const far = chunks.find((c) => c.userData.mode === 'jOut' && c.position.z < -70 && c.position.z > -236);
  if (!far && modeAt(-232) !== 'twoway') return;
  const k = Math.random(), v = makeVehicle(k < 0.1 ? 'bus' : k < 0.17 ? 'semi' : k < 0.36 ? 'van' : 'car');
  Object.assign(v.userData, { oncoming: true, moving: false, roof: 0 });
  for (const sx of [-0.6, 0.6]) v.add(new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.2, 0.08), new THREE.MeshBasicMaterial({ color: 0xfff6c8 })).translateX(sx).translateY(0.78).translateZ(-v.userData.halfLen - 0.03)); // фары
  if (far) {
    const fz = far.position.z; // выезжает с боковой улицы, только если на встречной полосе рядом никого
    if (things.some((o) => o.userData.type === 'vehicle' && (Math.abs(o.position.x - LANES[0]) < 2.5 || (o.userData.turn && o.userData.oncoming)) && o.position.z > fz - 34 - o.userData.halfLen && o.position.z < fz + 14 + o.userData.halfLen)) return;
    addThing(v, -24, 0, far.position.z); v.rotation.y = -Math.PI / 2; v.userData.lane = -1;
    v.userData.turn = { out: false, t: 0, time: 1.9, x0: -24, x1: LANES[0], a0: -Math.PI / 2, a1: -Math.PI };
  } else { if (!laneClear(LANES[0], -232, v.userData.halfLen, 10)) return; addThing(v, LANES[0], 0, -232); v.rotation.y = Math.PI; v.userData.lane = 0; }
}
function spawnRowTwoWay(z) { // ряд на участке со встречной полосой: попутные только в двух правых полосах
  const hard = difficulty(), r = Math.random(), [a, b] = Math.random() < 0.5 ? [1, 2] : [2, 1];
  if (r < 0.5) {
    const k = Math.random();
    if (k < 0.12) place(makeRampTruck(), a, z); else place(makeVehicle(k < 0.25 ? 'bus' : k < 0.45 ? 'van' : 'car'), a, z);
    lastFree = b;
    if (Math.random() < BONUS_CHANCE) place(makeBonus(pick(BONUS_KINDS), false), b, z, 1.1);
    else if (Math.random() < 0.3 + hard * 0.4) place(Math.random() < 0.5 ? makeBarrier() : makeGate(), b, z + 9);
    else for (let i = 0; i < 6; i++) place(makeCoin(false), b, z + 7 - i * 2.6, 1);
  } else if (r < 0.7) {
    place(makeBarrier(), a, z); if (Math.random() < 0.4 + hard * 0.4) place(Math.random() < 0.5 ? makeBarrier() : makeGate(), b, z);
  } else if (r < 0.84) {
    place(makeGate(), a, z); if (Math.random() < 0.4 + hard * 0.4) place(makeBarrier(), b, z);
  } else if (Math.random() < 0.55) {
    for (let i = 0; i < 10; i++) place(makeCoin(false), 0, z - i * 2.6, 1); // монеты на встречной — награда за риск
  } else for (let i = 0; i < 8; i++) place(makeCoin(false), a, z - i * 2.6, 1);
}
let lastFree = 1; // свободная полоса в прошлом ряду машин
function spawnRow(z) {
  const mode = modeAt(z);
  if (mode === 'jIn' || mode === 'jOut') { const l = pick([1, 2]); for (let i = 0; i < 6; i++) place(makeCoin(false), l, z - i * 2.6, 1); return; } // перекрёсток свободен
  if (mode === 'twoway') { spawnRowTwoWay(z); return; }
  let lanes = [0, 1, 2].sort(() => Math.random() - 0.5);
  const hard = difficulty(); // 0 на старте, 1 после FULL_DIFFICULTY_AT метров
  const r = Math.random();
  if (r < 0.55) {
    // ряд машин: одна полоса всегда свободна
    const blocked = Math.random() < 0.35 + hard * 0.5 ? 2 : 1;
    if (blocked === 2) {
      // свободная полоса — не дальше соседней от прошлой свободной, чтобы всегда можно было успеть
      const free = pick([0, 1, 2].filter((l) => Math.abs(l - lastFree) <= 1));
      lanes = [...[0, 1, 2].filter((l) => l !== free).sort(() => Math.random() - 0.5), free];
      lastFree = free;
    } else {
      lastFree = lanes[2];
    }
    const bonus = game.distance > 150 && Math.random() < BONUS_CHANCE;
    let rampLane = -1;
    for (let i = 0; i < blocked; i++) {
      const k = Math.random();
      const busChance = 0.1 + hard * 0.2;
      if (rampLane < 0 && game.distance > 120 && Math.random() < 0.16) { if (place(makeRampTruck(), lanes[i], z)) rampLane = lanes[i]; }
      else if (hard > 0.2 && Math.random() < 0.1) place(makeSemi(), lanes[i], z); // фура
      else if (k < busChance) {
        // автобус, иногда два подряд: по крышам можно проехать, там монеты
        const count = Math.random() < 0.4 ? 2 : 1;
        for (let b = 0, bz = z; b < count; b++) {
          const bus = makeVehicle('bus');
          if (b) bz -= bus.userData.halfLen; // второй автобус держит дистанцию
          if (place(bus, lanes[i], bz)) for (let c = 0; c < 4; c++) place(makeCoin(true), lanes[i], bz + 4 - c * 2.6, 4.1);
          bz -= bus.userData.halfLen + CAR_GAP + 1;
        }
      } else place(makeVehicle(k < busChance + 0.2 ? 'van' : 'car'), lanes[i], z);
    }
    if (rampLane >= 0) for (let i = 0; i < 6; i++) place(makeCoin(true), rampLane, z + 1 - i * 2.4, 3.6 - Math.abs(i - 2.5) * 0.35); // награда за прыжок с трамплина
    if (bonus) place(makeBonus(pick(BONUS_KINDS), false), lanes[2], z, 1.1);
    else if (game.distance > 150 && Math.random() < 0.3 + hard * 0.45) {
      // на сложности и свободная полоса не даётся даром: в ней ограждение или шлагбаум
      place(Math.random() < 0.5 ? makeBarrier() : makeGate(), lanes[2], z + 9);
    } else if (Math.random() < 0.6) for (let i = 0; i < 6; i++) place(makeCoin(false), lanes[2], z + 7 - i * 2.6, 1);
  } else if (r < 0.72) {
    // ограждения, их нужно перепрыгивать
    const n = 1 + Math.floor(Math.random() * (hard < 0.15 ? 2 : 3));
    for (let i = 0; i < n; i++) place(makeBarrier(), lanes[i], z);
    if (Math.random() < 0.7) for (let i = -2; i <= 2; i++) place(makeCoin(false), lanes[0], z - i * 2.4, 2.3 - Math.abs(i) * 0.55);
  } else if (r < 0.85 && game.distance > 100) {
    // шлагбаумы, под ними нужно пригнуться
    const n = 1 + Math.floor(Math.random() * (hard < 0.15 ? 2 : 3));
    for (let i = 0; i < n; i++) place(makeGate(), lanes[i], z);
    for (let i = n; i < 3; i++) if (Math.random() < 0.3 + hard * 0.6) place(makeBarrier(), lanes[i], z); // остальные полосы — прыгать
    if (Math.random() < 0.7) for (let i = -2; i <= 2; i++) place(makeCoin(false), lanes[0], z - i * 2.4, 0.8);
  } else {
    for (let i = 0; i < 8; i++) place(makeCoin(false), lanes[0], z - i * 2.6, 1);
    if (game.distance > 150 && Math.random() < BONUS_CHANCE * 1.5) place(makeBonus(pick(BONUS_KINDS), false), lanes[0], z - 8 * 2.6, 1.1);
  }
}

// ---------- Обочины: «биомы» ----------
const facadeCache = {};
function facadeTex(floors, cols, wall) {
  const key = floors + '_' + cols + '_' + wall;
  if (!facadeCache[key]) facadeCache[key] = canvasTexture(cols * 32, floors * 32, (c, w, h) => {
    c.fillStyle = wall; c.fillRect(0, 0, w, h);
    for (let f = 0; f < floors; f++) for (let i = 0; i < cols; i++) {
      c.strokeStyle = 'rgba(0,0,0,.18)'; c.strokeRect(i * 32 + 0.5, f * 32 + 0.5, 32, 32); // швы панелей
      c.fillStyle = Math.random() < 0.2 ? '#f2d16b' : pick(['#3b4a5a', '#4a5a6a', '#2f3b47']);
      c.fillRect(i * 32 + 8, f * 32 + 7, 16, 17);
      if (i % 4 === 1) { c.fillStyle = 'rgba(255,255,255,.35)'; c.fillRect(i * 32 + 4, f * 32 + 20, 24, 8); } // балкон
    }
  });
  return facadeCache[key];
}
function panelHouse(floors, len) {
  const h = floors * 3, depth = 12;
  const wall = pick(['#b8b2a7', '#a9b4bd', '#c9bfa5', '#9fa8a3']);
  const front = new THREE.MeshLambertMaterial({ map: facadeTex(floors, Math.round(len / 3), wall) });
  const side = mat(new THREE.Color(wall).getHex());
  const roof = mat(0x4a4a4a);
  const m = new THREE.Mesh(new THREE.BoxGeometry(depth, h, len), [front, front, roof, roof, side, side]);
  m.position.y = h / 2;
  return m;
}
function signTex(text, bg, fg) {
  return canvasTexture(256, 64, (c, w, h) => {
    c.fillStyle = bg; c.fillRect(0, 0, w, h);
    c.fillStyle = fg; c.font = 'bold 34px sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText(text, w / 2, h / 2 + 2, w - 12);
  });
}
const SIGNS = [
  ['ШАУРМА', '#e76f51', '#fff'], ['ЦВЕТЫ', '#d63384', '#fff'], ['ТАБАК', '#264653', '#fff'], ['ПРОДУКТЫ 24', '#2a9d8f', '#fff'],
  ['ХЛЕБ', '#e9c46a', '#3a2a00'], ['РЕМОНТ ОБУВИ', '#6c757d', '#fff'], ['ПИВО · РЫБА', '#1d3557', '#ffd23f'], ['АПТЕКА', '#2b9348', '#fff'],
  ['ОВОЩИ ФРУКТЫ', '#588157', '#fff'], ['РЕМОНТ ТЕЛЕФОНОВ', '#3a0ca3', '#fff'], ['КУРЫ ГРИЛЬ', '#bb3e03', '#fff'],
];
function sign(w, h, side) {
  const [text, bg, fg] = pick(SIGNS);
  const s = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: signTex(text, bg, fg) }));
  s.rotation.y = -side * Math.PI / 2; // лицом к дороге
  return s;
}
function kiosk(side) {
  const g = new THREE.Group();
  g.add(box(3, 2.6, 4, pick([0xdfe7ea, 0xcad2c5, 0xf1e3c8, 0xb5c9d6]), 0, 1.3, 0));
  g.add(box(3.3, 0.15, 4.4, 0x555b61, 0, 2.7, 0));
  g.add(box(0.06, 1.0, 2.6, 0x26323d, -side * 1.51, 1.5, 0)); // витрина
  const s = sign(3.8, 0.8, side); s.position.set(-side * 1.56, 2.45, 0);
  g.add(s);
  return g;
}
function shop(side) {
  const g = new THREE.Group();
  g.add(box(12, 4.5, 26, 0xd8d3c8, 0, 2.25, 0));
  g.add(box(0.1, 2.2, 22, 0x26323d, -side * 6.02, 1.6, 0));
  g.add(box(0.2, 1.3, 26, 0xc1121f, -side * 6.05, 3.7, 0));
  const s = sign(9, 1.2, side); s.position.set(-side * 6.2, 3.7, 0);
  g.add(s);
  return g;
}
function garage() {
  const g = new THREE.Group();
  g.add(box(6, 2.6, 3.6, pick([0x8d8d86, 0x9a8c7a, 0x7d8a8c]), 0, 1.3, 0));
  return g;
}
// Готовые модели деревьев (Kenney Nature Kit, CC0). Пока не загрузились — рисуются шары и конусы.
const TREE_FILES = { leaf: ['tree_detailed', 'tree_detailed_dark', 'tree_oak', 'tree_oak_dark', 'tree_default', 'tree_default_dark', 'tree_tall', 'tree_fat'], pine: ['tree_pineRoundA', 'tree_pineRoundC', 'tree_pineRoundE', 'tree_pineTallA_detailed', 'tree_pineDefaultA'] };
const treeModels = { leaf: [], pine: [] };
for (const kind of Object.keys(TREE_FILES)) for (const name of TREE_FILES[kind]) new GLTFLoader().load(`models/trees/${name}.glb`, (gltf) => {
  const m = gltf.scene, b = new THREE.Box3().setFromObject(m), size = b.getSize(new THREE.Vector3()), c = b.getCenter(new THREE.Vector3());
  m.position.set(-c.x, -b.min.y, -c.z);
  const leaf = kind === 'leaf' ? pick([0x6a994e, 0x7fb069, 0x8ab661, 0x5f8f4a, 0x79a352]) : pick([0x2d6a4f, 0x35755a, 0x2a5f47]);
  m.traverse((o) => { // листву перекрашиваем в зелень нашего города, стволы оставляем
    if (!o.isMesh) return;
    const recolor = (mm) => { const c = mm.color; return mat(c.g > c.r * 1.05 ? new THREE.Color(leaf).offsetHSL(0, 0, (c.g - 0.5) * 0.12).getHex() : kind === 'leaf' ? 0x7a6451 : 0x5c4033); };
    o.material = Array.isArray(o.material) ? o.material.map(recolor) : recolor(o.material);
  });
  const t = new THREE.Group(); t.add(m);
  treeModels[kind].push({ t, h: size.y });
});
function modelTree(kind, height) { // дерево из набора нужной высоты, со случайным поворотом
  const list = treeModels[kind]; if (!list.length) return null;
  const src = pick(list), g = src.t.clone(), k = height / src.h;
  g.scale.set(k * rand(0.85, 1.15), k, k * rand(0.85, 1.15)); g.rotation.y = rand(0, Math.PI * 2);
  return g;
}
function tree(kind) {
  const g = new THREE.Group();
  const model = modelTree(kind === 'birch' ? 'leaf' : 'pine', kind === 'birch' ? rand(6.5, 9.5) : rand(7, 10));
  if (model) { g.add(model, blob(4.6, 4.6, 0.5, true)); return g; }
  if (kind === 'birch') {
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.2, 4.5, 6), mat(0xeeeeea)); trunk.position.y = 2.25;
    const crown = new THREE.Mesh(new THREE.SphereGeometry(1.9, 8, 6), mat(pick([0x6a994e, 0x7fb069, 0xa7c957]))); crown.position.y = 5.2; crown.scale.y = 1.25;
    g.add(trunk, crown);
  } else {
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.24, 1.6, 6), mat(0x5c4033)); trunk.position.y = 0.8;
    const crown = new THREE.Mesh(new THREE.ConeGeometry(1.8, 6.5, 8), mat(0x2d6a4f)); crown.position.y = 4.6;
    g.add(trunk, crown);
  }
  g.add(blob(4.6, 4.6, 0.5, true));
  const s = rand(0.8, 1.3); g.scale.set(s, s, s);
  return g;
}
function lamp() { // двурогий фонарь, как на одинцовских улицах
  const g = new THREE.Group();
  g.add(box(0.16, 9, 0.16, 0x6c757d, 0, 4.5, 0));
  for (const s of [-1, 1]) g.add(box(1.5, 0.1, 0.12, 0x6c757d, s * 0.75, 8.9, 0), box(0.55, 0.14, 0.28, 0xfff3b0, s * 1.5, 8.82, 0));
  return g;
}
function busStop(side) {
  const g = new THREE.Group();
  g.add(box(0.1, 2.3, 4.5, 0x8ecae6, side * 0.6, 1.25, 0), box(1.6, 0.12, 4.9, 0x495057, 0, 2.5, 0), box(0.4, 0.1, 3.4, 0x7f5539, side * 0.3, 0.55, 0));
  return g;
}

// --- мелочи, из которых складывается узнаваемая улица ---
const SKIN = [0xf1c8a4, 0xe0b08a, 0xc99a74];
// Прохожий: низкополигональная фигура с руками и ногами. Пять типажей; ноги и руки качаются при ходьбе (stepPerson).
const PEOPLE = [
  { name: 'man', coat: [0x3d4a5c, 0x4a4f57, 0x2f4f6b, 0x5a4636], legs: [0x2b3340, 0x3a3f4a], hair: 0x3a2a20 },
  { name: 'woman', coat: [0xb56576, 0x6d597a, 0xc9a66b, 0x2a6f4f, 0xa23b4a], legs: [0x2b2d33, 0x54433a], hair: 0x6b3a1e, long: true },
  { name: 'granny', coat: [0x7a6a8a, 0x5b6b5a, 0x8a6f5a], legs: [0x4a4038], scarf: [0xc8402f, 0x2f6fa8, 0xe6dcc0, 0x8a2d5a], long: true, bag: true, slow: true },
  { name: 'teen', coat: [0xe07a3f, 0x3fa7d6, 0x8bc34a, 0x222831, 0xd94f70], legs: [0x2f3a55, 0x1f2329], hair: 0x2a2018, pack: true },
  { name: 'worker', coat: [0xf28c28], legs: [0x2f3a55], helmet: 0xf2c230, stripe: true },
];
function person() {
  const g = new THREE.Group(), P = Math.random() < 0.08 ? PEOPLE[4] : pick(PEOPLE.slice(0, 4)), coat = pick(P.coat), legC = pick(P.legs), skin = pick(SKIN);
  const limb = (w, len, d, color, x, y) => { const pv = new THREE.Group(); pv.position.set(x, y, 0); pv.add(box(w, len, d, color, 0, -len / 2, 0)); g.add(pv); return pv; };
  const legL = limb(0.15, 0.82, 0.17, legC, -0.1, 0.84), legR = limb(0.15, 0.82, 0.17, legC, 0.1, 0.84);
  legL.add(box(0.16, 0.09, 0.26, 0x24262b, 0, -0.8, 0.04)); legR.add(box(0.16, 0.09, 0.26, 0x24262b, 0, -0.8, 0.04)); // ботинки
  g.add(box(0.44, P.long ? 0.86 : 0.62, 0.26, coat, 0, P.long ? 1.05 : 1.16, 0));                                   // корпус: куртка или длинное пальто
  if (P.stripe) g.add(box(0.46, 0.07, 0.28, 0xe9eef2, 0, 1.12, 0), box(0.46, 0.07, 0.28, 0xe9eef2, 0, 1.28, 0)); // светоотражающие полосы
  const armL = limb(0.12, 0.6, 0.14, coat, -0.29, 1.44), armR = limb(0.12, 0.6, 0.14, coat, 0.29, 1.44);
  armL.add(box(0.1, 0.1, 0.11, skin, 0, -0.64, 0)); armR.add(box(0.1, 0.1, 0.11, skin, 0, -0.64, 0));             // кисти
  const head = new THREE.Mesh(new THREE.IcosahedronGeometry(0.17, 1), mat(skin)); head.position.y = 1.66; g.add(head);
  g.add(box(0.12, 0.1, 0.12, skin, 0, 1.5, 0));                                                                   // шея
  if (P.scarf) { const sc = new THREE.Mesh(new THREE.IcosahedronGeometry(0.19, 1), mat(pick(P.scarf))); sc.position.set(0, 1.69, -0.03); g.add(sc); } // платок
  else if (P.helmet) g.add(box(0.36, 0.13, 0.4, P.helmet, 0, 1.8, 0.02));
  else { g.add(box(0.33, 0.14, 0.34, P.hair, 0, 1.79, -0.02)); if (P.long) g.add(box(0.3, 0.3, 0.12, P.hair, 0, 1.62, -0.15)); else if (Math.random() < 0.35) g.add(box(0.36, 0.11, 0.38, pick([0x222222, 0xb23a48, 0x1d3557]), 0, 1.84, 0)); }
  if (P.pack) g.add(box(0.34, 0.42, 0.16, pick([0x2b2d33, 0xc8402f, 0x2f6fa8]), 0, 1.2, -0.2));
  if (P.bag) armR.add(box(0.08, 0.3, 0.3, pick([0x5a3a2a, 0x2a3a5a, 0x6a6a3a]), 0.02, -0.82, 0.02));
  g.add(blob(1.3, 1.3, 0.55, true));
  g.rotation.y = rand(0, Math.PI * 2);
  g.userData.limbs = { legL, legR, armL, armR }; g.userData.pace = P.slow ? 0.65 : 1;
  return g;
}
function stepPerson(p, phase, amount = 1) { // шаг: ноги и руки в противофазе
  const L = p.userData.limbs; if (!L) return;
  const sw = Math.sin(phase) * 0.55 * amount;
  L.legL.rotation.x = sw; L.legR.rotation.x = -sw; L.armL.rotation.x = -sw * 0.8; L.armR.rotation.x = sw * 0.8;
}
const plateCache = {};
function plateTex(kind) {
  if (!plateCache[kind]) plateCache[kind] = canvasTexture(128, 128, (c, w, h) => {
    c.textAlign = 'center'; c.textBaseline = 'middle';
    if (kind === 'limit') {
      c.fillStyle = '#fff'; c.beginPath(); c.arc(64, 64, 60, 0, 7); c.fill();
      c.strokeStyle = '#d62828'; c.lineWidth = 14; c.beginPath(); c.arc(64, 64, 52, 0, 7); c.stroke();
      c.fillStyle = '#111'; c.font = 'bold 54px sans-serif'; c.fillText('60', 64, 68);
    } else if (kind === 'twoway') { // предупреждение: двустороннее движение
      c.fillStyle = '#d62828'; c.beginPath(); c.moveTo(64, 6); c.lineTo(124, 118); c.lineTo(4, 118); c.closePath(); c.fill();
      c.fillStyle = '#fff'; c.beginPath(); c.moveTo(64, 28); c.lineTo(104, 106); c.lineTo(24, 106); c.closePath(); c.fill();
      c.fillStyle = '#111';
      c.fillRect(48, 62, 8, 38); c.beginPath(); c.moveTo(52, 46); c.lineTo(64, 66); c.lineTo(40, 66); c.fill();   // стрелка вверх
      c.fillRect(72, 52, 8, 38); c.beginPath(); c.moveTo(76, 104); c.lineTo(88, 86); c.lineTo(64, 86); c.fill();  // стрелка вниз
    } else if (kind === 'oneway') { // дальше снова одностороннее
      c.fillStyle = '#1d5fbf'; c.fillRect(0, 0, w, h);
      c.fillStyle = '#fff'; c.fillRect(54, 46, 20, 66); c.beginPath(); c.moveTo(64, 12); c.lineTo(100, 54); c.lineTo(28, 54); c.fill();
    } else if (kind === 'lanes') { // направления по полосам: левая — только налево
      c.fillStyle = '#1d5fbf'; c.fillRect(0, 0, w, h);
      c.strokeStyle = '#fff'; c.lineWidth = 3; c.strokeRect(3, 3, w - 6, h - 6);
      c.fillStyle = '#fff'; c.fillRect(42, 20, 2, 88); c.fillRect(84, 20, 2, 88);
      for (const x of [64, 106]) { c.fillRect(x - 5, 44, 10, 62); c.beginPath(); c.moveTo(x, 18); c.lineTo(x + 16, 48); c.lineTo(x - 16, 48); c.fill(); }
      c.fillRect(22, 50, 10, 56); c.fillRect(12, 50, 20, 10); c.beginPath(); c.moveTo(4, 55); c.lineTo(20, 38); c.lineTo(20, 72); c.fill();
    } else if (kind === 'tow') { // остановка запрещена, работает эвакуатор
      c.fillStyle = '#1d5fbf'; c.beginPath(); c.arc(64, 44, 40, 0, 7); c.fill();
      c.strokeStyle = '#d62828'; c.lineWidth = 9; c.beginPath(); c.arc(64, 44, 36, 0, 7); c.stroke();
      c.beginPath(); c.moveTo(38, 18); c.lineTo(90, 70); c.moveTo(90, 18); c.lineTo(38, 70); c.stroke();
      c.fillStyle = '#fff'; c.fillRect(20, 90, 88, 34); c.strokeStyle = '#111'; c.lineWidth = 3; c.strokeRect(20, 90, 88, 34);
      c.fillStyle = '#111'; c.fillRect(34, 104, 44, 8); c.fillRect(62, 96, 16, 10); c.beginPath(); c.arc(44, 116, 5, 0, 7); c.arc(72, 116, 5, 0, 7); c.fill();
      c.beginPath(); c.moveTo(78, 100); c.lineTo(98, 112); c.lineTo(78, 112); c.fill();
    } else if (kind === 'cross') {
      c.fillStyle = '#d8ef2f'; c.fillRect(0, 0, w, h); // жёлто-зелёная рамка
      c.fillStyle = '#1d5fbf'; c.fillRect(10, 10, w - 20, h - 20);
      c.fillStyle = '#fff'; c.beginPath(); c.moveTo(64, 20); c.lineTo(108, 108); c.lineTo(20, 108); c.closePath(); c.fill();
      c.fillStyle = '#111'; c.beginPath(); c.arc(64, 52, 9, 0, 7); c.fill(); c.fillRect(58, 62, 12, 26);
      c.fillRect(48, 86, 10, 20); c.fillRect(70, 86, 10, 20);
    } else if (kind === 'bus') {
      c.fillStyle = '#1d5fbf'; c.fillRect(0, 0, w, h);
      c.fillStyle = '#fff'; c.fillRect(16, 16, 96, 96);
      c.fillStyle = '#111'; c.font = 'bold 84px sans-serif'; c.fillText('А', 64, 70);
    } else {
      c.fillStyle = '#fff'; c.fillRect(0, 0, w, h); c.strokeStyle = '#111'; c.lineWidth = 6; c.strokeRect(5, 30, 118, 68);
      c.fillStyle = '#111'; c.font = 'bold 22px sans-serif'; c.fillText('ОДИНЦОВО', 64, 66, 108);
    }
  });
  return plateCache[kind];
}
function roadSign(kind) { // знак на столбике, лицом к едущему
  const g = new THREE.Group();
  const [pw, ph] = { city: [1.9, 1.9], lanes: [2.4, 1.3], twoway: [1.0, 1.0] }[kind] ?? [0.8, 0.8];
  const cut = kind === 'city' || kind === 'twoway';
  const plate = new THREE.Mesh(new THREE.PlaneGeometry(pw, ph), new THREE.MeshBasicMaterial({ map: plateTex(kind), transparent: cut, alphaTest: cut ? 0.5 : 0 }));
  plate.position.y = 2.7;
  g.add(box(0.08, 3.0, 0.08, 0x8a9199, 0, 1.5, -0.05), plate);
  return g;
}
const ADS = [
  ['КВАРТИРЫ', 'в ипотеку от 5%', '#1d3557', '#ffd23f'], ['ШИНОМОНТАЖ', 'круглосуточно', '#222', '#ff7b00'], ['ОКНА ПВХ', 'замер бесплатно', '#f1faee', '#1d3557'],
  ['СУШИ · ПИЦЦА', 'доставка 30 минут', '#9d0208', '#fff'], ['ФИТНЕС', 'первый месяц даром', '#3a0ca3', '#fff'], ['ВЕЛОМАГАЗИН', 'всё для шоссе', '#2a9d8f', '#fff'],
  ['ДАЧНЫЙ СЕЗОН', 'рассада и теплицы', '#588157', '#fff'], ['СТОМАТОЛОГИЯ', 'улыбайтесь чаще', '#e9ecef', '#0077b6'],
];
function billboard() {
  const [l1, l2, bg, fg] = pick(ADS);
  const tex = canvasTexture(384, 192, (c, w, h) => {
    c.fillStyle = bg; c.fillRect(0, 0, w, h);
    c.fillStyle = fg; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.font = 'bold 58px sans-serif'; c.fillText(l1, w / 2, 78, w - 24);
    c.font = 'bold 30px sans-serif'; c.fillText(l2, w / 2, 138, w - 24);
  });
  const g = new THREE.Group();
  const board = new THREE.Mesh(new THREE.PlaneGeometry(6, 3), new THREE.MeshBasicMaterial({ map: tex }));
  board.position.y = 6.2;
  g.add(board, box(6.2, 3.2, 0.16, 0x4a4f57, 0, 6.2, -0.1), box(0.25, 4.8, 0.25, 0x6c757d, -2.2, 2.4, -0.15), box(0.25, 4.8, 0.25, 0x6c757d, 2.2, 2.4, -0.15));
  return g;
}
function entrance(side) { // подъезд: дверь, козырёк, ступенька
  const g = new THREE.Group();
  g.add(box(0.1, 2.1, 1.3, 0x6b4f3a, 0, 1.05, 0), box(1.3, 0.14, 2.4, 0x5b6168, -side * 0.6, 2.45, 0), box(1.0, 0.2, 2.0, 0x9a9a94, -side * 0.5, 0.1, 0));
  g.add(box(0.08, 2.4, 0.08, 0x5b6168, -side * 1.15, 1.2, 1.1), box(0.08, 2.4, 0.08, 0x5b6168, -side * 1.15, 1.2, -1.1));
  return g;
}
function bench() {
  const g = new THREE.Group();
  g.add(box(0.45, 0.08, 1.6, 0x8a5a3c, 0, 0.5, 0), box(0.08, 0.5, 1.6, 0x8a5a3c, 0.22, 0.85, 0), box(0.4, 0.5, 0.08, 0x3d4046, 0, 0.25, -0.6), box(0.4, 0.5, 0.08, 0x3d4046, 0, 0.25, 0.6));
  return g;
}
function trafficLight(side) {
  const g = new THREE.Group();
  g.add(box(0.14, 3.6, 0.14, 0x3d4046, 0, 1.8, 0), box(0.36, 1.0, 0.3, 0x1f2328, 0, 3.3, 0));
  const lampMat = (c) => new THREE.MeshBasicMaterial({ color: c });
  [[0x5a1a1a, 3.6], [0x5a4a10, 3.3], [0x38e07b, 3.0]].forEach(([c, y]) => { const l = new THREE.Mesh(new THREE.CircleGeometry(0.11, 10), lampMat(c)); l.position.set(0, y, 0.16); g.add(l); });
  return g;
}
function crosswalk() { // зебра поперёк дороги со светофорами и знаками
  const g = new THREE.Group();
  for (let x = -4.4; x <= 4.4; x += 1.1) { const st = box(0.6, 0.02, 3.2, 0xe8e8e8, x, 0.025, 0); st.receiveShadow = true; g.add(st); }
  for (const s of [-1, 1]) {
    const tl = trafficLight(s); tl.position.set(s * 6.0, 0, 2.4); g.add(tl);
    const sg = roadSign('cross'); sg.position.set(s * 6.3, 0, 4.2); g.add(sg);
    if (Math.random() < 0.25) { const p = person(); p.rotation.y = -s * Math.PI / 2; p.position.set(s * rand(6.6, 8.2), 0.07, rand(-1.2, 1.2)); g.add(p); }
  }
  return g;
}

// ---------- Одинцово: дома и ориентиры по фотографиям города ----------
const texCache = {};
const cached = (key, make) => (texCache[key] ||= make());
const lambertMap = (key, tex) => cached('m_' + key, () => new THREE.MeshLambertMaterial({ map: tex }));
function facadeBox(len, h, depth, frontMat, sideColor, roofColor = 0x5a5f66) { // коробка с фасадом, обращённым к дороге
  const side = wallMat(sideColor), roof = mat(roofColor);
  const m = new THREE.Mesh(new THREE.BoxGeometry(depth, h, len, Math.ceil(depth / 8), 1, Math.ceil(len / 8)), [frontMat, frontMat, roof, roof, side, side]);
  m.position.y = h / 2;
  const ao = blob(depth + 4, len + 4, 0.6); ao.position.y = -h / 2 + 0.04; m.add(ao); // затемнение земли у стен
  return m;
}
// объёмные детали на ближних зданиях: парапет, цоколь, козырёк, пилястры, ступени, кондиционеры
function dress(m, side, { len, h, depth, awning, pilasters = 0, pilColor = 0x999999, pilDepth = 0.3, parapet = 0x55595f, plinth = 0x4b4f55, steps = [], ac = 0, canopy }) {
  const out = -side, fx = (out * depth) / 2, y0 = -h / 2;
  if (parapet !== null) m.add(box(depth + 0.5, 0.4, len + 0.5, parapet, 0, h / 2 + 0.2, 0));
  if (plinth !== null) m.add(box(depth + 0.25, 0.6, len + 0.25, plinth, 0, y0 + 0.3, 0));
  if (awning) {
    m.add(box(awning.d, 0.16, len - 0.8, awning.color, fx + (out * awning.d) / 2, y0 + awning.y, 0));
    m.add(box(0.1, 0.42, len - 0.8, awning.color, fx + out * awning.d, y0 + awning.y - 0.16, 0));
  }
  for (let i = 0; i < pilasters; i++) m.add(box(pilDepth, h, 0.5, pilColor, fx + (out * pilDepth) / 2, 0, -len / 2 + 0.25 + (i / (pilasters - 1)) * (len - 0.5)));
  for (const z of steps) m.add(box(0.7, 0.3, 2.2, 0x9a9a94, fx + out * 0.35, y0 + 0.15, z), box(0.5, 0.15, 2.2, 0x8d8d88, fx + out * 0.95, y0 + 0.08, z));
  if (canopy) { // козырёк над входом на стойках
    m.add(box(canopy.d, 0.3, canopy.w, canopy.color, fx + (out * canopy.d) / 2, y0 + canopy.y, canopy.z ?? 0));
    for (const dz of [-canopy.w / 2 + 0.3, canopy.w / 2 - 0.3]) m.add(box(0.25, canopy.y, 0.25, 0x6c757d, fx + out * (canopy.d - 0.3), y0 + canopy.y / 2, (canopy.z ?? 0) + dz));
  }
  for (let i = 0; i < ac; i++) m.add(box(1.6, 0.9, 1.6, 0x8d949b, rand(-depth / 3, depth / 3), h / 2 + 0.85, rand(-len / 2 + 2, len / 2 - 2)));
  return m;
}
function drawText(c, text, x, y, size, color, maxW, align = 'center') {
  c.fillStyle = color; c.font = `bold ${size}px sans-serif`; c.textAlign = align; c.textBaseline = 'middle';
  c.fillText(text, x, y, maxW);
}
// фасады башен: бело-зелёная новостройка и бежевая панельная высотка
function towerTex(style, floors, v) {
  return cached(`tower_${style}_${floors}_${v}`, () => bakedTexture(256, floors * 24, (c, w, h) => {
    const cols = 8, cw = w / cols, fh = 24;
    if (style === 'ii68') { // башня II-68: сплошные ленты лоджий, ограждения белые или бежевые, верхний этаж — бордовый
      const bw = w / 5, P = [{ wall: '#eceae2', rail: ['#f4f2ea', '#e9e4d4'] }, { wall: '#c9c8c2', rail: ['#d6c69a', '#cdb98a'] }, { wall: '#e2dfd4', rail: ['#e6d9b4', '#f0ece0'] }][v];
      c.fillStyle = P.wall; c.fillRect(0, 0, w, h);
      for (let f = 0; f < floors; f++) for (let i = 0; i < 5; i++) {
        const x = i * bw, y = f * fh, solid = i === 2 && v !== 1;        // средняя секция — глухая стена с окнами
        if (solid) { c.fillStyle = '#f3f1ea'; c.fillRect(x + 12, y + 5, bw - 24, fh - 10); c.fillStyle = Math.random() < 0.13 ? '#f2d16b' : '#3d4a58'; c.fillRect(x + 14, y + 7, bw - 28, fh - 14); continue; }
        c.fillStyle = '#4a5562'; c.fillRect(x + 2, y + 2, bw - 4, fh - 4);
        for (let k = 0; k < 3; k++) { c.fillStyle = Math.random() < 0.12 ? '#f2d16b' : pick(['#5b6b7c', '#6f8092', '#4a5866', '#93a2ad', '#d9dde0']); c.fillRect(x + 4 + k * (bw - 8) / 3, y + 4, (bw - 8) / 3 - 2, fh - 15); }
        c.fillStyle = f === 0 ? '#8c4a3e' : Math.random() < 0.85 ? P.rail[0] : P.rail[1]; c.fillRect(x + 2, y + fh - 10, bw - 4, 8);
        c.fillStyle = 'rgba(0,0,0,.18)'; c.fillRect(x + 2, y + fh - 2.5, bw - 4, 1.5);
      }
      c.fillStyle = P.wall; for (let i = 0; i <= 5; i++) c.fillRect(Math.min(w - 2, Math.max(0, i * bw - 2)), 0, 4, h);
      c.fillStyle = '#9a9c9e'; c.fillRect(0, h - fh, w, fh); c.fillStyle = '#3d4650'; for (let i = 0; i < 8; i++) c.fillRect(8 + i * 31, h - fh + 5, 22, fh - 9); // первый этаж — витрины
      return;
    }
    if (style === 'long') { // секция длинной панельки: кремовые стены, окна, столбцы белых балконов, жёлтая полоса под крышей
      const bw = w / 4, wall = ['#e9dfc4', '#e4dcc8', '#ded6bd'][v];
      c.fillStyle = wall; c.fillRect(0, 0, w, h);
      c.strokeStyle = 'rgba(90,70,30,.13)'; c.lineWidth = 1;
      for (let f = 0; f <= floors; f++) { c.beginPath(); c.moveTo(0, f * fh + 0.5); c.lineTo(w, f * fh + 0.5); c.stroke(); }
      for (let f = 0; f < floors; f++) for (let i = 0; i < 4; i++) {
        const x = i * bw, y = f * fh;
        if (i === 1 || i === 2) {                                        // балконы: белое ограждение, остекление
          c.fillStyle = '#566170'; c.fillRect(x + 3, y + 2, bw - 6, fh - 4);
          c.fillStyle = Math.random() < 0.12 ? '#f2d16b' : pick(['#6b7b8c', '#8796a3', '#55636f']); c.fillRect(x + 5, y + 4, bw - 10, fh - 15);
          c.fillStyle = Math.random() < 0.8 ? '#f4f2ec' : '#d9cfae'; c.fillRect(x + 3, y + fh - 10, bw - 6, 8);
        } else { c.fillStyle = '#f6f4ee'; c.fillRect(x + 14, y + 5, bw - 28, fh - 11); c.fillStyle = Math.random() < 0.13 ? '#f2d16b' : '#3d4a58'; c.fillRect(x + 16, y + 7, bw - 32, fh - 15); }
      }
      c.fillStyle = '#d8b04e'; c.fillRect(0, 0, w, 7); c.fillStyle = '#a9a69c'; c.fillRect(0, h - fh, w, fh);
      return;
    }
    if (style === 'brick') { // кирпично-оранжевая башня с белыми балконными полосами
      c.fillStyle = pick(['#c4623a', '#bd5a35', '#c96a44']); c.fillRect(0, 0, w, h);
      for (let f = 0; f < floors; f++) for (let i = 0; i < cols; i++) {
        if (i === 1 || i === 2 || i === 5 || i === 6) {
          c.fillStyle = '#efeae0'; c.fillRect(i * cw, f * fh, cw, fh);
          c.fillStyle = Math.random() < 0.25 ? '#8fa3b3' : '#b8c6d0'; c.fillRect(i * cw + 3, f * fh + 3, cw - 6, fh - 10);
          c.fillStyle = '#d9d2c4'; c.fillRect(i * cw, f * fh + fh - 5, cw, 5);
        } else { c.fillStyle = '#f3efe6'; c.fillRect(i * cw + 8, f * fh + 5, cw - 16, fh - 10); c.fillStyle = Math.random() < 0.15 ? '#f2d16b' : '#3a4654'; c.fillRect(i * cw + 10, f * fh + 7, cw - 20, fh - 14); }
      }
      c.fillStyle = '#d8c7a0'; c.fillRect(0, h - fh, w, fh); c.fillStyle = '#8f8a80'; c.fillRect(0, 0, w, 6);
      return;
    }
    if (style === 'slab') { // длинная 12-этажка после ремонта: светлые панели и цветные полосы
      const accent = v % 2 ? '#2743c4' : '#c8283a';
      c.fillStyle = v % 2 ? '#b9c3d6' : '#c8d6e0'; c.fillRect(0, 0, w, h);
      c.fillStyle = accent; c.fillRect(0, 0, w, 14);
      for (const i of [0, 3, 7]) c.fillRect(i * cw, 0, cw * (i === 3 ? 0.9 : 1), h);
      c.fillStyle = '#d9cfae'; c.fillRect(5 * cw, 4 * fh, cw * 1.6, 3 * fh);
      for (let f = 0; f < floors; f++) for (let i = 0; i < cols; i++) {
        c.fillStyle = '#eef1f4'; c.fillRect(i * cw + 6, f * fh + 5, cw - 12, fh - 10);
        c.fillStyle = Math.random() < 0.15 ? '#f2d16b' : '#3a4654'; c.fillRect(i * cw + 8, f * fh + 7, cw - 16, fh - 14);
      }
      c.fillStyle = 'rgba(40,40,50,.4)'; c.fillRect(0, h - fh, w, fh);
      return;
    }
    if (style === 'green') {
      c.fillStyle = '#f1f1ec'; c.fillRect(0, 0, w, h);
      c.fillStyle = '#74c22e';
      for (let i = 0; i < floors * 0.9; i++) c.fillRect(Math.floor(Math.random() * cols) * cw, Math.floor(Math.random() * floors) * fh, cw * (1 + Math.floor(Math.random() * 3)), fh * (1 + Math.floor(Math.random() * 3)));
      c.fillStyle = '#6b4a3a'; c.fillRect(0, h - 2 * fh, w, 2 * fh); // кирпичный низ
      for (let f = 0; f < floors; f++) for (let i = 0; i < cols; i++) {
        c.fillStyle = Math.random() < 0.12 ? '#f2d16b' : '#26303c'; c.fillRect(i * cw + 9, f * fh + 5, cw - 18, fh - 10);
        if (i % 4 === 2) { c.fillStyle = 'rgba(40,50,60,.6)'; c.fillRect(i * cw + 3, f * fh + fh - 6, cw - 6, 2); }
      }
    } else {
      const wall = pick(['#d9cfb8', '#cfc8b6', '#d6d2c4']);
      c.fillStyle = wall; c.fillRect(0, 0, w, h);
      for (let f = 0; f < floors; f++) for (let i = 0; i < cols; i++) {
        c.strokeStyle = 'rgba(0,0,0,.14)'; c.strokeRect(i * cw + 0.5, f * fh + 0.5, cw, fh);
        if (i === 1 || i === 2 || i === 5 || i === 6) { // остеклённые балконы
          c.fillStyle = Math.random() < 0.2 ? '#c9b48c' : '#aebcc6'; c.fillRect(i * cw + 2, f * fh + 4, cw - 4, fh - 10);
          c.fillStyle = '#8a7f6a'; c.fillRect(i * cw + 1, f * fh + fh - 6, cw - 2, 5);
        } else { c.fillStyle = Math.random() < 0.15 ? '#f2d16b' : '#33404d'; c.fillRect(i * cw + 9, f * fh + 6, cw - 18, fh - 12); }
      }
      c.fillStyle = 'rgba(60,50,40,.35)'; c.fillRect(0, h - fh, w, fh);
    }
  }));
}
// ---------- Панельные дома по образцу готовых моделей, но нарисованные в стиле города ----------
// Девятиэтажка: серо-голубые панели, бежевый второй этаж, серый первый, бордовый цоколь,
// лестничные клетки в коричневой плитке с круглыми окнами, козырьки подъездов, застеклённые лоджии.
const P9 = { len: 30, h: 28.6, depth: 13, floors: 9, bay: 3, plinth: 1.6 };
const P9_COLS = ['w', 'w', 's', 'w', 'l', 'l', 'w', 's', 'w', 'w']; // по 3 м: окно, лестница, лоджия
function panel9Tex(v) {
  return cached('panel9_' + v, () => bakedTexture(1024, 768, (c, w, h) => {
    const kx = w / P9.len, ky = h / P9.h, fh = (P9.h - P9.plinth) / P9.floors;
    const R = (x, y, ww, hh, col) => { c.fillStyle = col; c.fillRect(x * kx, h - (y + hh) * ky, ww * kx, hh * ky); }; // метры, y от земли
    const wall = ['#c7d2e0', '#cfd6dc', '#c3cfdc'][v % 3];
    R(0, 0, P9.len, P9.h, wall);
    R(0, P9.plinth, P9.len, fh, '#8f9299');                       // первый этаж — серый
    R(0, P9.plinth + fh, P9.len, fh, ['#cfa67e', '#c9b08a', '#d0a183'][v % 3]); // второй — бежевый
    R(0, 0, P9.len, P9.plinth, '#8a3340'); R(0, P9.plinth - 0.12, P9.len, 0.12, '#6e2632'); // бордовый цоколь
    R(0, P9.h - 0.5, P9.len, 0.5, '#aeb6c2'); R(0, P9.h - 0.75, P9.len, 0.16, '#b23a44');     // парапет с красной линией
    c.strokeStyle = 'rgba(40,50,70,.22)'; c.lineWidth = 1.5;        // швы панелей
    for (let f = 0; f <= P9.floors; f++) { const y = h - (P9.plinth + f * fh) * ky; c.beginPath(); c.moveTo(0, y); c.lineTo(w, y); c.stroke(); }
    for (let x = 0; x <= P9.len; x += P9.bay) { c.beginPath(); c.moveTo(x * kx, 0); c.lineTo(x * kx, h - P9.plinth * ky); c.stroke(); }
    P9_COLS.forEach((kind, i) => {
      const x0 = i * P9.bay;
      for (let f = 0; f < P9.floors; f++) {
        const y0 = P9.plinth + f * fh;
        if (kind === 'w') {                                         // окно: белая рама, стекло, иногда шторы или свет
          R(x0 + 0.72, y0 + 0.85, 1.56, 1.5, '#f2f3f1');
          const glass = Math.random() < 0.12 ? '#f2d16b' : Math.random() < 0.2 ? '#7d5a50' : '#34424f';
          R(x0 + 0.8, y0 + 0.93, 0.62, 1.34, glass); R(x0 + 1.5, y0 + 0.93, 0.7, 1.34, glass);
          R(x0 + 0.66, y0 + 0.78, 1.68, 0.08, '#9aa3ad');
        } else if (kind === 'l') {                                  // лоджия: ограждение и остекление
          R(x0 + 0.1, y0 + 0.1, 2.8, fh - 0.2, '#56606b');
          R(x0 + 0.1, y0 + 0.1, 2.8, 1.05, pick(['#b9c0c8', '#a9b3bd', '#c4b8a4', '#9fb0c0']));
          for (let k = 0; k < 4; k++) R(x0 + 0.18 + k * 0.68, y0 + 1.25, 0.6, fh - 1.5, Math.random() < 0.15 ? '#f2d16b' : pick(['#3b4856', '#465563', '#6d7b86']));
          R(x0 + 0.1, y0 + 1.15, 2.8, 0.08, '#e8eaec');
        }
      }
    });
  }));
}
const stairTex = () => cached('panel9_stair', () => bakedTexture(128, 768, (c, w, h) => {
  const ky = h / P9.h, fh = (P9.h - P9.plinth) / P9.floors;
  c.fillStyle = '#7b4f40'; c.fillRect(0, 0, w, h);
  c.strokeStyle = 'rgba(30,15,10,.3)'; c.lineWidth = 1;             // мелкая плитка
  for (let x = 0; x < w; x += 8) { c.beginPath(); c.moveTo(x + 0.5, 0); c.lineTo(x + 0.5, h); c.stroke(); }
  for (let y = 0; y < h; y += 8) { c.beginPath(); c.moveTo(0, y + 0.5); c.lineTo(w, y + 0.5); c.stroke(); }
  for (let f = 1; f < P9.floors; f++) {                             // круглые окна лестничной клетки
    const cy = h - (P9.plinth + f * fh + fh * 0.45) * ky;
    c.fillStyle = '#d9cdb8'; c.beginPath(); c.arc(w / 2, cy, 34, 0, 7); c.fill();
    c.fillStyle = '#8a5f4c'; c.beginPath(); c.arc(w / 2, cy, 27, 0, 7); c.fill();
    c.fillStyle = '#f0ede6'; c.fillRect(w / 2 - 15, cy - 17, 30, 34); c.fillStyle = Math.random() < 0.2 ? '#f2d16b' : '#2f3b47'; c.fillRect(w / 2 - 12, cy - 14, 24, 28);
  }
  c.fillStyle = '#5d3a30'; c.fillRect(0, h - (P9.plinth + fh) * ky, w, (P9.plinth + fh) * ky);
}));
function panel9(side) { // девятиэтажка длинной стороной вдоль дороги, подъездами к ней
  const g = new THREE.Group(), v = Math.floor(Math.random() * 3), wall = [0xc7d2e0, 0xcfd6dc, 0xc3cfdc][v];
  g.add(facadeBox(P9.len, P9.h, P9.depth, lambertMap('panel9_' + v, panel9Tex(v)), wall));
  const front = -side * P9.depth / 2, sm = lambertMap('panel9_stair', stairTex());
  P9_COLS.forEach((kind, i) => {
    const z = -P9.len / 2 + (i + 0.5) * P9.bay;
    if (kind === 's') {
      const col = new THREE.Mesh(new THREE.BoxGeometry(0.7, P9.h + 0.9, P9.bay - 0.3), [sm, sm, mat(0x5a5f66), mat(0x5a5f66), wallMat(0x7b4f40), wallMat(0x7b4f40)]);
      col.position.set(front - side * 0.3, (P9.h + 0.9) / 2, z); g.add(col);                   // лестничная клетка выступает и поднимается над крышей
      g.add(box(2.6, 0.22, 3.6, 0x55666f, front - side * 1.6, 3.0, z), box(2.2, 2.9, 0.18, 0x6b4a3c, front - side * 1.5, 1.45, z - 1.6), box(2.2, 2.9, 0.18, 0x6b4a3c, front - side * 1.5, 1.45, z + 1.6)); // козырёк и стенки подъезда
      g.add(box(0.1, 2.2, 1.3, 0x2b2f35, front - side * 0.68, 1.1, z));                          // дверь
    }
  });
  g.add(box(P9.depth + 0.3, 0.35, P9.len + 0.3, 0x6c7178, 0, P9.h + 0.17, 0));
  for (const z of [-9, 9]) g.add(box(2.2, 1.4, 2.2, 0x8a8f96, side * 2, P9.h + 1.0, z));
  return g;
}
function longHouse(side, zs = [-13, 0, 13], step = 2.6) { // длинная панелька в 12–14 этажей: секции уступами, как на картах Одинцова
  const g = new THREE.Group(), v = Math.floor(Math.random() * 3), floors = pick([12, 14]), dir = Math.random() < 0.5 ? 1 : -1;
  const wall = [0xe9dfc4, 0xe4dcc8, 0xded6bd][v];
  zs.forEach((z, i) => {
    const fl = i === zs.length - 1 && Math.random() < 0.35 ? floors - 2 : floors, h = fl * 3;
    const sec = facadeBox(13, h, 13, lambertMap(`long_${fl}_${v}`, towerTex('long', fl, v)), wall);
    sec.position.set(side * dir * (i - (zs.length - 1) / 2) * step, h / 2, z);            // уступ в плане
    g.add(sec, box(13.3, 0.5, 13.3, 0x77726a, sec.position.x, h + 0.25, z), box(3, 2.4, 3, 0x9a968c, sec.position.x, h + 1.4, z));
  });
  return g;
}
function tower(style) {
  const g = new THREE.Group();
  if (style === 'ii68') { // 16-этажная панельная башня: сплошные ленты лоджий с цветными ограждениями
    const v = Math.floor(Math.random() * 3), m = lambertMap('ii68_' + v, towerTex('ii68', 16, v));
    g.add(facadeBox(27, 48, 15, m, [0xb9bbb8, 0x9fa3a4, 0xb4b3ab][v]));               // торцы в серой плитке
    g.add(box(15.5, 1.1, 27.5, 0x8c4a3e, 0, 48.2, 0), box(6, 3, 7, 0x8a8f96, 0, 50.2, rand(-6, 6))); // бордовый пояс под крышей, машинное отделение
    return g;
  }
  const floors = style === 'green' ? pick([14, 16]) : style === 'slab' ? 9 : style === 'brick' ? pick([12, 14, 16]) : pick([12, 14]); // красные и синие — девятиэтажки, панельки — 12–14
  const h = floors * 3, v = Math.floor(Math.random() * 3), key = `${style}_${floors}_${v}`;
  const tex = towerTex(style, floors, v), m = lambertMap(key, tex), roof = mat(0x5a5f66);
  if (style === 'slab') {
    g.add(facadeBox(38, h, 13, m, v % 2 ? 0x2743c4 : 0xc8283a));
    for (const z of [-12, 0, 12]) g.add(box(3, 2.2, 3, 0x9aa1a8, 0, h + 1.1, z)); // вентшахты на крыше
  } else if (style === 'brick') {
    g.add(facadeBox(26, h, 14, m, 0xbd5a35));
    for (const z of [-7.5, 7.5]) g.add(box(15.4, h - 3, 4.2, 0xefeae0, 0, (h - 3) / 2, z));
    g.add(box(5, 3, 6, 0xb5552f, 0, h + 1.5, 0));
  } else if (style === 'green') { // скруглённые торцы
    const depth = 15, len = 14;
    g.add(facadeBox(len, h, depth, m, 0xf1f1ec));
    const wrap = cached('wrap_' + key, () => { const t = tex.clone(); t.wrapS = THREE.RepeatWrapping; t.repeat.x = 3; t.needsUpdate = true; return new THREE.MeshLambertMaterial({ map: t }); });
    for (const sz of [-1, 1]) {
      const cyl = new THREE.Mesh(new THREE.CylinderGeometry(depth / 2, depth / 2, h, 20), [wrap, roof, roof]);
      cyl.position.set(0, h / 2, sz * len / 2); g.add(cyl);
    }
  } else { // панельная башня с выступающими балконными секциями
    g.add(facadeBox(26, h, 14, m, 0xcfc8b6));
    for (const z of [-7.5, 7.5]) g.add(box(15.6, h - 4, 4.5, 0xc4bca8, 0, (h - 4) / 2, z));
    g.add(box(4, 2.5, 5, 0x6c757d, 0, h + 1.25, rand(-8, 8)));
  }
  return g;
}
// длинная розовая двухэтажная пристройка с магазинами — главная примета улицы
const SHOP_NAMES = [
  ['ЦВЕТЫ', '#2a9d8f'], ['АПТЕКА', '#2b9348'], ['ФОТО', '#d62828'], ['АТЕЛЬЕ', '#6d597a'], ['ПРОДУКТЫ', '#e76f51'], ['ХОЗТОВАРЫ', '#588157'],
  ['РЕМОНТ ОБУВИ', '#495057'], ['ПЕКАРНЯ', '#bc6c25'], ['ОПТИКА', '#0077b6'], ['КНИГИ', '#3a0ca3'], ['ЗООТОВАРЫ', '#c1121f'], ['ПАРИКМАХЕРСКАЯ', '#b5179e'],
  ['КАНЦТОВАРЫ', '#1d3557'], ['ШКОЛА ИСКУССТВ', '#7b2cbf'], ['КАРАОКЕ', '#ff7b00'], ['ДОМ БЫТА', '#264653'],
];
function annexTex(v) {
  return cached('annex_' + v, () => bakedTexture(1024, 192, (c, w, h) => {
    c.fillStyle = pick(['#d58a9c', '#cf8496', '#db95a4']); c.fillRect(0, 0, w, h);
    c.fillStyle = 'rgba(120,40,60,.35)'; c.fillRect(0, 0, w, 10);
    c.strokeStyle = 'rgba(90,30,50,.22)'; c.lineWidth = 1;
    for (let x = 0; x < w; x += 64) { c.beginPath(); c.moveTo(x + 0.5, 0); c.lineTo(x + 0.5, h); c.stroke(); }
    for (const y of [34, 96]) { c.beginPath(); c.moveTo(0, y + 0.5); c.lineTo(w, y + 0.5); c.stroke(); }
    c.fillStyle = '#2e3a48'; c.fillRect(0, 40, w, 50); // ленточное остекление второго этажа
    c.fillStyle = 'rgba(255,255,255,.55)'; for (let x = 0; x < w; x += 32) c.fillRect(x, 40, 2, 50);
    c.fillRect(0, 64, w, 2);
    const n = 6, sw = w / n; // магазины первого этажа
    for (let i = 0; i < n; i++) {
      const [name, col] = pick(SHOP_NAMES), x = i * sw;
      c.fillStyle = '#34414f'; c.fillRect(x + 8, 128, sw - 16, 64);
      c.fillStyle = 'rgba(255,255,255,.5)'; c.fillRect(x + sw / 2 - 1, 128, 2, 64);
      c.fillStyle = '#5b4636'; c.fillRect(x + sw / 2 - 16, 140, 32, 52);
      c.fillStyle = col; c.fillRect(x + 6, 102, sw - 12, 24);
      drawText(c, name, x + sw / 2, 115, 19, '#fff', sw - 22);
    }
  }));
}
function annex(side) {
  const v = Math.floor(Math.random() * 6);
  const m = facadeBox(CHUNK_LEN, 7.5, 9, lambertMap('annex_' + v, annexTex(v)), 0xcf8496, 0x6c6468);
  return dress(m, side, { len: CHUNK_LEN, h: 7.5, depth: 9, awning: { y: 3.62, d: 1.3, color: 0x9c5a6c }, pilasters: 7, pilColor: 0xc27a8c, parapet: 0x8a5a66, steps: [-16.6, -10, -3.3, 3.3, 10, 16.6], ac: 4 });
}
// павильоны и магазины у дороги
function pavilionTex(style) {
  return cached('pav_' + style, () => bakedTexture(512, 192, (c, w, h) => {
    if (style === 'grill') {
      c.fillStyle = '#2b333c'; c.fillRect(0, 0, w, h);
      c.fillStyle = 'rgba(255,255,255,.35)'; for (let x = 0; x < w; x += 64) c.fillRect(x, 56, 3, h);
      c.fillStyle = '#b5651d'; c.fillRect(70, 70, 90, 122); c.fillRect(420, 70, 40, 122);
      c.fillStyle = '#d62828'; c.fillRect(0, 0, w, 54);
      drawText(c, '24  ГРИЛЬ · МАНГАЛ  24', w / 2, 28, 32, '#fff', w - 30);
    } else if (style === 'coffee') {
      c.fillStyle = '#39434d'; c.fillRect(0, 0, w, h);
      c.fillStyle = '#8a5a3c'; for (const x of [0, 150, 330, 480]) c.fillRect(x, 50, 32, 142);
      c.fillStyle = '#ece6da'; c.fillRect(0, 0, w, 48); c.fillRect(0, 170, w, 22);
      drawText(c, 'КОФЕ · ВЫПЕЧКА', w / 2, 25, 30, '#5a6270', w - 40);
    } else if (style === 'burger') { // бургерная: тёмные деревянные рейки, стекло
      c.fillStyle = '#39434d'; c.fillRect(0, 0, w, h);
      c.fillStyle = 'rgba(255,255,255,.3)'; for (let x = 150; x < 400; x += 50) c.fillRect(x, 64, 3, h);
      c.fillStyle = '#5a3a26'; c.fillRect(0, 0, 150, h); c.fillRect(400, 0, 112, h);
      c.fillStyle = 'rgba(0,0,0,.3)'; for (let x = 0; x < w; x += 9) { if (x < 150 || x > 400) c.fillRect(x, 0, 3, h); }
      c.fillStyle = '#2f5d4a'; c.fillRect(0, 0, w, 50);
      drawText(c, 'БУРГЕРЫ · КАРТОШКА', w / 2, 26, 30, '#fff', w - 40);
    } else if (style === 'kiosk') { // стеклянный киоск с витриной
      c.fillStyle = '#566579'; c.fillRect(0, 0, w, h);
      const cols = ['#c0392b', '#f1c40f', '#27ae60', '#ecf0f1', '#e67e22', '#8e44ad', '#2980b9'];
      for (let i = 0; i < 6; i++) for (let j = 0; j < 3; j++) { c.fillStyle = pick(cols); c.fillRect(22 + i * 80, 34 + j * 36, 62, 30); }
      c.fillStyle = '#3c4858'; for (let i = 0; i <= 6; i++) c.fillRect(14 + i * 80, 24, 6, 122); c.fillRect(0, 0, w, 26); c.fillRect(0, 146, w, 46);
    } else if (style === 'apteka') { // белая аптека с зелёным крестом
      c.fillStyle = '#eeeeea'; c.fillRect(0, 0, w, h);
      c.strokeStyle = 'rgba(0,0,0,.1)'; for (let x = 0; x < 200; x += 14) { c.beginPath(); c.moveTo(x + 0.5, 0); c.lineTo(x + 0.5, h); c.stroke(); }
      c.fillStyle = '#22a04a'; c.fillRect(250, 60, 70, 132); c.fillRect(400, 60, 70, 132); c.fillRect(290, 14, 14, 40); c.fillRect(277, 27, 40, 14);
      c.fillStyle = '#34414f'; c.fillRect(258, 80, 54, 112); c.fillRect(408, 80, 54, 112); c.fillRect(336, 70, 50, 122);
      drawText(c, 'АПТЕКА', 400, 34, 30, '#22a04a', 170);
    } else { // зоомагазин с красным порталом входа
      c.fillStyle = '#b9bcbc'; c.fillRect(0, 0, w, h);
      c.strokeStyle = 'rgba(0,0,0,.15)'; for (let x = 0; x < w; x += 64) c.strokeRect(x + 0.5, 60, 64, 66);
      c.fillStyle = '#34414f'; for (const x of [40, 130, 360, 440]) c.fillRect(x, 96, 60, 70);
      c.fillStyle = '#e02b20'; c.fillRect(0, 0, w, 58); c.fillRect(226, 0, 76, h);
      c.fillStyle = '#34414f'; c.fillRect(240, 96, 48, 96);
      drawText(c, 'ЗООМАГАЗИН', 116, 30, 30, '#fff', 210); drawText(c, 'ВЕТАПТЕКА 24', 404, 30, 26, '#fff', 190);
    }
  }));
}
function pavilion(style, side = 1) {
  const sideColor = { coffee: 0xece6da, burger: 0x5a3a26, kiosk: 0x566579, apteka: 0xeeeeea }[style] ?? 0x8f9396;
  const g = new THREE.Group();
  const body = facadeBox(style === 'kiosk' ? 7 : 10, style === 'kiosk' ? 2.7 : 3.6, style === 'kiosk' ? 3.2 : 5, lambertMap('pav_' + style, pavilionTex(style)), sideColor, 0x4a4f57);
  if (style !== 'kiosk') dress(body, side, { len: 10, h: 3.6, depth: 5, awning: style === 'apteka' ? null : { y: 2.62, d: 0.9, color: { grill: 0xa81f1f, coffee: 0xcfc7b8, burger: 0x24493a, zoo: 0xb8231a }[style] ?? 0x555555 }, parapet: 0x3d4248, plinth: 0x55595f, steps: [0], ac: 1 });
  g.add(body);
  if (style === 'kiosk') { // скруглённый козырёк-крыша
    const roof = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.45, 7.6, 10), mat(0x4a5566)); roof.rotation.x = Math.PI / 2; roof.scale.x = 4.4; roof.position.y = 2.75; g.add(roof);
  }
  if (style === 'burger') g.add(box(7.4, 0.16, 10.6, 0x2f5d4a, 0, 3.75, 0));
  return g;
}
function greenShop(side) { // тёмный кирпич, ярко-зелёный пояс с вывесками
  const tex = cached('greenshop', () => bakedTexture(768, 256, (c, w, h) => {
    c.fillStyle = '#5c4d48'; c.fillRect(0, 0, w, h);
    c.strokeStyle = 'rgba(0,0,0,.2)'; for (let y = 60; y < h; y += 10) { c.beginPath(); c.moveTo(0, y + 0.5); c.lineTo(w, y + 0.5); c.stroke(); }
    c.fillStyle = '#e9eef2'; for (let i = 0; i < 6; i++) c.fillRect(60 + i * 115, 84, 56, 62);
    c.fillStyle = '#34414f'; c.fillRect(40, 176, 300, 80); c.fillRect(420, 176, 120, 80);
    c.fillStyle = '#58c322'; c.fillRect(0, 0, w, 54); c.fillRect(560, 54, 120, 60);
    drawText(c, 'ЦВЕТЫ    АПТЕКА    ЛАВАШ    ПРОДУКТЫ', w / 2, 28, 30, '#fff', w - 40);
    drawText(c, 'ОТКРЫТО', 620, 86, 20, '#fff', 100);
  }));
  const m = facadeBox(18, 8, 12, lambertMap('greenshop', tex), 0x5c4d48);
  dress(m, side, { len: 18, h: 8, depth: 12, parapet: 0x3fa016, plinth: 0x3d3532, steps: [-4.5], canopy: { d: 2.2, w: 4, y: 3.3, z: -4.5, color: 0x58c322 }, ac: 2 });
  const out = -side; // пандус с перилами
  m.add(box(1.4, 0.5, 9, 0x8d8d88, out * 6.9, -4 + 0.25, 3.5), box(0.06, 0.9, 9, 0x9aa1a8, out * 7.6, -4 + 0.95, 3.5));
  return m;
}
function mall(side) { // торговый центр с россыпью вывесок
  const tex = cached('mall', () => bakedTexture(1024, 320, (c, w, h) => {
    c.fillStyle = '#b8bdc4'; c.fillRect(0, 0, w, h);
    c.strokeStyle = 'rgba(0,0,0,.12)'; for (let x = 0; x < w; x += 48) c.strokeRect(x + 0.5, 0, 48, h);
    c.fillStyle = '#2f4c7a'; c.fillRect(300, 110, 300, 70); c.fillStyle = 'rgba(255,255,255,.5)'; for (let x = 300; x < 600; x += 30) c.fillRect(x, 110, 2, 70);
    c.fillStyle = '#34414f'; c.fillRect(40, 236, 940, 84);
    drawText(c, 'ТОРГОВЫЙ ЦЕНТР', 760, 52, 50, '#1d4fa0', 420);
    drawText(c, 'ПИЦЦА', 880, 150, 40, '#c2185b', 220); drawText(c, 'ЭЛЕКТРОНИКА', 760, 104, 26, '#e65100', 300);
    drawText(c, 'ОДЕЖДА', 150, 150, 40, '#fff', 240); drawText(c, 'СУПЕРМАРКЕТ', 150, 100, 26, '#2e7d32', 260);
    drawText(c, 'АПТЕКА', 700, 200, 22, '#2e7d32', 160); drawText(c, 'ЮВЕЛИРНЫЙ', 450, 205, 22, '#263238', 220);
    c.fillStyle = '#8a5a3c'; c.fillRect(600, 224, 424, 14);
  }));
  const m = facadeBox(34, 10.5, 14, lambertMap('mall', tex), 0xb8bdc4);
  return dress(m, side, { len: 34, h: 10.5, depth: 14, parapet: 0x8a9098, steps: [-2.5], canopy: { d: 3, w: 9, y: 3.6, z: -2.5, color: 0x596270 }, pilasters: 5, pilColor: 0xa9afb6, pilDepth: 0.45, ac: 5 });
}
function railing() { // низкое ограждение вдоль тротуара
  const g = new THREE.Group();
  g.add(box(0.05, 0.05, CHUNK_LEN - 6, 0x3d4046, 0, 0.95, 0), box(0.05, 0.05, CHUNK_LEN - 6, 0x3d4046, 0, 0.55, 0));
  for (let z = -16; z <= 16; z += 4) g.add(box(0.07, 0.95, 0.07, 0x3d4046, 0, 0.55, z));
  return g;
}
// герб города: упрощённо — белый олень на сине-зелёном щите
const crestTex = canvasTexture(128, 150, (c, w, h) => {
  c.beginPath(); c.moveTo(6, 6); c.lineTo(122, 6); c.lineTo(122, 100); c.quadraticCurveTo(110, 138, 64, 146); c.quadraticCurveTo(18, 138, 6, 100); c.closePath();
  c.save(); c.clip();
  c.fillStyle = '#2f7fc1'; c.fillRect(0, 0, w, h);
  c.fillStyle = '#3d8b3d'; c.beginPath(); c.moveTo(0, 104); c.quadraticCurveTo(64, 84, 128, 104); c.lineTo(128, 150); c.lineTo(0, 150); c.fill();
  c.fillStyle = '#fff';
  c.beginPath(); c.ellipse(62, 86, 30, 13, -0.1, 0, 7); c.fill();                    // тело лежащего оленя
  c.beginPath(); c.moveTo(80, 82); c.lineTo(92, 50); c.lineTo(100, 54); c.lineTo(92, 88); c.fill(); // шея
  c.beginPath(); c.ellipse(100, 48, 10, 6, 0.3, 0, 7); c.fill();                     // голова
  c.fillRect(34, 92, 26, 6); c.fillRect(70, 94, 22, 6);                              // ноги
  c.strokeStyle = '#f0c420'; c.lineWidth = 3;                                        // рога
  for (const d of [-1, 1]) { c.beginPath(); c.moveTo(96, 42); c.lineTo(96 + d * 10, 22); c.lineTo(96 + d * 16, 28); c.moveTo(96 + d * 8, 28); c.lineTo(96 + d * 4, 16); c.stroke(); }
  c.restore();
  c.strokeStyle = '#e8e8e8'; c.lineWidth = 4; c.stroke();
});
const crestMat = new THREE.MeshBasicMaterial({ map: crestTex, transparent: true, alphaTest: 0.5 });
function stela() { // въездная стела: белая, с двумя остриями, гербом и названием
  const g = new THREE.Group(), white = mat(0xf2f2ee);
  const solid = (draw) => {
    const sh = new THREE.Shape(); draw(sh);
    const m = new THREE.Mesh(new THREE.ExtrudeGeometry(sh, { depth: 0.45, bevelEnabled: false }), white);
    m.position.z = -0.225; g.add(m);
  };
  solid((p) => { p.moveTo(-0.7, 0); p.lineTo(-0.6, 2.2); p.quadraticCurveTo(-0.9, 2.9, -2.4, 3.1); p.lineTo(2.4, 3.1); p.quadraticCurveTo(0.9, 2.9, 0.6, 2.2); p.lineTo(0.7, 0); });
  solid((p) => { p.moveTo(-2.2, 3.95); p.quadraticCurveTo(-0.9, 4.6, -0.75, 6.4); p.lineTo(-0.75, 9.0); p.lineTo(-0.08, 9.8); p.lineTo(-0.08, 3.95); });
  solid((p) => { p.moveTo(0.08, 3.95); p.lineTo(0.08, 10.4); p.lineTo(0.75, 11.3); p.lineTo(0.75, 6.4); p.quadraticCurveTo(0.9, 4.6, 2.2, 3.95); });
  g.add(box(5.8, 0.85, 0.5, 0xf2f2ee, 0, 3.52, 0));
  const nameTex = cached('stelaName', () => canvasTexture(512, 72, (c, w, h) => { c.fillStyle = '#f2f2ee'; c.fillRect(0, 0, w, h); drawText(c, 'О Д И Н Ц О В О', w / 2, h / 2 + 2, 50, '#7a1f2b', w - 20); }));
  const name = new THREE.Mesh(new THREE.PlaneGeometry(5.6, 0.75), new THREE.MeshBasicMaterial({ map: nameTex })); name.position.set(0, 3.52, 0.26);
  const crest = new THREE.Mesh(new THREE.PlaneGeometry(1.15, 1.35), crestMat); crest.position.set(0, 7.2, 0.25);
  g.add(name, crest);
  return g;
}
function cityLetters() { // красно-жёлтые буквы на клумбе и щит с гербом
  const g = new THREE.Group();
  g.add(box(12, 0.5, 2.8, 0x4f9bd9, 0, 0.25, 0), box(11.5, 0.56, 2.3, 0x5a4636, 0, 0.28, 0));
  const tex = cached('letters', () => canvasTexture(1024, 160, (c, w, h) => {
    const grad = c.createLinearGradient(0, 20, 0, 140); grad.addColorStop(0, '#e23b2e'); grad.addColorStop(0.5, '#e23b2e'); grad.addColorStop(0.5, '#f5c518'); grad.addColorStop(1, '#f5c518');
    c.font = 'bold 150px sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.lineWidth = 10; c.strokeStyle = '#8f1d14'; c.strokeText('ОДИНЦОВО', w / 2, h / 2 + 6, w - 30);
    c.fillStyle = grad; c.fillText('ОДИНЦОВО', w / 2, h / 2 + 6, w - 30);
  }));
  const front = new THREE.Mesh(new THREE.PlaneGeometry(9.6, 1.5), new THREE.MeshBasicMaterial({ map: tex, transparent: true, alphaTest: 0.4 }));
  front.position.set(-0.6, 1.4, 0.2);
  const back = new THREE.Mesh(new THREE.PlaneGeometry(9.6, 1.5), new THREE.MeshBasicMaterial({ map: tex, transparent: true, alphaTest: 0.4, color: 0x6b1a12 }));
  back.position.set(-0.52, 1.36, 0.05);
  const crest = new THREE.Mesh(new THREE.PlaneGeometry(1.7, 2.0), crestMat); crest.position.set(5.2, 1.9, 0.3);
  g.add(front, back, crest, box(0.12, 1.2, 0.12, 0x6c757d, 5.2, 0.6, 0.2));
  return g;
}
function domeBuilding(side) { // круглое здание с куполом: серебристые панели, синее стекло, синие «пузыри»
  const g = new THREE.Group(), R = 9, z0 = 7, toRoad = -side;
  const panelTex = cached('domePanels', () => bakedTexture(512, 256, (c, w, h) => {
    c.fillStyle = '#c9ced3'; c.fillRect(0, 0, w, h);
    c.strokeStyle = 'rgba(0,0,0,.14)'; for (let x = 0; x < w; x += 32) for (let y = 0; y < h; y += 42) c.strokeRect(x + 0.5, y + 0.5, 32, 42);
    c.fillStyle = '#27407a'; for (let x = 20; x < w; x += 128) { c.fillRect(x, 90, 44, 54); c.fillRect(x + 64, 176, 44, 54); }
  }));
  const wrapMat = (key, rep) => cached('dome_' + key, () => { const t = panelTex.clone(); t.wrapS = THREE.RepeatWrapping; t.repeat.x = rep; t.needsUpdate = true; return new THREE.MeshLambertMaterial({ map: t }); });
  const silver = mat(0xc9ced3), roof = mat(0x8d949b);
  const drum = new THREE.Mesh(new THREE.CylinderGeometry(R, R, 11, 28), [wrapMat('main', 4), roof, roof]); drum.position.set(0, 6.7, z0);
  const brim = new THREE.Mesh(new THREE.CylinderGeometry(R + 0.9, R + 0.9, 0.5, 28), silver); brim.position.set(0, 12.4, z0);
  const ringTex = cached('domeRing', () => canvasTexture(1024, 48, (c, w, h) => { c.fillStyle = '#d5d9dd'; c.fillRect(0, 0, w, h); drawText(c, 'ФИТНЕС · БАССЕЙН · СПА · САЛОН КРАСОТЫ · ДЕТСКИЙ КЛУБ ·', w / 2, h / 2 + 1, 30, '#7d8791', w - 10); }));
  const ringT = cached('domeRingT', () => { const t = ringTex.clone(); t.wrapS = THREE.RepeatWrapping; t.repeat.x = 2; t.needsUpdate = true; return new THREE.MeshBasicMaterial({ map: t }); });
  const ring = new THREE.Mesh(new THREE.CylinderGeometry(R + 0.08, R + 0.08, 1.0, 28, 1, true), ringT); ring.position.set(0, 10.6, z0);
  const upperTex = cached('domeUpper', () => canvasTexture(512, 64, (c, w, h) => { c.fillStyle = '#c9ced3'; c.fillRect(0, 0, w, h); c.fillStyle = '#27407a'; for (let x = 8; x < w; x += 42) c.fillRect(x, 14, 28, 36); }));
  const upper = new THREE.Mesh(new THREE.CylinderGeometry(7.3, 7.3, 3.2, 24), [new THREE.MeshLambertMaterial({ map: upperTex }), roof, roof]); upper.position.set(0, 14.2, z0);
  const brim2 = new THREE.Mesh(new THREE.CylinderGeometry(8.1, 8.1, 0.4, 24), silver); brim2.position.set(0, 16, z0);
  const dome = new THREE.Mesh(new THREE.SphereGeometry(6.6, 22, 10, 0, Math.PI * 2, 0, Math.PI / 2), mat(0x44566e)); dome.scale.y = 0.55; dome.position.set(0, 16.2, z0);
  g.add(drum, brim, ring, upper, brim2, dome);
  for (const a of [-0.75, 0.15, 0.95]) for (let i = 0; i < 6; i++) { // цепочки синих «пузырей» по фасаду
    const ang = a + Math.sin(i * 1.3) * 0.07, r = 0.24 + (i % 3) * 0.1;
    const dot = new THREE.Mesh(new THREE.SphereGeometry(r, 10, 8), mat(0x1f4fd6));
    dot.scale.set(0.35, 1, 1); dot.position.set(toRoad * R * Math.cos(ang), 3 + i * 1.25, z0 + R * Math.sin(ang)); dot.rotation.y = -toRoad * ang;
    g.add(dot);
  }
  // левое крыло с синим остеклением и входом
  const glassTex = cached('domeGlass', () => bakedTexture(256, 256, (c, w, h) => {
    c.fillStyle = '#c9ced3'; c.fillRect(0, 0, w, h);
    c.fillStyle = '#1f4aa8'; c.fillRect(24, 20, 208, 90); c.fillRect(24, 130, 208, 126);
    c.fillStyle = 'rgba(255,255,255,.5)'; for (let x = 24; x < 232; x += 26) c.fillRect(x, 20, 2, 236); for (const y of [64, 130, 190]) c.fillRect(24, y, 208, 2);
    c.fillStyle = '#d5d9dd'; c.fillRect(70, 150, 116, 26); drawText(c, 'ФИТНЕС · СПА', 128, 164, 17, '#3d4a57', 108);
  }));
  const wing = facadeBox(15, 10.5, 11, new THREE.MeshLambertMaterial({ map: glassTex }), 0xc9ced3, 0x8d949b); wing.position.set(-toRoad * 1, 1.2, z0 - 15.5); g.add(wing);
  g.add(box(4, 0.3, 5, 0x596270, toRoad * 6.6, 4.4, z0 - 15.5));                     // козырёк входа
  // цоколь с лестницей
  g.add(box(22, 1.2, 36, 0x6e757d, 0, 0.6, -3), box(3, 0.4, 8, 0x8d949b, toRoad * 11.6, 0.6, z0 - 15.5), box(3, 0.4, 8, 0x8d949b, toRoad * 12.6, 0.2, z0 - 15.5));
  for (let z = -18; z <= 12; z += 3) g.add(box(0.06, 0.9, 0.06, 0x9aa1a8, toRoad * 11, 1.65, z));
  g.add(box(0.06, 0.06, 31, 0x9aa1a8, toRoad * 11, 2.1, -3));
  return g;
}

function redTopCenter(side) { // торговый центр с красным верхом на колоннах
  const tex = cached('redtop', () => bakedTexture(1024, 256, (c, w, h) => {
    c.fillStyle = '#2a2f36'; c.fillRect(0, 0, w, h);
    c.fillStyle = '#d8414d'; c.fillRect(0, 0, w, 104);
    c.strokeStyle = 'rgba(90,10,20,.3)'; for (let x = 0; x < w; x += 40) c.strokeRect(x + 0.5, 0.5, 40, 52), c.strokeRect(x + 0.5, 52.5, 40, 52);
    drawText(c, 'МЕДИЦИНСКИЙ ЦЕНТР', 610, 40, 32, '#fff', 380); drawText(c, 'АПТЕКА', 900, 76, 30, '#2ecc71', 200);
    c.fillStyle = '#3d4b5a'; c.fillRect(0, 108, w, 56); c.fillStyle = 'rgba(255,255,255,.5)'; for (let x = 0; x < w; x += 26) c.fillRect(x, 108, 2, 56);
    c.fillStyle = '#e8e4da'; for (let x = 40; x < w; x += 170) c.fillRect(x, 104, 14, 152); // колонны
    const names = [['БУРГЕРНАЯ', '#e67e22'], ['ПОЧТА', '#1d5fbf'], ['ЦВЕТЫ', '#2a9d8f'], ['ФИЗКУЛЬТУРА', '#8e44ad'], ['МЯСО · РЫБА', '#c0392b'], ['РЕМОНТ', '#495057']];
    names.forEach(([n, col], i) => { c.fillStyle = col; c.fillRect(60 + i * 160, 176, 130, 24); drawText(c, n, 125 + i * 160, 189, 18, '#fff', 120); });
  }));
  const g = new THREE.Group(), out = -side;
  const m = facadeBox(CHUNK_LEN, 9.5, 11, lambertMap('redtop', tex), 0xd8414d, 0x6c6468);
  dress(m, side, { len: CHUNK_LEN, h: 9.5, depth: 11, parapet: 0xb5343f, ac: 4 });
  // выступающая плита второго этажа на колоннах и широкая лестница
  m.add(box(2.6, 0.35, CHUNK_LEN, 0xe8e4da, out * 6.8, -4.75 + 5.55, 0));
  for (let z = -18; z <= 18; z += 6) m.add(box(0.5, 5.4, 0.5, 0xe8e4da, out * 7.7, -4.75 + 2.7, z));
  for (let k = 0; k < 3; k++) m.add(box(1.0, 0.2, 12, 0x9a9a94, out * (6.2 + k * 1.0), -4.75 + 0.5 - k * 0.2, -4));
  g.add(m);
  return g;
}
function ochreMall(side) { // охристый торговый центр ломаных форм с кирпичной башней-вывеской
  const tex = cached('ochre', () => bakedTexture(1024, 320, (c, w, h) => {
    c.fillStyle = '#c8964a'; c.fillRect(0, 0, w, h);
    c.strokeStyle = 'rgba(90,60,10,.22)'; for (let y = 0; y < 230; y += 9) { c.beginPath(); c.moveTo(0, y + 0.5); c.lineTo(w, y + 0.5); c.stroke(); }
    c.fillStyle = 'rgba(0,0,0,.12)'; c.beginPath(); c.moveTo(380, 0); c.lineTo(470, 230); c.lineTo(380, 230); c.fill();
    drawText(c, 'ДЕТСКИЕ ТОВАРЫ', 250, 60, 40, '#fff', 380);
    for (const [i, col] of ['#e74c3c', '#f1c40f', '#2ecc71', '#3498db'].entries()) { c.fillStyle = col; c.fillRect(470 + i * 34, 44, 28, 28); }
    drawText(c, 'СУПЕРМАРКЕТ', 800, 30, 30, '#2e7d32', 300);
    c.fillStyle = '#2f3b47'; c.fillRect(0, 232, w, 88); c.fillStyle = 'rgba(255,255,255,.4)'; for (let x = 0; x < w; x += 44) c.fillRect(x, 232, 2, 88);
  }));
  const g = new THREE.Group(), m = lambertMap('ochre', tex);
  g.add(dress(facadeBox(30, 11, 13, m, 0xc8964a), side, { len: 30, h: 11, depth: 13, parapet: 0xa87c38, steps: [2], canopy: { d: 2.6, w: 8, y: 3.4, z: 2, color: 0x7a5a2c }, ac: 3 }));
  const up = box(9, 3.5, 16, 0xc8964a, side * 1.5, 12.7, -4); g.add(up);
  g.add(box(8, 14, 7, 0x8a3b2e, -side * 2.4, 7, 17.5));                              // кирпичная башня
  const list = cached('ochreList', () => canvasTexture(256, 512, (c, w, h) => {
    c.fillStyle = '#8a3b2e'; c.fillRect(0, 0, w, h);
    ['ЭЛЕКТРОНИКА', 'МАТРАСЫ', 'КОСТЮМЫ', 'ЮВЕЛИРНЫЙ', 'СУПЕРМАРКЕТ', 'КУХНИ', 'ПАРФЮМЕРИЯ', 'ПУТЕШЕСТВИЯ', 'КРЕСЛА'].forEach((n, i) => drawText(c, n, w / 2, 40 + i * 52, i === 0 ? 34 : 28, i === 1 ? '#ff8a65' : '#fff', w - 30));
  }));
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(5.6, 11), new THREE.MeshBasicMaterial({ map: list }));
  sign.position.set(-side * 6.45, 8, 17.5); sign.rotation.y = -side * Math.PI / 2; g.add(sign);
  for (const z of [-10, 0, 10]) g.add(box(0.12, 4.5, 0.12, 0x3d4046, -side * 8.5, 2.25, z), box(0.5, 2.2, 0.08, 0xd62828, -side * 8.5, 3.6, z + 0.2)); // красные флаги
  return g;
}
function whiteRedCenter(side) { // белый торговый центр с красными полосами и стеклянным входом
  const tex = cached('whitered', () => bakedTexture(1024, 320, (c, w, h) => {
    c.fillStyle = '#f0f0ee'; c.fillRect(0, 0, w, h);
    for (const y of [70, 130]) { c.fillStyle = '#d7262f'; c.fillRect(0, y, w, 36); c.fillStyle = '#2c3540'; c.fillRect(0, y + 36, w, 20); }
    c.fillStyle = '#f0f0ee'; for (let x = 60; x < w; x += 150) c.fillRect(x, 40, 18, 190);
    c.fillStyle = '#3b4a5c'; c.fillRect(430, 40, 150, 190); c.fillStyle = 'rgba(255,255,255,.5)'; for (let x = 430; x < 580; x += 25) c.fillRect(x, 40, 2, 190);
    drawText(c, 'НОТАРИУС', 620, 24, 30, '#1d3557', 240); drawText(c, 'ЗООМАГАЗИН', 800, 196, 24, '#fff', 220); drawText(c, 'ВИДЕО', 180, 148, 26, '#fff', 160);
    c.fillStyle = '#c9ccd0'; c.fillRect(0, 232, w, 22); c.fillStyle = '#34414f'; c.fillRect(0, 254, w, 66);
    ['ЛОМБАРД', 'ПИВО', 'СВЯЗЬ', 'ДОМ БЫТА', 'АПТЕКА', 'ОПТИКА', 'ЦВЕТЫ'].forEach((n, i) => drawText(c, n, 80 + i * 144, 243, 16, pick(['#c0392b', '#1d5fbf', '#2e7d32', '#333']), 120));
  }));
  const m = facadeBox(36, 11, 13, lambertMap('whitered', tex), 0xf0f0ee);
  return dress(m, side, { len: 36, h: 11, depth: 13, parapet: 0xd0d0cc, pilasters: 7, pilColor: 0xf4f4f2, pilDepth: 0.7, awning: { y: 3.1, d: 1.1, color: 0xc9ccd0 }, steps: [-1], ac: 4 });
}
function yellowShops(side) { // жёлтые магазинчики с тёмным козырьком и стеклянным фронтоном
  const tex = cached('yellowshops', () => bakedTexture(1024, 192, (c, w, h) => {
    c.fillStyle = '#d9c36a'; c.fillRect(0, 0, w, h);
    c.fillStyle = '#f3f0e6'; for (let x = 30; x < w; x += 90) c.fillRect(x, 16, 40, 44);
    c.fillStyle = '#3a4654'; for (let x = 34; x < w; x += 90) c.fillRect(x, 20, 32, 36);
    c.fillStyle = '#2b2a28'; c.fillRect(0, 74, w, 34);
    ['АПТЕКА', 'ЦВЕТЫ', 'ПЕКАРНЯ', 'ОПТИКА', 'АККУМУЛЯТОРЫ'].forEach((n, i) => drawText(c, n, 110 + i * 200, 92, 24, i === 0 ? '#2ecc71' : '#fff', 180));
    c.fillStyle = '#34414f'; c.fillRect(0, 110, w, 62); c.fillStyle = 'rgba(255,255,255,.4)'; for (let x = 0; x < w; x += 40) c.fillRect(x, 110, 2, 62);
    c.fillStyle = '#b89a6a'; c.fillRect(0, 172, w, 20);
  }));
  const g = new THREE.Group();
  const body = facadeBox(30, 6.4, 10, lambertMap('yellowshops', tex), 0xd9c36a, 0x5a4636);
  dress(body, side, { len: 30, h: 6.4, depth: 10, awning: { y: 3.5, d: 1.3, color: 0x2b2a28 }, parapet: 0x5a4636, plinth: 0xb89a6a, steps: [-10, 0, 10], ac: 2 });
  for (const z of [-12, -4, 4, 12]) body.add(box(0.1, 3, 0.1, 0x2b2d33, -side * 7.4, -3.2 + 1.5, z), box(0.34, 0.4, 0.34, 0xfff3b0, -side * 7.4, -3.2 + 3.1, z)); // фонарики вдоль входа
  g.add(body);
  g.add(box(6, 4.2, 6, 0xd9c36a, -side * 2.4, 8.4, 0), box(0.1, 3.4, 3.6, 0x3a4654, -side * 5.42, 8.4, 0), box(6.6, 0.3, 6.6, 0x5a4636, -side * 2.4, 10.6, 0)); // фронтон с высоким окном
  return g;
}
function creamRow(side) { // кремовый двухэтажный торговый ряд с кирпичными вставками
  const tex = cached('cream', () => bakedTexture(1024, 224, (c, w, h) => {
    c.fillStyle = '#eadfc4'; c.fillRect(0, 0, w, h);
    c.fillStyle = '#c0683e'; for (let x = 0; x < w; x += 128) c.fillRect(x, 0, 18, h);
    c.fillStyle = '#3a4654'; for (let x = 34; x < w; x += 128) { c.fillRect(x, 50, 84, 50); c.fillRect(x, 136, 84, 88); }
    c.fillStyle = '#d6c7a6'; c.fillRect(0, 108, w, 22);
    ['СУШИ · ПИЦЦА', 'АВТОЗАПЧАСТИ', 'ИГРУШКИ', 'ОДЕЖДА', 'ПЕКАРНЯ', 'БАНКОМАТ', 'ПРОДУКТЫ', 'ТАБАК'].forEach((n, i) => drawText(c, n, 76 + i * 128, 120, 15, pick(['#c0392b', '#1d5fbf', '#2e7d32', '#5d4037']), 100));
    drawText(c, 'ТОРГОВЫЕ РЯДЫ', w / 2, 24, 34, '#8d6e63', 500);
  }));
  const m = facadeBox(38, 8, 10, lambertMap('cream', tex), 0xeadfc4);
  return dress(m, side, { len: 38, h: 8, depth: 10, parapet: 0xb9a37c, pilasters: 9, pilColor: 0xc0683e, pilDepth: 0.35, awning: { y: 4.1, d: 0.7, color: 0xd6c7a6 }, steps: [-14, -4.7, 4.7, 14], ac: 3 });
}
function businessCenter(side) { // бизнес-центр: охристая облицовка, стеклянный эркер, стойка с вывесками
  const g = new THREE.Group();
  const tex = cached('bc', () => bakedTexture(256, 384, (c, w, h) => {
    c.fillStyle = '#c9a15a'; c.fillRect(0, 0, w, h);
    c.strokeStyle = 'rgba(80,50,10,.2)'; for (let y = 0; y < h; y += 24) for (let x = 0; x < w; x += 32) c.strokeRect(x + 0.5, y + 0.5, 32, 24);
    c.fillStyle = '#3a4654'; for (let f = 0; f < 5; f++) for (const x of [16, 200]) c.fillRect(x, 30 + f * 56, 36, 34);
  }));
  g.add(facadeBox(16, 21, 14, lambertMap('bc', tex), 0xc9a15a));
  const glass = box(2.4, 13, 8, 0x6f8fa6, -side * 7.6, 12, -1); g.add(glass);
  for (let y = 7; y < 18; y += 2.2) g.add(box(2.5, 0.12, 8.1, 0xdfe6ea, -side * 7.6, y, -1));
  const pylonTex = cached('bcPylon', () => canvasTexture(128, 384, (c, w, h) => {
    c.fillStyle = '#c9b58a'; c.fillRect(0, 0, w, h);
    drawText(c, 'БИЗНЕС-', w / 2, 22, 22, '#5d4037', w - 10); drawText(c, 'ЦЕНТР', w / 2, 46, 22, '#5d4037', w - 10);
    [['СТОМАТОЛОГИЯ', '#eceff1', '#37474f'], ['СТРАХОВАНИЕ', '#1565c0', '#fff'], ['ОПТИКА', '#eceff1', '#1565c0'], ['ТУРЫ', '#0288d1', '#fff'], ['ДОКТОР', '#f8bbd0', '#ad1457'], ['АВТОСТОЯНКА', '#1565c0', '#fff'], ['АРЕНДА', '#fdd835', '#333']]
      .forEach(([n, bg, fg], i) => { c.fillStyle = bg; c.fillRect(8, 70 + i * 44, w - 16, 38); drawText(c, n, w / 2, 90 + i * 44, 17, fg, w - 24); });
  }));
  const pylon = new THREE.Group(); // стойка с вывесками, развёрнута к едущему
  const face = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 8), new THREE.MeshBasicMaterial({ map: pylonTex })); face.position.set(0, 4.3, 0.17);
  pylon.add(face, box(2.7, 8.4, 0.3, 0xb39b6b, 0, 4.2, 0));
  pylon.position.set(-side * 9.6, 0, 8.6); pylon.rotation.y = -side * 0.9;
  g.add(pylon);
  const books = new THREE.Mesh(new THREE.PlaneGeometry(5, 0.9), new THREE.MeshBasicMaterial({ map: signTex('КНИГИ', '#263238', '#fff') })); books.position.set(-side * 8.85, 4.6, -1); books.rotation.y = -side * Math.PI / 2; g.add(books);
  return g;
}
function archCanopy() { // арочный навес над спуском в подземную парковку
  const g = new THREE.Group();
  const arch = new THREE.Mesh(new THREE.CylinderGeometry(3.2, 3.2, 9, 14, 1, true, 0, Math.PI), new THREE.MeshLambertMaterial({ color: 0x9aa89f, side: THREE.DoubleSide }));
  arch.rotation.z = Math.PI / 2; arch.rotation.y = Math.PI / 2; g.add(arch);
  for (let z = -4; z <= 4; z += 2) { const rib = new THREE.Mesh(new THREE.TorusGeometry(3.22, 0.07, 5, 14, Math.PI), mat(0x4a5560)); rib.position.z = z; g.add(rib); }
  return g;
}
// входы в подземный переход — самая узнаваемая уличная деталь
function underpass(kind) {
  const g = new THREE.Group(), red = mat(0xd84a3f), blue = mat(0x2f5fc4);
  g.add(box(2.4, 1.3, 6.4, 0xe9e9e4, 0, 0.65, 0), box(1.7, 0.1, 5.2, 0x1f2328, 0, 1.31, 0.3));  // парапет и тёмный проём лестницы
  for (const x of [-1.15, 1.15]) for (const z of [-3, 0, 3]) g.add(box(0.1, 3.2, 0.1, 0x2f5fc4, x, 1.6, z));
  if (kind === 'wave') { // красная «волна» с синими кругами
    const sh = new THREE.Shape(), top = (z) => 3.0 + 0.55 * Math.sin(z * 0.85), N = 24;
    for (let i = 0; i <= N; i++) { const z = -3.9 + (7.8 * i) / N; i ? sh.lineTo(z, top(z)) : sh.moveTo(z, top(z)); }
    for (let i = N; i >= 0; i--) { const z = -3.9 + (7.8 * i) / N; sh.lineTo(z, top(z) - 0.85 - 0.25 * Math.cos(z * 0.6)); }
    const geo = new THREE.ExtrudeGeometry(sh, { depth: 0.1, bevelEnabled: false });
    for (const x of [-1.25, 1.25]) {
      const band = new THREE.Mesh(geo, red); band.rotation.y = -Math.PI / 2; band.position.x = x + 0.05; g.add(band);
      for (const z of [-2.8, -1.2, 0.6, 2.4]) { const dot = new THREE.Mesh(new THREE.CircleGeometry(0.22 + Math.abs(z) * 0.05, 14), blue); dot.position.set(x + Math.sign(x) * 0.07, top(z) - 0.5, z); dot.rotation.y = Math.sign(x) * Math.PI / 2; g.add(dot); }
    }
    const glass = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 3.4), new THREE.MeshLambertMaterial({ color: 0x4a90d9, transparent: true, opacity: 0.55, side: THREE.DoubleSide }));
    glass.rotation.x = -Math.PI / 2 + 0.25; glass.position.set(0, 3.3, -1.6); g.add(glass);
  } else {               // красно-синие перекрестья
    for (const x of [-1.25, 1.25]) for (const a of [0.33, -0.33]) {
      const beam = box(0.1, 0.55, 8.2, red, x, 2.5, 0); beam.rotation.x = a; g.add(beam);
      const edge = box(0.12, 0.08, 8.2, blue, x, 2.5, 0); edge.rotation.x = a; edge.position.y += 0.3; g.add(edge);
    }
    g.add(box(2.7, 0.08, 3.2, 0xd84a3f, 0, 3.6, 0));
  }
  return g;
}
// храм с колокольней и часовня с шатровой крышей
function onion(r, color) { // луковичная главка с крестом
  const g = new THREE.Group(), m = mat(color), gold = mat(0xd4a017);
  const bulb = new THREE.Mesh(new THREE.SphereGeometry(r, 12, 10), m); bulb.scale.y = 1.15; bulb.position.y = r * 1.1;
  const tip = new THREE.Mesh(new THREE.ConeGeometry(r * 0.5, r * 1.1, 10), m); tip.position.y = r * 2.5;
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.45, r * 0.5, r * 0.6, 10), mat(0xf3efe2)); neck.position.y = r * 0.2;
  g.add(bulb, tip, neck, box(0.07, r * 1.6, 0.07, gold, 0, r * 3.7, 0), box(r * 0.8, 0.07, 0.07, gold, 0, r * 3.9, 0));
  return g;
}
function church(side) {
  const g = new THREE.Group(), Y = 0xe6c86a, W = 0xf3efe2, toRoad = -side;
  const win = (x, y, z, h = 1.6) => { g.add(box(0.12, h + 0.3, 1.0, W, x, y, z), box(0.16, h, 0.7, 0x3a4654, x + toRoad * 0.02, y, z)); };
  // основной объём с куполом
  g.add(box(10, 6.5, 12, Y, 0, 3.25, 0), box(10.4, 0.4, 12.4, W, 0, 6.6, 0), box(10.3, 0.5, 12.3, W, 0, 0.25, 0));
  for (const z of [-3.6, 0, 3.6]) win(toRoad * 5.02, 3.4, z);
  const drum = new THREE.Mesh(new THREE.CylinderGeometry(3.1, 3.1, 2.6, 14), mat(Y)); drum.position.y = 8.1; g.add(drum);
  const dome = new THREE.Mesh(new THREE.SphereGeometry(3.4, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), mat(0x2f3440)); dome.scale.y = 0.8; dome.position.y = 9.4; g.add(dome);
  const top = onion(0.75, 0xd4a017); top.position.y = 12.2; g.add(top);
  // портик с колоннами со стороны дороги
  g.add(box(2.2, 4.6, 6, Y, toRoad * 6.1, 2.3, 0), box(2.6, 0.5, 6.4, W, toRoad * 6.1, 4.85, 0));
  for (const z of [-2.4, -0.8, 0.8, 2.4]) { const col = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 4.2, 8), mat(W)); col.position.set(toRoad * 7.4, 2.1, z); g.add(col); }
  g.add(box(1.4, 0.4, 6.4, W, toRoad * 7.3, 4.5, 0));
  // колокольня в три яруса
  const bz = -10;
  g.add(box(4.4, 6.5, 4.4, Y, 0, 3.25, bz), box(4.8, 0.35, 4.8, W, 0, 6.6, bz), box(3.6, 5, 3.6, Y, 0, 9.2, bz), box(4.0, 0.35, 4.0, W, 0, 11.8, bz), box(2.8, 3.2, 2.8, Y, 0, 13.5, bz), box(3.2, 0.3, 3.2, W, 0, 15.2, bz));
  win(toRoad * 2.22, 3.2, bz); win(toRoad * 1.82, 9.4, bz, 2.4); win(toRoad * 1.42, 13.6, bz, 1.6);
  const spire = onion(0.95, 0xd4a017); spire.position.set(0, 15.4, bz); g.add(spire);
  // ограда
  for (let z = -16; z <= 8; z += 3) g.add(box(0.5, 1.5, 0.5, 0x9c5a3c, toRoad * 10, 0.75, z));
  g.add(box(0.08, 0.08, 24, 0x2b2d33, toRoad * 10, 1.1, -4), box(0.08, 0.08, 24, 0x2b2d33, toRoad * 10, 0.5, -4));
  return g;
}
function chapel() {
  const g = new THREE.Group(), Y = 0xe6c86a, W = 0xf3efe2;
  g.add(box(4.2, 3.4, 4.2, Y, 0, 1.9, 0), box(4.5, 0.5, 4.5, W, 0, 0.25, 0), box(4.6, 0.35, 4.6, W, 0, 3.75, 0));
  for (const [x, z] of [[2.12, 0], [-2.12, 0], [0, 2.12], [0, -2.12]]) { const w = box(x ? 0.1 : 1.1, 1.7, x ? 1.1 : 0.1, 0x3a4654, x, 2, z); g.add(w); }
  const roof = new THREE.Mesh(new THREE.ConeGeometry(3.4, 4.4, 4), mat(0x6b4a3a)); roof.rotation.y = Math.PI / 4; roof.position.y = 6.1; g.add(roof);
  const top = onion(0.42, 0x3a3f4a); top.position.y = 8.2; g.add(top);
  return g;
}

// ---------- Дорожное полотно блока: бордюры, тротуары, разметка, перекрёстки ----------
const WHITE = 0xe8e8e8;
const sidewalkMats = new Map();
let walkTile = false, tileLeft = 0; // выложен ли тротуар плиткой в текущем блоке
const walkAsphaltTex = canvasTexture(128, 256, (c, w, h) => { // асфальт тротуара: светлее дорожного, с крапом и заплатами
  c.fillStyle = '#74767b'; c.fillRect(0, 0, w, h);
  for (let i = 0; i < 900; i++) { c.fillStyle = Math.random() < 0.5 ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.07)'; c.fillRect(Math.random() * w, Math.random() * h, 2, 2); }
  for (let i = 0; i < 3; i++) { c.fillStyle = 'rgba(40,42,48,0.16)'; c.fillRect(Math.random() * w, Math.random() * h, 20 + Math.random() * 40, 14 + Math.random() * 30); }
  c.strokeStyle = 'rgba(20,20,25,0.25)'; c.beginPath(); c.moveTo(20, 30); c.lineTo(48, 70); c.lineTo(40, 120); c.stroke();
});
function sidewalkMat(len) {
  const key = (walkTile ? 't' : 'a') + Math.round(len);
  if (!sidewalkMats.has(key)) { const t = (walkTile ? sidewalkTex : walkAsphaltTex).clone(); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(1, len / 8); t.needsUpdate = true; sidewalkMats.set(key, new THREE.MeshLambertMaterial({ map: t })); }
  return sidewalkMats.get(key);
}
const grassChunkMat = (() => { const t = grassTex.clone(); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(20, 2); t.needsUpdate = true; return new THREE.MeshLambertMaterial({ map: t }); })();
// длинные детали дороги дробятся на отрезки по 10 м — иначе они не изгибаются на поворотах и уклонах
function segBox(w, h, d, color, x, y, z) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d, 1, 1, Math.max(1, Math.round(d / 10))), typeof color === 'number' ? mat(color) : color);
  m.position.set(x, y, z);
  return m;
}
function segPlane(w, len, material, x, y, z) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, len, 1, Math.max(1, Math.round(len / 10))), material);
  m.rotation.x = -Math.PI / 2; m.position.set(x, y, z); m.receiveShadow = true;
  return m;
}
const STRIP = 6.9, WALK = 9.8, SHIFT = 2.6; // оси газона и тротуара; на SHIFT вся застройка отодвинута от дороги
function streetTree() { // невысокое дерево в полосе между дорогой и тротуаром
  const model = modelTree(Math.random() < 0.2 ? 'pine' : 'leaf', rand(3.6, 5.2));
  if (model) return model;
  const g = new THREE.Group(), k = rand(0.55, 0.85), fir = Math.random() < 0.2;
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.15, 3.2, 6), mat(fir ? 0x5c4033 : 0x6b5a4a)); trunk.position.y = 1.6;
  const crown = fir ? new THREE.Mesh(new THREE.ConeGeometry(1.5, 5, 8), mat(0x2d6a4f)) : new THREE.Mesh(new THREE.SphereGeometry(1.7, 8, 6), mat(pick([0x6a994e, 0x7fb069, 0x8ab661, 0x5f8f4a])));
  crown.position.y = fir ? 3.6 : 4.1; if (!fir) crown.scale.y = 1.15;
  g.add(trunk, crown); g.scale.setScalar(k);
  return g;
}
function curbSegment(g, s, z0, z1) { // бордюр, тротуар и сплошная у края на отрезке блока
  const len = z1 - z0, zc = (z0 + z1) / 2;
  // от дороги: бордюр, полоса газона с деревьями (STRIP), за ней тротуар (WALK)
  const top = segPlane(3.2, len, sidewalkMat(len), s * WALK, 0.072, zc), strip = segPlane(2.6, len, grassChunkMat, s * STRIP, 0.074, zc);
  for (const m of [segBox(0.3, 0.25, len, 0xb9b9b4, s * 5.45, 0.05, zc), segBox(5.8, 0.14, len, 0x8f9094, s * 8.5, 0, zc), top, strip, segBox(0.15, 0.02, len, WHITE, s * 5.0, 0.02, zc)]) { m.receiveShadow = true; g.add(m); }
}
function dashLine(g, x, z0, z1) { for (const z of [-16, -8, 0, 8, 16]) if (z - 1.5 >= z0 && z + 1.5 <= z1) g.add(box(0.16, 0.02, 3, WHITE, x, 0.02, z)); }
function doubleSolid(g, x, z0, z1) { for (const dx of [-0.14, 0.14]) g.add(segBox(0.12, 0.02, z1 - z0, WHITE, x + dx, 0.02, (z0 + z1) / 2)); }
const arrowTexes = {};
function laneArrow(kind) { // стрелка на асфальте
  arrowTexes[kind] ||= canvasTexture(64, 256, (c) => {
    c.fillStyle = '#eeeeee';
    if (kind === 'straight') { c.fillRect(26, 70, 12, 180); c.beginPath(); c.moveTo(32, 6); c.lineTo(58, 80); c.lineTo(6, 80); c.fill(); }
    else { c.fillRect(38, 96, 12, 154); c.fillRect(20, 96, 30, 12); c.beginPath(); c.moveTo(2, 102); c.lineTo(26, 74); c.lineTo(26, 130); c.fill(); }
  });
  const m = new THREE.Mesh(new THREE.PlaneGeometry(1.3, 5.2), new THREE.MeshBasicMaterial({ map: arrowTexes[kind], transparent: true, depthWrite: false }));
  m.rotation.x = -Math.PI / 2; m.position.y = 0.03; m.renderOrder = 1;
  return m;
}
function sideStreet(g, s = -1) { // боковая улица со стороны s (-1 слева, 1 справа)
  const asphalt = new THREE.Mesh(new THREE.PlaneGeometry(56, J_HALF * 2 - 1.4), mat(0x41444a)); asphalt.rotation.x = -Math.PI / 2; asphalt.position.set(s * 33.3, 0.011, 0); asphalt.receiveShadow = true;
  g.add(asphalt);
  for (const sz of [-1, 1]) g.add(box(55.4, 0.25, 0.3, 0xb9b9b4, s * 33.3, 0.05, sz * (J_HALF - 0.55)), box(52, 0.14, 2.6, 0x8f9094, s * 35, 0, sz * (J_HALF + 0.9)));
  for (let x = 14; x < 58; x += 6) g.add(box(2.6, 0.02, 0.14, WHITE, s * x, 0.02, 0));
  for (let z = -4.8; z <= 4.8; z += 1.6) g.add(box(2.8, 0.02, 0.6, WHITE, s * 7.4, 0.022, z));   // зебра через боковую улицу
  g.add(box(0.4, 0.02, J_HALF - 1.2, WHITE, s * 9.6, 0.022, s * (J_HALF - 1.2) / 2 * -1));      // стоп-линия
  for (const sz of [-1, 1]) { const tl = trafficLight(); tl.position.set(s * 6.0, 0, sz * (J_HALF + 0.6)); g.add(tl); }
}
const surfaceMats = {};
function roadSurface(kind) { // участок с другим покрытием поверх основного асфальта
  surfaceMats[kind] ||= new THREE.MeshLambertMaterial({ map: (() => {
    const t = canvasTexture(256, 512, (c, w, h) => {
      if (kind === 'fresh') { // свежий асфальт: тёмный и ровный
        c.fillStyle = '#2f3136'; c.fillRect(0, 0, w, h);
        for (let i = 0; i < 3500; i++) { c.fillStyle = Math.random() < 0.5 ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.06)'; c.fillRect(Math.random() * w, Math.random() * h, 2, 2); }
      } else if (kind === 'concrete') { // бетонные плиты со швами
        c.fillStyle = '#6c6e6b'; c.fillRect(0, 0, w, h);
        for (let i = 0; i < 60; i++) { c.fillStyle = Math.random() < 0.5 ? 'rgba(0,0,0,0.05)' : 'rgba(255,255,255,0.05)'; c.fillRect(Math.random() * w, Math.random() * h, 30 + Math.random() * 60, 30 + Math.random() * 60); }
        c.strokeStyle = 'rgba(40,40,40,0.55)'; c.lineWidth = 2;
        for (let y = 0; y <= h; y += 128) { c.beginPath(); c.moveTo(0, y + 1); c.lineTo(w, y + 1); c.stroke(); }
        for (const x of [w * 0.34, w * 0.66]) { c.beginPath(); c.moveTo(x, 0); c.lineTo(x, h); c.stroke(); }
      } else { // брусчатка
        c.fillStyle = '#6f675f'; c.fillRect(0, 0, w, h);
        for (let y = 0; y < h; y += 8) for (let x = -8; x < w; x += 16) { const v = 96 + Math.floor(Math.random() * 40); c.fillStyle = `rgb(${v + 8},${v},${v - 8})`; c.fillRect(x + ((y / 8) % 2 ? 8 : 0), y, 15, 7); }
      }
    });
    t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(1, 2);
    return t;
  })() });
  return segPlane(10.6, CHUNK_LEN, surfaceMats[kind], 0, 0.0135, 0);
}
function roadKit(g, mode, o = {}) {
  const junction = mode === 'jIn' || mode === 'jOut';
  const gapL = junction || o.gapL, gapR = o.gapR;
  g.add(segPlane(10.6, CHUNK_LEN, asphaltMat, 0, 0.012, 0), segPlane(400, CHUNK_LEN, grassChunkMat, 0, -0.05, 0)); // асфальт и газон блока
  for (const [s, gap] of [[-1, gapL], [1, gapR]]) { // бордюр и тротуар; на перекрёстке — с разрывом под боковую улицу
    if (gap) { curbSegment(g, s, -20, -J_HALF); curbSegment(g, s, J_HALF, 20); sideStreet(g, s); }
    else curbSegment(g, s, -20, 20);
  }
  if (o.surface) g.add(roadSurface(o.surface));
  if (Math.random() < 0.35) { // люк
    const lid = new THREE.Mesh(new THREE.CircleGeometry(0.42, 14), mat(0x2a2c30)); lid.rotation.x = -Math.PI / 2; lid.position.set(pick(LANES) + rand(-0.8, 0.8), 0.016, rand(-18, 18)); g.add(lid);
  }
  const spans = gapL || gapR ? [[J_HALF, 20], [-20, -J_HALF]] : [[-20, 20]]; // на перекрёстке разметка прерывается
  const oneway = (a, b) => { dashLine(g, -1.6, a, b); dashLine(g, 1.6, a, b); };
  const twoway = (a, b) => { doubleSolid(g, -1.6, a, b); dashLine(g, 1.6, a, b); }; // двойная сплошная отделяет встречную полосу
  const sign = (kind, z) => { const sg = roadSign(kind); sg.position.set(6.3, 0, z); g.add(sg); };
  if (mode === 'oneway') for (const [a, b] of spans) oneway(a, b);
  else if (mode === 'twoway') for (const [a, b] of spans) twoway(a, b);
  else if (mode === 'jIn') { // ближняя половина ещё односторонняя, за перекрёстком — встречная слева
    oneway(J_HALF, 20); twoway(-20, -J_HALF);
    const left = laneArrow('left'); left.position.set(LANES[0], 0.03, 13); g.add(left);
    for (const l of [1, 2]) { const a = laneArrow('straight'); a.position.set(LANES[l], 0.03, 13); g.add(a); }
    sign('lanes', 19); sign('twoway', -8.5);
  } else {                   // встречная полоса заканчивается: дальше снова три полосы в одну сторону
    twoway(J_HALF, 20); oneway(-20, -J_HALF);
    sign('oneway', -8.5);
  }
}
const recentShops = []; // последние поставленные ларьки: рядом и напротив такие же не ставим
function freshShop(list) {
  const free = list.filter((k) => !recentShops.includes(k)), k = pick(free.length ? free : list);
  recentShops.push(k); if (recentShops.length > 4) recentShops.shift();
  return k;
}
function cornerSide(g, s) { // углы у боковой улицы: павильоны, деревья, фонари
  for (const z of [-14, 14]) { const pv = pavilion(freshShop(['coffee', 'grill', 'apteka', 'burger', 'kiosk']), s); pv.position.set(s * (13 + SHIFT), 0, z); g.add(pv); }
  for (let i = 0; i < 6; i++) { const t = tree('birch'); t.position.set(s * rand(20, 46), 0, (Math.random() < 0.5 ? -1 : 1) * rand(10, 19)); g.add(t); }
  for (const z of [-13, 13]) { const l = lamp(); l.position.set(s * 5.9, 0, z); g.add(l); }
}
function junctionSides(g) { buildSide(g, ['dome', 'letters', 'stela'].includes(biome) ? 'larki' : biome, 1); cornerSide(g, -1); } // перекрёсток со встречкой: боковая улица слева
function waitingCar(s) { // машина ждёт на боковой улице у стоп-линии
  const c = makeVehicle('car'); c.add(blob(3.4, 6, 0.5)); c.rotation.y = s * Math.PI / 2; c.position.set(s * 12.6, 0, s * 1.8);
  return c;
}
function overpass() { // путепровод поперёк дороги
  const g = new THREE.Group(), C = 0x9a9d9f;
  g.add(box(76, 1.0, 9, C, 0, 7.4, 0), box(76, 0.3, 9.4, 0x7d8084, 0, 6.85, 0));
  for (const sz of [-1, 1]) { g.add(box(76, 0.9, 0.2, 0x8b8f93, 0, 8.3, sz * 4.4)); for (let x = -36; x <= 36; x += 6) g.add(box(0.16, 5.5, 0.16, 0x6c757d, x, 10.6, sz * 4.4)); }
  for (const x of [-9.8, 9.8, -30, 30]) g.add(box(1.5, 6.9, 6.5, 0x8b8f93, x, 3.45, 0));
  for (const x of [-22, -6, 14, 28]) { const c = makeVehicle('car'); c.rotation.y = Math.PI / 2; c.position.set(x, 7.9, x % 4 ? 1.9 : -1.9); g.add(c); }
  g.add(blob(80, 13, 0.55));
  return g;
}
function chunkAt(z) { for (const c of chunks) if (Math.abs(c.position.z - z) <= CHUNK_LEN / 2) return c; return null; }
const modeAt = (z) => chunkAt(z)?.userData.mode ?? 'oneway';

const BIOME_WEIGHTS = { prospekt: 4, torg: 3, kirpich: 2, slab: 2, novostroiki: 2, larki: 2, dvor: 3, garazhi: 1 };
const BIOME_BAG = Object.entries(BIOME_WEIGHTS).flatMap(([b, w]) => Array(w).fill(b));
const LANDMARK_EVERY = 11; // раз во сколько блоков (по 40 м) встречается ориентир
function buildSide(g, biome, side, extra) {
  const X = (d) => side * d; // d — расстояние от оси дороги
  const addAt = (o, d, z) => { o.position.x += X(d); o.position.z += z; g.add(o); };
  const add = (o, d, z) => addAt(o, d >= 9 ? d + SHIFT : d, z); // всё, что дальше тротуара, отодвинуто: у дороги теперь полоса деревьев
  const addTower = (prefs, d, z) => { // жилой дом второй линией: не такой, как предыдущий на этой стороне и как тот, что напротив
    const ok = (st) => st !== lastTower[side] && st !== lastTower[-side];
    const list = [].concat(prefs).filter((k) => k !== 'green' || side < 0), st = pick(list.filter(ok).length ? list.filter(ok) : ['ii68', 'long', 'panel9', 'panel', 'brick'].filter(ok));
    lastTower[side] = st;
    const longish = st === 'slab' || st === 'long' || st === 'panel9', far = Math.max(d, 38), r = Math.random();
    if (st === 'ii68' && r < 0.45) {            // три башни уступом, торцами к дороге — как стоят кварталы вдоль Можайского шоссе
      const dir = Math.random() < 0.5 ? 1 : -1;
      [-13.5, 0, 13.5].forEach((tz, i) => { const t = tower('ii68'); t.rotation.y = Math.PI / 2; t.scale.set(0.8, 1, 0.8); addHouse(t, far + 9 + dir * (i - 1) * 7, tz); });
    } else if (st === 'long' && r < 0.35) {     // длинный дом торцом к дороге, рядом сквер
      const h = longHouse(side); h.rotation.y = Math.PI / 2; const hz = pick([-11, 11]);
      addHouse(h, far + 13, hz); park(far - 9, far + 14, -hz * 0.9, 9);
    } else if (st === 'long' && r < 0.65) {     // дом отодвинут вглубь, перед ним сквер с дорожками
      addHouse(longHouse(side), far + 17, 0); park(far - 12, far + 6, 0, 18);
    } else if ((st === 'long' || st === 'panel9' || st === 'slab') && r > 0.8) { // дом под углом к дороге
      const h = st === 'panel9' ? panel9(side) : st === 'long' ? longHouse(side) : tower(st);
      h.rotation.y = (Math.random() < 0.5 ? 1 : -1) * rand(0.45, 0.75);
      addHouse(h, far + 12, 0);
    } else if (st === 'long' && r > 0.65) {     // два крыла буквой V
      const open = Math.random() < 0.5 ? 1 : -1, ang = rand(0.5, 0.7);
      for (const w of [-1, 1]) { const wing = longHouse(side, [-6.5, 6.5], 0); wing.rotation.y = w * open * ang * side; addHouse(wing, far + 9, w * 10.5); }
    } else addHouse(st === 'panel9' ? panel9(side) : st === 'long' ? longHouse(side) : tower(st), far, longish ? 0 : z);
  };
  const park = (d0, d1, zc, halfZ) => { // сквер: дорожки крест-накрест, деревья, скамейки
    const mid = (d0 + d1) / 2, len = Math.hypot(d1 - d0, halfZ * 2);
    for (const sg of [-1, 1]) { const path = box(1.5, 0.04, len, 0xcfc6b4, 0, 0.0, 0); path.rotation.y = sg * Math.atan2(d1 - d0, halfZ * 2); path.receiveShadow = true; add(path, mid, zc); }
    add(box(d1 - d0, 0.04, 1.5, 0xcfc6b4, 0, 0.0, 0), mid, zc);
    for (let i = 0; i < 7; i++) add(tree(Math.random() < 0.8 ? 'birch' : 'fir'), rand(d0, d1), zc + rand(-halfZ, halfZ));
    add(bench(), mid + 1.6, zc + 2); if (Math.random() < 0.3) { const p = person(); p.position.y = 0.02; add(p, mid - 1, zc + rand(-3, 3)); }
  };
  // двор: внутриквартальный проезд за магазинами и дорожки от него к тротуару улицы
  const YARD = 30, yardMat = mat(0x6d6f74), slabMat = mat(0x9b9a96), pathMat = mat(0xaaa79f);
  addAt(segPlane(5, CHUNK_LEN, yardMat, 0, 0.004, 0), YARD, 0);
  for (const pz of [-19.4, 6.6]) { const pth = new THREE.Mesh(new THREE.PlaneGeometry(YARD - 2.5 - (WALK + 1.6), 2.2), pathMat); pth.rotation.x = -Math.PI / 2; pth.position.y = 0.008; pth.receiveShadow = true; addAt(pth, (YARD - 2.5 + WALK + 1.6) / 2, pz); }
  const addHouse = (o, d, z) => { // жилой дом: под ним и вокруг бетонная площадка, от неё проход к дворовому проезду
    add(o, d, z);
    const b = new THREE.Box3().setFromObject(o), cx = (b.min.x + b.max.x) / 2, cz = (b.min.z + b.max.z) / 2, sx = b.max.x - b.min.x, sz = b.max.z - b.min.z;
    g.add(segPlane(sx + 3, sz + 3, slabMat, cx, 0.012, cz));
    const front = Math.min(Math.abs(b.min.x), Math.abs(b.max.x)) - 1.5;
    if (front > YARD + 2.5) { const link = new THREE.Mesh(new THREE.PlaneGeometry(front - YARD - 2.4, 3), yardMat); link.rotation.x = -Math.PI / 2; link.position.set(side * (front + YARD + 2.4) / 2, 0.006, cz); link.receiveShadow = true; g.add(link); }
  };
  const stopsAt = [];
  const shopRow = (chance = 0.6) => { const skip = Math.random() < chance ? -1 : pick([0, 1, 2]); for (const [i, z] of [-13, 0, 13].entries()) if (i !== skip) /* минимум два ларька, обычно три */ add(pavilion(freshShop(['coffee', 'grill', 'zoo', 'burger', 'apteka', 'kiosk']), side), 12.5, z); }; // слой ларьков и магазинчиков
  add(lamp(), 5.9, -10);
  add(box(0.03, 0.03, CHUNK_LEN, 0x2b2d33, 0, 8.6, 0), 5.9, 0);                // провод между фонарями
  if (Math.random() < 0.3) add(roadSign(pick(['limit', 'cross', 'tow', 'tow'])), 6.1, rand(-16, 16));
  if (biome !== 'les' && Math.random() < 0.3) addAt(bench(), WALK + 1.2, rand(-15, 15));
  if (Math.random() < 0.3) { // прохожий идёт по тротуару: людей немного, один на три-четыре квартала с каждой стороны
    const p = person(); p.position.y = 0.07; p.userData.walk = (Math.random() < 0.5 ? 1 : -1) * rand(1.1, 1.5) * p.userData.pace; p.userData.phase = rand(0, 6);
    p.rotation.y = p.userData.walk > 0 ? 0 : Math.PI;
    addAt(p, WALK + rand(-1.1, 1.1), rand(-18, 18)); (g.userData.walkers ||= []).push(p);
  }
  const stop = (z) => { // остановка со знаком и ожидающими, рядом иногда киоск
    stopsAt.push(z);                                                           // остановка выходит прямо к дороге: площадка через газон
    const pad = segPlane(2.6, 8, sidewalkMat(8), 0, 0.078, 0); pad.receiveShadow = true; addAt(pad, STRIP, z);
    addAt(busStop(side), 7.3, z); addAt(roadSign('bus'), 6.1, z - 3.6);
    for (let i = 0; i < 1 + Math.floor(Math.random() * 2); i++) { const p = person(); p.position.y = 0.08; p.rotation.y = -side * Math.PI / 2 + rand(-0.5, 0.5); addAt(p, rand(6.2, 7.0), z + rand(-1.6, 1.6)); } // ждут лицом к дороге
  };
  const parking = (d, z0, n) => { for (let i = 0; i < n; i++) if (Math.random() < 0.8) { const c = makeVehicle('car'); c.add(blob(3.4, 6, 0.5)); c.rotation.y = Math.PI / 2; add(c, d, z0 + i * 3.6); } };
  const trees = (n, d0, d1, z0 = -19, z1 = 19) => { for (let i = 0; i < n; i++) add(tree(Math.random() < 0.75 ? 'birch' : 'fir'), rand(d0, d1), rand(z0, z1)); };
  if (biome === 'prospekt') {          // розовая пристройка или центр с красным верхом, за ними панельные башни
    if (side > 0) add(annex(side), 14.5, 0); else add(redTopCenter(side), 15.5, 0); // розовое здание всегда справа
    addTower(['ii68', 'long', 'panel'], 38, rand(-4, 4));
    if (Math.random() < 0.4) stop(8);
    if (Math.random() < 0.5) add(railing(), 5.75, 0);
  } else if (biome === 'stela') {      // стела «Одинцово» у дороги, рядом ларьки
    add(stela(), 11.5, 4);
    add(pavilion(freshShop(['coffee', 'grill', 'burger', 'apteka']), side), 12.5, -13);
    add(pavilion(freshShop(['kiosk', 'zoo', 'coffee', 'grill']), side), 12.5, 15);
    trees(3, 19, 26);
    addTower(['ii68', 'long', 'panel'], 38, 0);
  } else if (biome === 'dvor') {       // двор с панельной девятиэтажкой: деревья, машины у подъездов, иногда киоск
    shopRow(0.7);
    trees(5, 19, 26);
    addTower(['panel9', 'ii68', 'long'], 35, 0);
    if (Math.random() < 0.3) stop(-8);
  } else if (biome === 'kirpich') {    // кирпично-оранжевые башни, перед ними жёлтые магазинчики
    addTower(['brick', 'long'], 38, rand(-5, 5));
    if (Math.random() < 0.6) add(yellowShops(side), 15, 0);
    else { add(archCanopy(), 16, -8); add(pavilion('apteka', side), 12.5, 10); trees(3, 11, 20, -4, 4); }
    if (Math.random() < 0.3) stop(-12);
  } else if (biome === 'slab') {       // длинные 12-этажки с цветными фасадами за деревьями
    addTower(['slab', 'long'], 35, 0);
    shopRow(0.5);
    trees(6, 18, 26);
    if (Math.random() < 0.4) add(billboard(), 10.2, rand(-10, 10));
    if (Math.random() < 0.3) { stop(6); add(pavilion('kiosk', side), 12.5, 13); }
  } else if (biome === 'novostroiki') { // бело-зелёные новостройки, у дороги павильон и деревья
    addTower('green', 32, 0);
    add(pavilion(freshShop(['coffee', 'grill', 'burger', 'zoo', 'apteka']), side), 12.5, -13);
    if (extra !== 'stela') add(pavilion(freshShop(['kiosk', 'coffee', 'grill', 'burger', 'apteka']), side), 12.5, 12);
    trees(3, 19, 26, -18, 18);
    if (extra === 'stela') add(stela(), 11.5, 4);
    else if (Math.random() < 0.3) add(billboard(), 10.5, rand(4, 14));
  } else if (biome === 'torg') {       // торговые здания с парковкой
    const kind = pick(['mall', 'green', 'ochre', 'whitered', 'cream']);
    if (kind === 'mall') { add(mall(side), 23, 0); parking(11.5, -14, 8); }
    else if (kind === 'green') { add(greenShop(side), 21, 8); add(pavilion('zoo', side), 13, -13); parking(11.5, 2, 4); }
    else if (kind === 'ochre') { add(ochreMall(side), 24, -2); parking(11.5, -16, 7); }
    else if (kind === 'whitered') { add(whiteRedCenter(side), 23, 0); parking(11.5, -14, 8); }
    else { add(creamRow(side), 20, 0); parking(11.5, -16, 9); }
    addTower(['panel', 'brick', 'ii68', 'long', 'panel9'], 48, rand(-6, 6));
    if (Math.random() < 0.4) add(billboard(), 10.2, 17);
  } else if (biome === 'larki') {      // ряд павильонов и киосков, за ними башни
    for (const z of [-13, 0, 13]) add(pavilion(freshShop(['coffee', 'grill', 'zoo', 'burger', 'apteka', 'kiosk']), side), 12.5, z);
    addTower(['ii68', 'long', 'panel9', 'panel', 'brick'], 36, 0);
    if (Math.random() < 0.5) stop(0);
  } else if (biome === 'garazhi') {
    add(box(0.25, 2.2, CHUNK_LEN, 0xa5a59c, 0, 1.1, 0), 9.6, 0);            // бетонный забор
    for (let i = 0; i < 10; i++) add(garage(), 14, -18 + i * 4);
    for (let i = 0; i < 10; i++) add(box(0.08, 2.0, 2.6, pick([0x7f4f24, 0x386641, 0x415a77, 0x6c584c]), 0, 1.1, 0), 14 - 3.03, -18 + i * 4); // ворота
    add(box(1.2, 16, 1.2, 0x8d99ae, 0, 8, 0), 30, rand(-10, 10));            // труба котельной
    addTower(['panel', 'long', 'ii68'], 52, 0);
  } else if (biome === 'pond') {       // дамба через пруд: вода, каменный парапет, дальний берег
    const water = new THREE.Mesh(new THREE.PlaneGeometry(90, CHUNK_LEN), mat(0x3f7fb0)); water.rotation.x = -Math.PI / 2; water.position.y = 0.0;
    add(water, 55, 0);
    add(box(1.4, 0.5, CHUNK_LEN, 0x8b8f93, 0, 0.2, 0), 9.6, 0);
    add(railing(), 9.2, 0);
    for (let i = 0; i < 5; i++) add(tree(Math.random() < 0.6 ? 'birch' : 'fir'), rand(100, 118), rand(-19, 19));
    if (Math.random() < 0.5) addTower(['green', 'brick', 'panel'], 128, 0);
  } else if (biome === 'dome') {       // ориентир: круглое здание с куполом
    add(domeBuilding(side), 24, 0);
    parking(11, -16, 9);
    addTower('panel', 52, 6);
  } else if (biome === 'letters') {    // ориентир: буквы «ОДИНЦОВО» на клумбе
    const l = cityLetters(); l.rotation.y = -side * 0.9; add(l, 13.5, 0);
    trees(8, 17, 34);
    addTower('green', 50, 0);
  } else if (biome === 'church') {     // ориентир: храм с колокольней и часовня
    add(church(side), 24, 4);
    add(chapel(), 11.5, 15);
    trees(6, 12, 20, -19, 8);
    addTower('green', 56, 0);
  } else if (biome === 'office') {     // напротив храма — бизнес-центр
    add(businessCenter(side), 20, 0);
    parking(11, -12, 4);
    addTower('brick', 46, -4);
  } else {
    trees(12, 10, 40);
    add(box(0.25, 9, 0.25, 0x6b5b4b, 0, 4.5, 0), 9.5, 5);                    // столб ЛЭП
  }
  // полоса невысоких деревьев между дорогой и тротуаром; у остановок и перехода её нет
  if (biome !== 'pond') for (const z0 of [-15.5, -6, 6, 15.5]) {
    const z = z0 + rand(-1.2, 1.2);
    if (!stopsAt.some((sz) => Math.abs(sz - z) < 5.5) && Math.random() < 0.9) addAt(streetTree(), STRIP + rand(-0.3, 0.4), z);
  }
}
function updateWalkers(dt) { // прохожие идут вдоль тротуара и разворачиваются у края квартала
  const t = performance.now() / 1000;
  for (const c of chunks) for (const p of c.userData.walkers || []) {
    const u = p.userData;
    p.position.z += u.walk * dt;
    if (Math.abs(p.position.z) > 19) { u.walk = -Math.sign(p.position.z) * Math.abs(u.walk); p.rotation.y = u.walk > 0 ? 0 : Math.PI; }
    const ph = t * 5.5 * Math.abs(u.walk) + u.phase;
    p.position.y = 0.07 + Math.abs(Math.sin(ph)) * 0.025;
    stepPerson(p, ph);
  }
}
let chunks = [];
let biomeL = 'prospekt', pondLeft = 0;
let crossIn = 10, afterCross = false; // через сколько блоков перекрёсток; сразу за ним справа — синий фитнес
const lastTower = { '-1': null, 1: null }; // какая башня стояла последней на каждой стороне
let biome = 'novostroiki', biomeLeft = 3, firstChunk = false, chunkCount = 0, landmarkCount = 0;
let roadMode = 'oneway', modeLeft = 16; // режим дороги и сколько блоков до его смены
let surfaceKind = null, surfaceLeft = 6;  // покрытие дороги и сколько блоков оно ещё тянется
function spawnChunk(z) {
  const g = new THREE.Group();
  chunkCount++;
  // режим дороги: односторонняя → перекрёсток → участок со встречной полосой → перекрёсток → односторонняя
  let mode = roadMode;
  if (--modeLeft <= 0) {
    if (roadMode === 'oneway') {
      if (game.distance + 300 > TWOWAY_FROM) { mode = 'jIn'; roadMode = 'twoway'; modeLeft = 8 + Math.floor(Math.random() * 7); }
      else modeLeft = 3;
    } else { mode = 'jOut'; roadMode = 'oneway'; modeLeft = 10 + Math.floor(Math.random() * 8); }
  }
  g.userData.mode = mode;
  const plain = mode === 'oneway' || mode === 'twoway';
  // К каждому перекрёстку ведёт одна и та же связка: стела «Одинцово» → клумба с буквами → перекрёсток → синий фитнес справа
  let feature = null; // развязка в этом блоке: перекрёсток или примыкание справа
  if (plain && --crossIn <= 0 && z < -60 && !(modeLeft < 7 && (roadMode !== 'oneway' || game.distance + 300 > TWOWAY_FROM))) { feature = mode === 'oneway' && Math.random() < 0.6 ? 'cross' : 'tRight'; crossIn = 10 + Math.floor(Math.random() * 7); }
  const junctionSoon = roadMode !== 'oneway' || game.distance + 300 > TWOWAY_FROM ? modeLeft : 99;
  const toCross = Math.min(crossIn, junctionSoon);
  const landmark = plain && !feature && !afterCross && toCross > 5 && chunkCount % LANDMARK_EVERY === 0;
  surfaceKind = null; // полотно всегда асфальтовое
  if (tileLeft-- > 0) walkTile = true; else if (Math.random() < 0.14) { walkTile = true; tileLeft = 1 + Math.floor(Math.random() * 3); } else walkTile = false; // тротуар местами выложен плиткой
  roadKit(g, mode, { gapL: feature === 'cross', gapR: feature === 'cross' || feature === 'tRight', surface: surfaceKind });
  if (!plain) { junctionSides(g); afterCross = true; crossIn = Math.max(crossIn, 8); }
  else if (feature === 'cross' || feature === 'tRight') {
    g.userData.sides = [feature];
    afterCross = true;
    if (feature === 'cross') { cornerSide(g, -1); g.add(waitingCar(-1)); } else buildSide(g, biomeL, -1);
    cornerSide(g, 1);
    if (difficulty() > 0.25 && z < -150) { // с боковой улицы справа выезжает машина
      const v = makeVehicle('car'); Object.assign(v.userData, { waiting: true, moving: false });
      addThing(v, 12.6, 0, z + 1.8); v.rotation.y = Math.PI / 2; v.userData.lane = -1;
    } else g.add(waitingCar(1));
  } else if (feature === 'overpass') { buildSide(g, 'les', -1); buildSide(g, 'les', 1); g.add(overpass()); }
  else if (landmark) { // блок-ориентир: купол и буквы либо храм и бизнес-центр
    const s = Math.random() < 0.5 ? 1 : -1; // храм и бизнес-центр напротив
    buildSide(g, 'church', s); buildSide(g, 'office', -s);
  } else {
    // у каждой стороны улицы свой квартал: он не повторяет ни предыдущий на этой стороне, ни тот, что напротив
    // бело-зелёные высотки — только слева
    const other = (prev, opp, sd) => pick(BIOME_BAG.filter((b) => b !== prev && b !== opp && (sd < 0 || b !== 'novostroiki')));
    const special = afterCross ? 'dome' : toCross === 4 ? 'stela' : toCross === 2 ? 'letters' : null;
    afterCross = false;
    biomeL = other(biomeL, biome, -1); biome = special || other(biome, biomeL, 1);
    buildSide(g, biomeL, -1);
    buildSide(g, biome, 1);
    g.userData.sides = [biomeL, biome];
    if (biome === 'pond') { const deck = roadSurface('concrete'); deck.position.y = 0.014; g.add(deck); }
    if (![biome, biomeL].some((b) => b === 'garazhi' || b === 'dome' || b === 'letters' || b === 'stela')) {
      const r = Math.random();
      if (r < 0.25) {
        g.add(crosswalk());
        if (z < -100 && game.distance > 150) for (let i = 0; i < (Math.random() < 0.25 ? 2 : 1); i++) { // пешеходы идут по переходу
          const dir = Math.random() < 0.5 ? 1 : -1, ped = makePed(dir);
          addThing(ped, -dir * 6.6, 0.02, z + rand(-1.2, 1.2));
        }
      } else if (r < 0.43) { // подземный переход: входы друг напротив друга
        const kind = Math.random() < 0.6 ? 'wave' : 'cross', z0 = rand(-10, 10);
        for (const sd of [-1, 1]) { const u = underpass(kind); u.position.set(sd * WALK, 0.07, z0); g.add(u); }
      }
    }
  }
  firstChunk = false;
  castShadows(g);
  mergeStatic(g, (o) => o.userData.walk !== undefined || o.isSprite);
  g.position.z = z;
  scene.add(g);
  chunks.push(g);
}

// ---------- Состояние игры ----------
const ui = {
  score: document.getElementById('score'), coins: document.getElementById('coins'), alert: document.getElementById('alert'),
  overlay: document.getElementById('overlay'), title: document.getElementById('title'), subtitle: document.getElementById('subtitle'),
  btn: document.getElementById('startBtn'), power: document.getElementById('power'), warn: document.getElementById('warn'),
};
const game = {
  state: 'menu', speed: START_SPEED, time: 0, distance: 0, coins: 0,
  lane: 1, prevLane: 1, y: 0, vy: 0, vx: 0, roll: 0, yaw: 0, pitch: 0,
  chaseGap: CHASE_FAR, chaseTimer: 0, slowTimer: 0, safeTimer: 0, spawnAcc: 0, best: 0,
  duck: 0, magnet: 0, boost: 0, spring: 0, shield: false, rampSkip: null, floor: 0, oncomingAcc: 0, bendLeft: 60, bendX: 0, bendY: 0, bends: [], bendNow: 0,
};
try { game.best = Number(localStorage.getItem('velo-best')) || 0; } catch { /* без рекорда */ }
window.__game = game; // для отладки

function clearWorld() {
  for (const t of things) { scene.remove(t); dropMerged(t); }
  for (const c of chunks) { scene.remove(c); dropMerged(c); }
  things = []; chunks = [];
}
function difficulty() { return Math.min(1, game.distance / FULL_DIFFICULTY_AT); }
// расстояние между рядами: с ростом сложности времени на реакцию всё меньше
function rowGap() { return Math.max(20, game.speed * (ROW_TIME_START - difficulty() * (ROW_TIME_START - ROW_TIME_END))); }
function reset() {
  clearWorld();
  Object.assign(game, { speed: START_SPEED, time: 0, distance: 0, coins: 0, lane: 1, prevLane: 1, y: 0, vy: 0, vx: 0, roll: 0, yaw: 0, pitch: 0, chaseGap: CHASE_FAR, chaseTimer: 0, slowTimer: 0, safeTimer: 0, spawnAcc: 0, duck: 0, magnet: 0, boost: 0, spring: 0, shield: false, rampSkip: null, floor: 0, oncomingAcc: 0, caughtDone: false, bendLeft: 60, bendX: 0, bendY: 0, bends: [], bendNow: 0 });
  bend.value.set(0, 0); advanceBends(0);
  bike.position.set(0, 0, 0); bike.rotation.set(0, 0, 0);
  bike.userData.uncrash?.();
  game.crashed = false;
  for (const h of hearts) scene.remove(h);
  hearts = [];
  ui.warn.classList.remove('on');
  biome = 'torg'; biomeL = 'novostroiki'; pondLeft = 0; crossIn = 10; afterCross = false; lastTower[1] = lastTower[-1] = null; biomeLeft = 3; chunkCount = 0; landmarkCount = 0;
  roadMode = 'oneway'; modeLeft = 16; surfaceKind = null; surfaceLeft = 6;
  for (let z = 120; z > -300; z -= CHUNK_LEN) { firstChunk = z === -80; spawnChunk(z); }
  lastFree = 1;
  for (let z = -60; z > SPAWN_Z; z -= 26) spawnRow(z);
}
function start() {
  reset();
  game.state = 'play';
  ui.overlay.classList.add('hidden');
}
// Авария: мир резко тормозит, Даня летит через руль; экран проигрыша — когда всё улеглось
const CRASH_TIME = 2.7;          // сколько секунд длится падение до экрана проигрыша
const CRASH_BRAKE = 6.5;         // насколько резко останавливается мир (больше — резче)
const CRASH_SLOWMO = 0.45;       // замедление времени в первые мгновения удара
const BIKE_NOSE = 0.85;          // от центра велосипеда до переднего колеса: ближе машина подойти не может
function crash(title, text, veh = null) {
  if (game.state !== 'play') return;
  game.state = 'crash'; game.crashed = true;
  game.crashT = 0; game.crashSpeed = game.speed; game.crashMsg = [title, text];
  game.crashVeh = veh; game.womanDone = 0;
  if (veh) { // машина твёрдая: велосипед упирается в неё и дальше катится не быстрее, чем она уезжает
    const d = veh.userData;
    if (d.oncoming || !d.moving || d.turn) { d.halted = true; d.moving = false; d.turn = null; d.changer = false; game.crashSpeed = 0; } // встречная и стоящая — тормозят
    else game.crashSpeed = Math.min(game.crashSpeed, TRAFFIC_SPEED);
  }
  game.duck = 0; ui.alert.classList.remove('on');
  // отлетает в сторону середины дороги, чтобы не скрыться за машиной
  bike.userData.crash?.(game.lane === 0 ? 1 : game.lane === 2 ? -1 : Math.random() < 0.5 ? 1 : -1);
}
function updateCrash(dtReal) {
  const dt = dtReal * (game.crashT < 0.35 ? CRASH_SLOWMO : 1); // короткое замедление в момент удара
  game.crashT += dt; game.time += dt;
  game.crashSpeed *= Math.exp(-CRASH_BRAKE * dt);
  const step = game.crashSpeed * dt;
  game.distance += step;
  scrollWorld(step);
  for (const t of things) { // машины уезжают вперёд, всё остальное останавливается вместе с миром
    moveThing(t, step, dt);
    if (t.userData.type === 'coin') t.rotation.y += dt * 5;
  }
  ui.warn.classList.remove('on');
  // хитбокс машины: она не может оказаться «внутри» велосипеда — её выталкивает вперёд (или назад, если центр уже позади)
  const veh = game.crashVeh;
  let wall = Infinity;
  if (veh && things.includes(veh) && !veh.userData.flung) {
    const reach = veh.userData.halfLen + BIKE_NOSE, ahead = veh.position.z < 0.5;
    if (ahead && veh.position.z > -reach) veh.position.z = Math.max(-reach, veh.position.z - 30 * dtReal);
    else if (!ahead && veh.position.z < reach) veh.position.z = Math.min(reach, veh.position.z + 30 * dtReal);
    // Даня тоже не пролетает сквозь кузов: если он напротив машины, её борт для него — стена
    const rp = bike.userData.riderPos?.(tmpV);
    if (ahead && (!rp || Math.abs(rp.x - veh.position.x) < 1.45)) wall = -veh.position.z - veh.userData.halfLen;
  }
  let sideWall = Infinity;
  const rpos = bike.userData.riderPos?.(tmpV);
  for (const o of things) {
    const od = o.userData;
    if (od.type !== 'vehicle' || od.flung || o === veh) continue;
    const dx = o.position.x - bike.position.x;
    // машина сбоку рядом с местом падения — её борт ограничивает, насколько далеко его отбросит в сторону
    if (Math.abs(dx) > 1.6 && Math.abs(dx) < 5 && o.position.z - od.halfLen < 1 && o.position.z + od.halfLen > -6) sideWall = Math.min(sideWall, Math.abs(dx) - 1.5);
    // встречная видит упавшего и тормозит, а не проезжает по нему
    if (od.oncoming && !od.halted && o.position.z < 2 && o.position.z > -28 && (Math.abs(dx) < 1.6 || (rpos && Math.abs(o.position.x - rpos.x) < 1.8))) { od.halted = true; od.turn = null; }
    if (od.halted && od.oncoming && o.position.z + od.halfLen > (rpos ? rpos.z : 0) - 2.2 && o.position.z < 2 && (Math.abs(dx) < 1.6 || (rpos && Math.abs(o.position.x - rpos.x) < 1.8))) o.position.z = Math.min(o.position.z, (rpos ? rpos.z : 0) - 2.2 - od.halfLen); // и не накатывается на него по инерции мира
  }
  bike.userData.wall?.(wall, sideWall);
  // велосипед опускается на землю и выравнивается — дальше падением управляет модель героя
  game.vy -= GRAVITY * dt; game.y = Math.max(0, game.y + game.vy * dt);
  game.vx *= Math.exp(-8 * dt); bike.position.x += game.vx * dt;
  bike.position.y = game.y;
  game.roll = damp(game.roll, 0, 10, dt); game.yaw = damp(game.yaw, 0, 10, dt); game.pitch = damp(game.pitch, 0, 10, dt);
  bike.rotation.set(game.pitch, game.yaw, game.roll);
  bike.userData.animate(step, game.time, { dt, vx: 0, air: false, vy: 0, landed: false, impact: 0, tuck: 0, duck: 0 });
  bubble.visible = false; springFx.visible = false;
  if (game.crashT >= CRASH_TIME) gameOver(...game.crashMsg);
}
// Финал «Догнала!»: Даня тормозит и оглядывается, поклонница подбегает вплотную, летят сердечки
const CAUGHT_TIME = 3.0;
let hearts = [];
function caught() {
  if (game.state !== 'play') return;
  game.state = 'caught'; game.caughtT = 0; game.caughtSpeed = game.speed * 0.6; game.heartAcc = 0;
  game.caughtSide = bike.position.x > 0 ? -1 : 1; // с какой стороны она подбегает
  game.duck = 0; ui.alert.classList.remove('on'); ui.warn.classList.remove('on');
}
function updateCaught(dt) {
  game.caughtT += dt; game.time += dt;
  game.caughtSpeed *= Math.exp(-2.4 * dt);
  const step = game.caughtSpeed * dt;
  game.distance += step;
  scrollWorld(step);
  for (const t of things) { moveThing(t, step, dt); if (t.userData.type === 'coin') t.rotation.y += dt * 5; }
  game.vy -= GRAVITY * dt; game.y = Math.max(0, game.y + game.vy * dt);
  game.vx *= Math.exp(-6 * dt); bike.position.x += game.vx * dt; bike.position.y = game.y;
  game.roll = damp(game.roll, 0, 6, dt); game.yaw = damp(game.yaw, 0, 6, dt); game.pitch = damp(game.pitch, 0, 8, dt);
  bike.rotation.set(game.pitch, game.yaw, game.roll);
  // оглядывается на неё; ось X героя развёрнута, поэтому знак обратный
  const look = -game.caughtSide * THREE.MathUtils.smoothstep(game.caughtT, 0.3, 1.0);
  bike.userData.animate(step, game.time, { dt, vx: 0, air: false, vy: 0, landed: false, impact: 0, tuck: 0, duck: 0, look });
  bubble.visible = false; springFx.visible = false;
  if (game.chaseGap < 1.7) { // она рядом — сердечки
    game.heartAcc += dt;
    if (game.heartAcc > 0.1) {
      game.heartAcc = 0;
      const h = new THREE.Sprite(new THREE.SpriteMaterial({ map: heartTex, transparent: true, fog: false, depthWrite: false }));
      h.position.set(woman.position.x + rand(-0.6, 0.6) - game.caughtSide * 0.4, rand(1.2, 2.0), woman.position.z + rand(-0.9, 0.1));
      h.scale.setScalar(rand(0.25, 0.5)); h.userData = { life: 0, vx: rand(-0.4, 0.4), vy: rand(0.9, 1.7) };
      scene.add(h); hearts.push(h);
    }
  }
  if (game.caughtT >= CAUGHT_TIME) { game.caughtDone = true; gameOver('Догнала! ❤', 'Теперь придётся идти на свидание.'); }
}
function updateHearts(dt) {
  hearts = hearts.filter((h) => {
    const u = h.userData; u.life += dt;
    h.position.x += u.vx * dt; h.position.y += u.vy * dt;
    h.scale.multiplyScalar(1 + dt * 0.5);
    h.material.opacity = Math.max(0, 1 - u.life / 1.6);
    if (u.life < 1.6) return true;
    scene.remove(h); return false;
  });
}
function gameOver(title, text) {
  game.state = 'over';
  const score = Math.floor(game.distance) + game.coins * 10;
  if (score > game.best) { game.best = score; try { localStorage.setItem('velo-best', String(score)); } catch { /* ок */ } }
  ui.title.textContent = title;
  ui.subtitle.textContent = `${text} Счёт: ${score} · рекорд: ${game.best}`;
  ui.btn.textContent = 'Ещё раз';
  ui.alert.classList.remove('on');
  setTimeout(() => { if (game.state === 'over') ui.overlay.classList.remove('hidden'); }, 500);
}
function stumble() {
  if (game.safeTimer > 0) return;
  game.safeTimer = 0.7;
  game.slowTimer = 1.0;
  if (game.chaseTimer > 0) {
    game.chaseTimer = 99; // она уже рядом — догнала
    caught();
  } else {
    game.chaseTimer = CHASE_TIME;
  }
}

// ошибка: шлем принимает её на себя один раз
function hurt() {
  if (game.safeTimer > 0) return;
  if (game.shield) { game.shield = false; game.safeTimer = 1; return; }
  stumble();
}
function applyBonus(kind) {
  if (kind === 'magnet') game.magnet = MAGNET_TIME;
  else if (kind === 'bar') game.boost = BOOST_TIME;
  else if (kind === 'spring') game.spring = SPRING_TIME;
  else game.shield = true;
}
function fling(t) { // машину отбрасывает в сторону (под батончиком или со шлемом)
  const dir = t.position.x >= bike.position.x ? 1 : -1;
  t.userData.flung = { vx: dir * rand(7, 11), vy: rand(7, 10), spin: rand(2, 5) * dir };
}
// щит-пузырь вокруг Дани: синий — шлем, оранжевый — батончик
const bubble = new THREE.Mesh(new THREE.SphereGeometry(1.35, 20, 14), new THREE.MeshBasicMaterial({ color: 0x7cc4ff, transparent: true, opacity: 0.22, depthWrite: false }));
bubble.visible = false;
scene.add(bubble);
// зелёное кольцо под колёсами, пока действует пружина
const springFx = new THREE.Mesh(new THREE.TorusGeometry(0.9, 0.05, 6, 28), new THREE.MeshBasicMaterial({ color: 0x70e000 }));
springFx.rotation.x = Math.PI / 2; springFx.visible = false;
scene.add(springFx);

// ---------- Управление ----------
function move(dir) {
  if (game.state !== 'play') return;
  const next = THREE.MathUtils.clamp(game.lane + dir, 0, 2);
  if (next !== game.lane) { game.prevLane = game.lane; game.lane = next; bike.userData.signal?.(dir); }
}
function jump() {
  // прыгать можно с земли и с крыши автобуса; с пружиной прыжок намного выше
  if (game.state === 'play' && game.y <= game.floor + 0.001) { game.vy = game.spring > 0 ? SUPER_JUMP_V : JUMP_V; game.duck = 0; }
}
function duck() { // пригнуться к рулю; в воздухе — быстро приземлиться
  if (game.state !== 'play') return;
  game.duck = DUCK_TIME;
  if (game.y > game.floor + 0.001) game.vy = Math.min(game.vy, -14);
}
window.addEventListener('keydown', (e) => {
  if (e.repeat) return;
  if (game.state !== 'play') { if (e.code === 'Enter' || e.code === 'Space') start(); return; }
  if (e.code === 'ArrowLeft' || e.code === 'KeyA') move(-1);
  else if (e.code === 'ArrowRight' || e.code === 'KeyD') move(1);
  else if (e.code === 'ArrowUp' || e.code === 'KeyW' || e.code === 'Space') { e.preventDefault(); jump(); }
  else if (e.code === 'ArrowDown' || e.code === 'KeyS') { e.preventDefault(); duck(); }
});
let touch = null;
window.addEventListener('pointerdown', (e) => {
  if (game.state !== 'play') { start(); return; }
  touch = { x: e.clientX, y: e.clientY };
});
window.addEventListener('pointermove', (e) => {
  if (!touch) return;
  const dx = e.clientX - touch.x, dy = e.clientY - touch.y;
  if (Math.abs(dx) > 30 && Math.abs(dx) > Math.abs(dy)) { move(Math.sign(dx)); touch = null; }
  else if (dy < -30) { jump(); touch = null; }
  else if (dy > 30) { duck(); touch = null; }
});
window.addEventListener('pointerup', () => { touch = null; });

// ---------- Игровой цикл ----------
// Повороты и уклоны: раз в несколько сотен метров далеко впереди (за туманом) начинается новый изгиб и едет к игроку
const BEND_AHEAD = 275;
function advanceBends(step) {
  if (game.state === 'play') {
    game.bendLeft -= step;
    if (game.bendLeft <= 0 && game.bends.length < BEND_SLOTS) {
      game.bendLeft = rand(220, 520);
      const r = Math.random(), h = Math.random();
      const nx = r < 0.35 ? 0 : (r < 0.675 ? 1 : -1) * BEND_TURN * rand(0.5, 1);
      const ny = h < 0.5 ? 0 : h < 0.78 ? -BEND_HILL * rand(0.5, 1) : BEND_HILL * rand(0.4, 0.7);
      game.bends.push({ a: BEND_AHEAD, L: rand(90, 160), dx: nx - game.bendX, dy: ny - game.bendY });
      game.bendX = nx; game.bendY = ny; // к чему придёт кривизна, когда все переходы проедут
    }
  }
  let now = bend.value.x;
  game.bends = game.bends.filter((b) => {
    b.a -= step;
    if (b.a + b.L > 0) { now += b.dx * THREE.MathUtils.clamp(-b.a / b.L, 0, 1); return true; }
    bend.value.x += b.dx; bend.value.y += b.dy; now += b.dx; return false; // переход целиком позади — он стал кривизной под колёсами
  });
  game.bendNow = now;
  bendT.value.forEach((v, i) => { const b = game.bends[i]; if (b) v.set(b.a, b.L, b.dx, b.dy); else v.set(1e4, 1, 0, 0); });
}
function scrollWorld(step) { // разметка и обочины едут навстречу
  advanceBends(step);
  for (const [tex, tile] of scrolling) tex.offset.y = (tex.offset.y + step / tile) % 1;
  for (const c of chunks) c.position.z += step;
  if (chunks.length && chunks[0].position.z > 140) { const old = chunks.shift(); scene.remove(old); dropMerged(old); }
  const lastZ = chunks[chunks.length - 1].position.z;
  if (lastZ > -300 + CHUNK_LEN) spawnChunk(lastZ - CHUNK_LEN);
}
// Заставка: Даня крутит педали, камера показывает его крупным планом спереди-сбоку
const MENU_SPEED = 7;
const MENU_CAM = { pos: new THREE.Vector3(2.7, 1.25, -3.3), look: new THREE.Vector3(-0.1, 0.55, 0.3) };
const camLook = MENU_CAM.look.clone();
function menuIdle(dt) {
  const step = MENU_SPEED * dt;
  scrollWorld(step);
  bike.userData.animate(step, 0, { dt, vx: 0, air: false, vy: 0, landed: false, impact: 0, tuck: 0, duck: 0 });
}
function update(dt) {
  game.time += dt;
  game.speed = START_SPEED + (MAX_SPEED - START_SPEED) * difficulty();
  game.slowTimer = Math.max(0, game.slowTimer - dt);
  game.safeTimer = Math.max(0, game.safeTimer - dt);
  game.duck = Math.max(0, game.duck - dt);
  game.magnet = Math.max(0, game.magnet - dt);
  game.boost = Math.max(0, game.boost - dt);
  game.spring = Math.max(0, game.spring - dt);
  const speed = game.speed * (game.slowTimer > 0 ? 0.6 : 1) * (game.boost > 0 ? BOOST_SPEED : 1);
  const step = speed * dt;
  game.distance += step;

  // велосипедист
  const targetX = LANES[game.lane];
  // перестроение — пружина с затуханием: разгон, торможение и лёгкий занос вместо мгновенного рывка
  game.vx += ((targetX - bike.position.x) * STEER_SPRING - game.vx * STEER_DAMPING) * dt;
  bike.position.x += game.vx * dt;
  // «пол» под колёсами: земля или крыша автобуса, если мы над ним и не ниже крыши
  let floor = 0;
  for (const t of things) {
    const d = t.userData;
    if (d.roof && !d.flung && Math.abs(t.position.x - bike.position.x) < 1.25 && Math.abs(t.position.z) < d.halfLen + 0.7 && game.y >= d.roof - 0.4) floor = Math.max(floor, d.roof);
    if (d.ramp && game.rampSkip === t && !d.flung && Math.abs(t.position.x - bike.position.x) < 1.3) { // эвакуатор, на который заехали: аппарель, платформа и крыша кабины — твёрдые
      const u = t.position.z + d.halfLen;                             // сколько метров проехали от начала аппарели
      const h = u < 0 ? 0 : u < 3 ? 1.1 * u / 3 : u < 6.6 ? 1.1 : u < 7.1 ? 1.1 + 1.25 * (u - 6.6) / 0.5 : u < 9.4 ? 2.35 : 0;
      floor = Math.max(floor, h);
    }
  }
  const wasAir = game.y > game.floor + 0.001, fallSpeed = -game.vy;
  game.floor = floor;
  game.vy -= GRAVITY * dt;
  game.y = Math.max(floor, game.y + game.vy * dt);
  if (game.y === floor) game.vy = 0;
  const air = game.y > floor + 0.001, landed = wasAir && !air;
  bike.position.y = game.y;
  // наклон в поворот, доворот носа и тангаж в прыжке идут с запозданием — так чувствуется вес
  const wobble = game.slowTimer > 0 ? Math.sin(game.time * 40) * 0.08 : 0;
  game.roll = damp(game.roll, THREE.MathUtils.clamp(-game.vx * 0.024, -0.4, 0.4) - game.bendNow * 80, 9, dt); // в повороте дороги слегка заваливается
  game.yaw = damp(game.yaw, THREE.MathUtils.clamp(-game.vx * 0.012, -0.2, 0.2), 9, dt);
  game.pitch = damp(game.pitch, air ? THREE.MathUtils.clamp(game.vy * 0.028, -0.22, 0.28) : 0, air ? 10 : 16, dt);
  bike.rotation.set(game.pitch, game.yaw, game.roll + wobble);
  bike.userData.animate(step, game.time, { dt, vx: game.vx, air, vy: game.vy, landed, impact: Math.min(1.4, fallSpeed / JUMP_V),
    tuck: THREE.MathUtils.smoothstep(game.distance, TUCK_FROM, TUCK_FULL), duck: game.duck > 0 ? 1 : 0 });

  scrollWorld(step);

  // новые ряды препятствий
  game.spawnAcc += (speed - TRAFFIC_SPEED) * dt;
  if (game.spawnAcc >= rowGap()) { game.spawnAcc = 0; spawnRow(SPAWN_Z); }
  game.oncomingAcc += dt; // встречный поток на участках с двусторонним движением
  if (game.oncomingAcc > THREE.MathUtils.lerp(2.4, 1.2, difficulty())) { game.oncomingAcc = 0; spawnOncoming(); }

  // движение и столкновения
  const px = bike.position.x;
  const vehicles = things.filter((t) => t.userData.type === 'vehicle');
  const keep = [];
  for (const t of things) {
    const d = t.userData;
    moveThing(t, step, dt);
    let alive = t.position.z < 14 && !d.gone;

    if (alive && d.type !== 'vehicle' && d.type !== 'ped' && d.type !== 'none' && !d.moving) {
      // машина наехала на неподвижный предмет — убираем его, чтобы не было нечестных ловушек
      for (const v of vehicles) {
        if (onLane(v, d.lane) && Math.abs(v.position.z - t.position.z) < v.userData.halfLen + 0.4) { alive = false; break; } // редкий случай: предмет скрывается под машиной
      }
    }
    if (d.flung) { // отброшенная машина улетает кувырком
      d.flung.vy -= GRAVITY * dt;
      t.position.x += d.flung.vx * dt; t.position.y += d.flung.vy * dt;
      t.rotation.z += d.flung.spin * dt; t.rotation.x += d.flung.spin * 0.6 * dt;
      alive = alive && t.position.y > -6;
    } else if (alive && d.type === 'coin') {
      t.rotation.y += dt * 5;
      if (game.magnet > 0 && t.position.z > -14 && t.position.z < 3) { // магнит тянет монеты со всех полос
        t.position.x = damp(t.position.x, px, 9, dt);
        t.position.y = damp(t.position.y, game.y + 1, 9, dt);
        if (t.position.z < 0) t.position.z = damp(t.position.z, 0, 5, dt);
      }
      if (Math.abs(t.position.z) < 1 && Math.abs(t.position.x - px) < 1.1 && Math.abs(t.position.y - (game.y + 1)) < 1.3) { game.coins++; alive = false; }
    } else if (alive && d.type === 'bonus') {
      t.children[0].rotation.y += dt * 2.5;
      t.children[1].rotation.y -= dt * 1.5;
      t.position.y = 1.1 + Math.sin(game.time * 4) * 0.12;
      if (Math.abs(t.position.z) < 1.1 && Math.abs(t.position.x - px) < 1.2 && game.y < 2.2) { applyBonus(d.kind); alive = false; }
    } else if (alive && d.type === 'barrier') {
      if (Math.abs(t.position.z) < 0.9 && Math.abs(t.position.x - px) < 1.4 && game.y < 0.6) { alive = false; if (game.boost <= 0) hurt(); }
    } else if (alive && d.type === 'gate') {
      // шлагбаум: проходим только пригнувшись
      if (Math.abs(t.position.z) < 0.7 && Math.abs(t.position.x - px) < 1.4 && game.duck <= 0 && game.y < 2.0) { alive = false; if (game.boost <= 0) hurt(); }
    } else if (alive && d.type === 'ped') {
      if (Math.abs(t.position.z) < 0.8 && Math.abs(t.position.x - px) < 0.75 && game.y < 1.5) { // задел пешехода — он отскакивает
        d.type = 'none'; d.walking = false; stepPerson(t, 0, 0); t.position.x += (t.position.x >= px ? 1 : -1) * 1.4;
        if (game.boost <= 0) hurt();
      }
    } else if (alive && d.type === 'vehicle' && game.state === 'play') {
      const hitZ = Math.abs(t.position.z) < d.halfLen + 0.7;
      const hitX = Math.abs(t.position.x - px) < 1.2;
      if (game.rampSkip === t) { // после трамплина эта машина нас не задевает, пока не проедем её
        if (t.position.z > d.halfLen + 1) game.rampSkip = null;
      } else if (hitZ && hitX && game.y < (d.roof ? d.roof - 0.4 : d.height)) { // на крышу автобуса можно приземлиться с небольшим запасом
        const changing = d.lane === game.lane && Math.abs(px - targetX) > 0.5;
        const onRamp = d.ramp && !changing && t.position.z < -(d.halfLen - 3.2) && game.y < 0.5 && game.floor === 0;
        if (onRamp) {
          game.vy = RAMP_V; game.y = Math.max(game.y, 0.05); game.duck = 0; game.rampSkip = t; // трамплин!
        } else if (game.boost > 0) {
          fling(t);
        } else if (changing && t.position.z > -d.halfLen) {
          game.lane = game.prevLane; // задел бок — отбросило обратно
          hurt();
        } else if (game.shield) {
          game.shield = false; game.safeTimer = 1; fling(t);
        } else {
          crash('Авария!', d.oncoming ? 'Лобовое на встречной полосе.' : d.halfLen > 5 ? 'Ты влетел в автобус.' : d.ramp ? 'Ты влетел в эвакуатор.' : 'Ты влетел в машину.', t);
        }
      }
    }
    if (alive) keep.push(t); else { scene.remove(t); dropMerged(t); }
  }
  things = keep;

  if (game.rampSkip && !things.includes(game.rampSkip)) game.rampSkip = null;
  // пузырь-щит и подсказка о бонусах
  bubble.visible = game.shield || game.boost > 0;
  bubble.position.set(px, game.y + 1.05, -0.1);
  springFx.visible = game.spring > 0;
  springFx.position.set(px, game.y + 0.05, 0);
  springFx.rotation.z += dt * 4;
  bubble.material.color.set(game.boost > 0 ? 0xffb703 : 0x7cc4ff);
  bubble.material.opacity = 0.2 + (game.boost > 0 ? 0.08 * Math.sin(game.time * 20) : 0);
  // погоня
  if (game.chaseTimer > 0 && game.state === 'play') game.chaseTimer = Math.max(0, game.chaseTimer - dt);
  ui.alert.classList.toggle('on', game.chaseTimer > 0 && game.state === 'play');
  ui.warn.classList.toggle('on', game.state === 'play' && game.lane === 0 && modeAt(0) === 'twoway');
}
const WOMAN_RUN = 6.2; // с какой скоростью подбегает к упавшему
function updateWoman(dt) {
  const u0 = woman.userData;
  // После аварии: бежит к лежащему Дане, останавливается сбоку от него и присаживается, протягивая руки
  if (game.crashed && (game.state === 'crash' || game.state === 'over')) {
    const rp = bike.userData.riderPos?.(tmpV) ?? tmpV.set(bike.position.x, 0, -2);
    const sd = rp.x >= bike.position.x ? 1 : -1;               // встаёт с внешней стороны, не там, где лежит велосипед
    const tx = rp.x + sd * 0.62, tz = rp.z + 0.05;
    const dx = tx - woman.position.x, dz = tz - woman.position.z, dist = Math.hypot(dx, dz);
    const arrived = dist < 0.12 || game.womanDone > 0;
    const run = Math.min(WOMAN_RUN, 1.6 + dist * 2.6);       // у самой цели сбавляет шаг
    if (!arrived) { const k = Math.min(1, run * dt / dist); woman.position.x += dx * k; woman.position.z += dz * k; }
    else game.womanDone += dt;
    game.chaseGap = woman.position.z;
    // на подходе разворачивается к нему лицом
    const turn = arrived ? 1 : THREE.MathUtils.smoothstep(1.6 - dist, 0, 1.6);
    woman.rotation.y = damp(woman.rotation.y, sd * Math.PI / 2 * turn + (arrived ? 0 : Math.atan2(-dx, -dz) * (1 - turn)), 8, dt);
    const ground = run + (game.state === 'crash' ? game.crashSpeed : 0); // её скорость относительно асфальта: мир под ней ещё катится
    if (u0.animate) u0.animate(dt, { close: arrived ? 1 : THREE.MathUtils.clamp(1 - dist / 2.5, 0, 1), still: arrived ? 1 : 0, kneel: arrived ? 1 : 0, speed: ground });
    u0.heart.position.y = (u0.heartY ?? 2.35) - (arrived ? 0.45 * Math.min(1, game.womanDone * 3) : 0) + Math.sin(performance.now() / 250) * 0.1;
    return;
  }
  woman.rotation.y = 0;
  const hug = game.state === 'caught' || game.caughtDone; // подбежала вплотную
  const target = hug ? 0.7 : game.state === 'over' ? 1.1 : game.chaseTimer > 0 ? CHASE_NEAR : CHASE_FAR;
  game.chaseGap += (target - game.chaseGap) * Math.min(1, dt * (hug ? 2.2 : 3));
  const sideOffset = hug ? game.caughtSide * 0.85 : bike.position.x > 0 ? -1.1 : 1.1; // бежит сбоку, чтобы не закрывать велосипедиста
  woman.position.x += (bike.position.x + sideOffset - woman.position.x) * Math.min(1, dt * 6);
  woman.position.z = game.chaseGap;
  const t = performance.now() / 1000;
  const u = woman.userData;
  if (u.animate) { // модель со скелетом: чем ближе к Дане, тем сильнее тянет руки
    u.animate(dt, { close: THREE.MathUtils.clamp((CHASE_FAR - game.chaseGap) / (CHASE_FAR - CHASE_NEAR), 0, 1), still: hug && game.chaseGap < 1.0 ? 1 : 0 });
  } else {         // фигурка из простых фигур
    woman.position.y = Math.abs(Math.sin(t * 11)) * 0.12;
    u.legL.position.z = Math.sin(t * 11) * 0.25;
    u.legR.position.z = -Math.sin(t * 11) * 0.25;
  }
  u.heart.position.y = (u.heartY ?? 2.35) + Math.sin(t * 4) * 0.1;
}

const clock = new THREE.Clock();
function frame() {
  const dt = Math.min(clock.getDelta(), 0.05);
  if (game.state === 'play') update(dt);
  else if (game.state === 'crash') updateCrash(dt);
  else if (game.state === 'caught') updateCaught(dt);
  updateHearts(dt);
  updateWalkers(dt);
  updateWoman(dt);
  if (game.state === 'menu') {
    menuIdle(dt);
    camera.position.copy(MENU_CAM.pos);
    camLook.copy(MENU_CAM.look);
  } else if (game.state === 'caught' || game.caughtDone) {
    // финал: камера облетает и показывает обоих спереди-сбоку
    const sd = game.caughtSide;
    camera.position.x = damp(camera.position.x, bike.position.x + sd * 2.9, 2.2, dt);
    camera.position.y = damp(camera.position.y, 1.7, 2.2, dt);
    camera.position.z = damp(camera.position.z, -3.4, 2.2, dt);
    camLook.set(damp(camLook.x, bike.position.x + sd * 0.4, 3, dt), damp(camLook.y, 1.1, 3, dt), damp(camLook.z, 0.5, 3, dt));
  } else {
    // после старта камера плавно перелетает из заставки за спину
    camera.position.x = damp(camera.position.x, bike.position.x * 0.6, 6, dt);
    const down = game.crashed; // при аварии камера опускается и подъезжает ближе
    camera.position.y = damp(camera.position.y, down ? 3.0 : 4.6 + game.y * 0.75, 3.5, dt); // поднимается вместе с Даней
    camera.position.z = damp(camera.position.z, down ? 6.4 : 8.5, 3.5, dt);
    if (game.state === 'crash' && game.crashT < 0.45) { camera.position.x += (Math.random() - 0.5) * 0.14; camera.position.y += (Math.random() - 0.5) * 0.1; } // встряска от удара
    camLook.set(damp(camLook.x, camera.position.x, 5, dt), damp(camLook.y, 1.4 + game.y * 0.6, 5, dt), damp(camLook.z, -10, 5, dt));
  }
  if (window.__dbg.cam) { camera.position.set(...window.__dbg.cam.pos); camLook.set(...window.__dbg.cam.look); }
  skyH.value = renderer.domElement.height;
  camera.lookAt(camLook);
  ui.score.textContent = `${Math.floor(game.distance)} м`;
  ui.coins.textContent = `🪙 ${game.coins}`;
  ui.power.textContent = game.state !== 'play' ? '' : [game.magnet > 0 ? `🧲 ${Math.ceil(game.magnet)}` : '', game.boost > 0 ? `⚡ ${Math.ceil(game.boost)}` : '', game.spring > 0 ? `🌀 ${Math.ceil(game.spring)}` : '', game.shield ? '⛑' : ''].filter(Boolean).join('   ');
  const fov = game.state === 'play' && game.boost > 0 ? 74 : 62; // под батончиком обзор шире — ощущение скорости
  if (Math.abs(camera.fov - fov) > 0.05) { camera.fov = damp(camera.fov, fov, 5, dt); camera.updateProjectionMatrix(); }
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
// отладка: показать заданные типы застройки и поставить камеру вручную
function debugChunks(list) {
  for (const c of chunks) scene.remove(c);
  chunks = [];
  list.forEach((b0, i) => {
    const g = new THREE.Group(), z = 40 - i * CHUNK_LEN;
    const [b, surf] = b0.split('+'); // например 'prospekt+concrete'
    const mode = ['jIn', 'jOut', 'twoway'].includes(b) ? b : 'oneway';
    g.userData.mode = mode;
    roadKit(g, mode, { gapL: b === 'cross', gapR: b === 'cross' || b === 'tRight', surface: surf || null });
    if (mode === 'jIn' || mode === 'jOut') junctionSides(g);
    else if (b === 'cross') { cornerSide(g, -1); cornerSide(g, 1); g.add(waitingCar(-1), waitingCar(1)); }
    else if (b === 'tRight') { buildSide(g, 'prospekt', -1); cornerSide(g, 1); g.add(waitingCar(1)); }
    else if (b === 'overpass') { buildSide(g, 'les', -1); buildSide(g, 'les', 1); g.add(overpass()); }
    else if (b === 'landmark') { buildSide(g, 'dome', 1); buildSide(g, 'letters', -1); }
    else if (b === 'landmark2') { buildSide(g, 'church', 1); buildSide(g, 'office', -1); }
    else if (b.startsWith('under:')) { buildSide(g, 'slab', -1); buildSide(g, 'slab', 1); for (const sd of [-1, 1]) { const u = underpass(b.slice(6)); u.position.set(sd * WALK, 0.07, 0); g.add(u); } }
    else { const bb = b === 'stela' ? 'novostroiki' : b === 'twoway' ? 'prospekt' : b; buildSide(g, bb, -1); buildSide(g, bb, 1, b === 'stela' ? 'stela' : null); if (bb === 'pond') g.add(roadSurface('concrete')); }
    castShadows(g); g.position.z = z; scene.add(g); chunks.push(g);
  });
}
window.__dbg = { debugChunks, ussrByName, makeService, person, renderer, carModels, makeLiaz, tower, panel9, scene, cam: null, bend, makeBus, makeSemi, makePhotoVehicle, crash, updateCrash, caught, updateCaught, spawnOncoming, modeAt, chunks: () => chunks, woman, update, move, jump, duck, start, makeVehicle, applyBonus, place, makeGate, makeRampTruck, makeBonus, things: () => things, bike }; // для автотестов
reset();
frame();
