import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

/* ------------------------------------------------------------------ DOM */
const $ = (id) => document.getElementById(id);
const canvas = $('stage');
const els = {
  loader: $('loader'), hint: $('hint'), gallery: $('gallery'), file: $('file'),
  target: $('target'), auto: $('auto'), reset: $('reset'), snap: $('snap'), toast: $('toast'),
};

/* ------------------------------------------------------------------ renderer / scene */
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
} catch (e) {
  els.loader.textContent = 'WebGL is not available in this browser.';
  throw e;
}
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xdde9ff);
scene.fog = new THREE.Fog(0xdde9ff, 18, 36);

const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

scene.add(new THREE.HemisphereLight(0xffffff, 0xdfe6f0, 0.55));
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
sun.position.set(4, 8, 6);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -8, right: 8, top: 8, bottom: -8, near: 1, far: 25 });
sun.shadow.bias = -0.0005;
scene.add(sun);

const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);

/* ------------------------------------------------------------------ materials */
const metal = new THREE.MeshStandardMaterial({ color: 0xdadce1, metalness: 0.9, roughness: 0.35 });
const black = new THREE.MeshStandardMaterial({ color: 0x07080a, roughness: 0.35, metalness: 0.2 });
const keys = new THREE.MeshStandardMaterial({ color: 0x1a1b1f, roughness: 0.7 });
const pad = new THREE.MeshStandardMaterial({ color: 0xc4c6cc, metalness: 0.5, roughness: 0.4 });

/* ------------------------------------------------------------------ geometry helpers */
function roundedRectShape(w, h, r) {
  const s = new THREE.Shape();
  const x = -w / 2, y = -h / 2, P = Math.PI;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);         s.absarc(x + w - r, y + r, r, -P / 2, 0, false);
  s.lineTo(x + w, y + h - r);     s.absarc(x + w - r, y + h - r, r, 0, P / 2, false);
  s.lineTo(x + r, y + h);         s.absarc(x + r, y + h - r, r, P / 2, P, false);
  s.lineTo(x, y + r);             s.absarc(x + r, y + r, r, P, P * 1.5, false);
  return s;
}

/** Flat rounded rectangle with 0..1 UVs (so textures map edge to edge). */
function roundedPlane(w, h, r) {
  const g = new THREE.ShapeGeometry(roundedRectShape(w, h, r), 16);
  const pos = g.attributes.position, uv = g.attributes.uv;
  for (let i = 0; i < pos.count; i++) uv.setXY(i, pos.getX(i) / w + 0.5, pos.getY(i) / h + 0.5);
  return g;
}

function box(w, h, d, mat, radius = 0.03) {
  return new THREE.Mesh(new RoundedBoxGeometry(w, h, d, 4, Math.min(radius, d / 2 - 0.001)), mat);
}

/* ------------------------------------------------------------------ screens registry */
const screens = {};          // key -> { mesh, aspect }
const textures = {};         // key -> THREE.Texture currently applied

function makeScreen(key, w, h, radius) {
  const mat = new THREE.MeshBasicMaterial({ color: 0x111111, toneMapped: false });
  const mesh = new THREE.Mesh(roundedPlane(w, h, radius), mat);
  screens[key] = { mesh, aspect: w / h };
  return mesh;
}

function sourceSize(src) {
  return { w: src.naturalWidth || src.width, h: src.naturalHeight || src.height };
}

/** "object-fit: cover" for a texture on a plane of a given aspect ratio. */
function coverFit(tex, src, planeAspect) {
  const { w, h } = sourceSize(src);
  const imgAspect = w / h;
  tex.repeat.set(1, 1);
  tex.offset.set(0, 0);
  if (imgAspect > planeAspect) {
    const r = planeAspect / imgAspect;
    tex.repeat.x = r; tex.offset.x = (1 - r) / 2;
  } else {
    const r = imgAspect / planeAspect;
    tex.repeat.y = r; tex.offset.y = (1 - r) / 2;
  }
}

function setScreenSource(key, src) {
  const s = screens[key];
  const tex = new THREE.Texture(src);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  coverFit(tex, src, s.aspect);
  tex.needsUpdate = true;
  if (textures[key]) textures[key].dispose();
  textures[key] = tex;
  s.mesh.material.map = tex;
  s.mesh.material.color.set(0xffffff);
  s.mesh.material.needsUpdate = true;
}

function setAllScreens(src, target = 'all') {
  const list = target === "all" ? Object.keys(screens) : [target];
  list.forEach((k) => setScreenSource(k, src));
}

/* ------------------------------------------------------------------ devices */
function buildMonitor() {
  const g = new THREE.Group();
  const body = box(3.4, 2.05, 0.12, metal, 0.06);
  body.position.y = 1.95;
  const bezel = box(3.34, 1.99, 0.02, black, 0.05);
  bezel.position.set(0, 1.95, 0.06);
  const screen = makeScreen('monitor', 3.2, 1.8, 0.02);
  screen.position.set(0, 1.95, 0.0715);
  const neck = box(0.55, 1.1, 0.09, metal, 0.03);
  neck.position.set(0, 0.55, -0.1);
  neck.rotation.x = -0.04;
  const foot = box(1.15, 0.05, 0.85, metal, 0.02);
  foot.position.set(0, 0.025, -0.05);
  g.add(body, bezel, screen, neck, foot);
  return g;
}

function buildLaptop() {
  const g = new THREE.Group();
  const base = box(2.4, 0.07, 1.6, metal, 0.03);
  base.position.y = 0.035;
  const kb = box(2.05, 0.01, 0.72, keys, 0.004);
  kb.position.set(0, 0.07, -0.18);
  const trackpad = box(0.85, 0.008, 0.5, pad, 0.003);
  trackpad.position.set(0, 0.07, 0.5);

  const hinge = new THREE.Group();            // pivot sits on the back edge of the base
  hinge.position.set(0, 0.07, -0.8);
  hinge.rotation.x = -0.26;                   // ~105° open
  const lid = box(2.4, 1.5, 0.05, metal, 0.02);
  lid.position.y = 0.75;
  const bezel = box(2.32, 1.44, 0.01, black, 0.01);
  bezel.position.set(0, 0.75, 0.028);
  const screen = makeScreen('laptop', 2.2, 1.375, 0.015);
  screen.position.set(0, 0.75, 0.0345);
  hinge.add(lid, bezel, screen);

  g.add(base, kb, trackpad, hinge);
  return g;
}

function buildPhone() {
  const g = new THREE.Group();
  const bodyGeo = new THREE.ExtrudeGeometry(roundedRectShape(0.596, 1.276, 0.09), {
    depth: 0.05, bevelEnabled: true, bevelThickness: 0.012, bevelSize: 0.012,
    bevelSegments: 5, curveSegments: 16,
  });
  bodyGeo.translate(0, 0, -0.025);
  const body = new THREE.Mesh(bodyGeo, metal);
  const bezel = new THREE.Mesh(roundedPlane(0.585, 1.265, 0.078), black);
  bezel.position.z = 0.0375;
  const screen = makeScreen('phone', 0.555, 1.235, 0.066);
  screen.position.z = 0.0385;
  const island = new THREE.Mesh(roundedPlane(0.13, 0.036, 0.018), black);
  island.position.set(0, 0.55, 0.0392);
  g.add(body, bezel, screen, island);
  g.rotation.x = -0.08;                       // slight lean back
  const wrap = new THREE.Group();
  wrap.add(g);
  g.position.y = 0.66;
  return wrap;
}

function blobShadow(w, d, x, z, rotY = 0, opacity = 0.35) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d');
  const grad = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(0,0,0,.9)');
  grad.addColorStop(0.55, 'rgba(0,0,0,.35)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 128, 128);
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(w, d),
    new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, opacity,
      depthWrite: false, toneMapped: false }),
  );
  m.rotation.set(-Math.PI / 2, 0, rotY);
  m.position.set(x, 0.003, z);
  return m;
}

const stage = new THREE.Group();
scene.add(stage);

const monitor = buildMonitor();  monitor.position.set(0.4, 0, -0.3);
const laptop  = buildLaptop();   laptop.position.set(-2.95, 0, 0.55);  laptop.rotation.y = 0.3;
const phone   = buildPhone();    phone.position.set(2.85, 0, 0.45);    phone.rotation.y = -0.3;
stage.add(monitor, laptop, phone);
stage.traverse((o) => { if (o.isMesh) o.castShadow = true; });

const floor = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), new THREE.ShadowMaterial({ opacity: 0.12 }));
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
scene.add(floor);
scene.add(
  blobShadow(4.4, 2.2, 0.4, -0.25, 0, 0.32),
  blobShadow(3.6, 3.0, -2.95, 0.55, 0.3, 0.30),
  blobShadow(1.3, 0.9, 2.85, 0.45, -0.3, 0.30),
);

/* ------------------------------------------------------------------ default placeholder screen */
function makePlaceholder() {
  const c = document.createElement('canvas');
  c.width = 1600; c.height = 1000;
  const g = c.getContext('2d');

  const bg = g.createLinearGradient(0, 0, 1600, 1000);
  bg.addColorStop(0, '#f6f9ff'); bg.addColorStop(1, '#dce8ff');
  g.fillStyle = bg; g.fillRect(0, 0, 1600, 1000);

  const wave = (y, amp, c1, c2, phase) => {
    const grad = g.createLinearGradient(0, y - amp, 1600, y + amp);
    grad.addColorStop(0, c1); grad.addColorStop(1, c2);
    g.fillStyle = grad;
    g.beginPath(); g.moveTo(0, 1000);
    for (let x = 0; x <= 1600; x += 20) g.lineTo(x, y + Math.sin(x / 260 + phase) * amp);
    g.lineTo(1600, 1000); g.closePath(); g.fill();
  };
  wave(720, 70, '#60a5fa', '#7c3aed', 0);
  wave(800, 60, '#2563eb', '#4f46e5', 1.6);
  wave(880, 45, '#1d4ed8', '#312e81', 3.1);

  g.textAlign = 'center';
  g.fillStyle = '#0f1f4d';
  g.font = '700 120px system-ui, sans-serif';
  g.fillText('Your Brand', 800, 440);
  g.fillStyle = '#3b5bdb';
  g.font = '500 38px system-ui, sans-serif';
  g.fillText('UPLOAD YOUR OWN SCREEN BELOW', 800, 510);
  return c;
}
setAllScreens(makePlaceholder());

const defaultScreenImages = {
  laptop: '/Images/DataPilot%20AI_%20Navigate%20Your%20Data%20for%20laptop.png',
  monitor: '/Images/DataPilot%20AI%20Futuristic%20Tech%20Wallpaper%20for%20computer.png',
  phone: '/Images/DataPilot%20AI%20Futuristic%20Wave%20Wallpaper%20for%20mobile.png',
};

Object.entries(defaultScreenImages).forEach(([key, url]) => {
  const img = new Image();
  img.onload = () => setScreenSource(key, img);
  img.onerror = () => console.warn(`Could not load default ${key} screen artwork.`);
  img.src = url;
});

/* ------------------------------------------------------------------ controls + camera */
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.rotateSpeed = 0.8;
controls.zoomSpeed = 0.9;
controls.zoomToCursor = true;
controls.screenSpacePanning = true;
controls.minDistance = 1.4;
controls.maxDistance = 26;
controls.maxPolarAngle = Math.PI / 2 - 0.03;     // never go below the floor
controls.autoRotateSpeed = 1.0;

const HOME_TARGET = new THREE.Vector3(-0.2, 1.0, 0);
function homePosition() {
  const aspect = camera.aspect;
  const dist = Math.min(24, 9.8 * Math.max(1, 1.5 / aspect));   // back up on narrow screens
  return new THREE.Vector3(0.12, 0.24, 1).normalize().multiplyScalar(dist).add(HOME_TARGET);
}

/* fly-to animation (used for the intro and Reset) */
let fly = null;
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

function flyTo(toPos, toTarget, duration, spin = 0, from = null) {
  fly = {
    t0: performance.now(), dur: duration * 1000, spin,
    fromPos: from ? from.pos.clone() : camera.position.clone(),
    fromTarget: from ? from.target.clone() : controls.target.clone(),
    toPos: toPos.clone(), toTarget: toTarget.clone(),
  };
  controls.enabled = false;
  controls.autoRotate = false;
  clearTimeout(idleTimer);
}

function stepFly(now) {
  if (!fly) return;
  const t = Math.min(1, (now - fly.t0) / fly.dur);
  const e = ease(t);
  const target = fly.fromTarget.clone().lerp(fly.toTarget, e);
  const pos = fly.fromPos.clone().lerp(fly.toPos, e);
  if (fly.spin) pos.sub(target).applyAxisAngle(THREE.Object3D.DEFAULT_UP, (1 - e) * fly.spin).add(target);
  controls.target.copy(target);
  camera.position.copy(pos);
  camera.lookAt(target);
  if (t >= 1) endFly();
}

function endFly() {
  fly = null;
  controls.enabled = true;
  armIdle();
}

/* any user input interrupts a fly-to and hands control to the user */
['pointerdown', 'wheel', 'touchstart'].forEach((ev) =>
  canvas.addEventListener(ev, () => { if (fly) endFly(); }, { capture: true, passive: true }));

/* auto-rotate after idle */
let autoOn = true;
let idleTimer = 0;
function armIdle() {
  clearTimeout(idleTimer);
  controls.autoRotate = false;
  if (autoOn) idleTimer = setTimeout(() => { controls.autoRotate = true; }, 3500);
}
controls.addEventListener('start', () => { clearTimeout(idleTimer); controls.autoRotate = false; });
controls.addEventListener('end', armIdle);

/* hand cursor feedback */
canvas.addEventListener('pointerdown', () => canvas.classList.add('dragging'));
window.addEventListener('pointerup', () => canvas.classList.remove('dragging'));
window.addEventListener('pointercancel', () => canvas.classList.remove('dragging'));
canvas.addEventListener('pointerdown', () => els.hint.classList.add('hide'), { once: true });
setTimeout(() => els.hint.classList.add('hide'), 9000);

/* ------------------------------------------------------------------ sizing + loop */
function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

// Intro: start tight on the monitor screen, then pull back and settle into the wide shot.
const introFrom = {
  pos: new THREE.Vector3(0.55, 2.0, 2.5),
  target: new THREE.Vector3(0.4, 1.95, -0.3),
};
camera.position.copy(introFrom.pos);
controls.target.copy(introFrom.target);
camera.lookAt(introFrom.target);
flyTo(homePosition(), HOME_TARGET, 3.6, 0.7, introFrom);

let firstFrame = true;
function tick(now) {
  requestAnimationFrame(tick);
  stepFly(now);
  controls.update();
  renderer.render(scene, camera);
  if (firstFrame) {
    firstFrame = false;
    els.loader.classList.add('done');
  }
}
requestAnimationFrame(tick);

/* ------------------------------------------------------------------ UI: toast, buttons */
let toastTimer = 0;
function toast(msg, isError = false) {
  els.toast.textContent = msg;
  els.toast.classList.toggle('error', isError);
  els.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove('show'), 2600);
}

els.reset.addEventListener('click', () => flyTo(homePosition(), HOME_TARGET, 1.2));

els.auto.addEventListener('click', () => {
  autoOn = !autoOn;
  els.auto.setAttribute('aria-pressed', String(autoOn));
  if (autoOn) armIdle(); else { clearTimeout(idleTimer); controls.autoRotate = false; }
});

els.snap.addEventListener('click', () => {
  renderer.render(scene, camera);
  canvas.toBlob((blob) => {
    if (!blob) return toast('Could not capture snapshot.', true);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `device-showcase-${Date.now()}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }, 'image/png');
});

/* ------------------------------------------------------------------ backend integration */
async function api(path, opts) {
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not load image.'));
    img.src = url;
  });
}

async function applyUrl(url) {
  try {
    setAllScreens(await loadImage(url), els.target.value);
  } catch (e) {
    toast(e.message, true);
  }
}

function renderGallery(list) {
  els.gallery.replaceChildren();
  list.forEach(({ id, url }) => {
    const thumb = document.createElement('div');
    thumb.className = 'thumb';
    thumb.tabIndex = 0;
    thumb.setAttribute('role', 'button');
    thumb.setAttribute('aria-label', 'Use this screen');

    const img = document.createElement('img');
    img.src = url; img.alt = ''; img.loading = 'lazy';

    const del = document.createElement('button');
    del.className = 'del'; del.type = 'button'; del.textContent = '×';
    del.setAttribute('aria-label', 'Delete this screen');
    del.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      try { await api(`/api/screens/${id}`, { method: 'DELETE' }); thumb.remove(); }
      catch (e) { toast(e.message, true); }
    });

    thumb.addEventListener('click', () => applyUrl(url));
    thumb.addEventListener('keydown', (ev) => {
      if (ev.target === thumb && (ev.key === 'Enter' || ev.key === ' ')) { ev.preventDefault(); applyUrl(url); }
    });
    thumb.append(img, del);
    els.gallery.append(thumb);
  });
}

async function refreshGallery() {
  try { renderGallery((await api('/api/screens')).screens); } catch { /* backend optional */ }
}

els.file.addEventListener('change', async () => {
  const file = els.file.files[0];
  els.file.value = '';
  if (!file) return;
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) return toast('Please choose a PNG, JPG or WEBP image.', true);
  if (file.size > 10 * 1024 * 1024) return toast('Image is too large (max 10 MB).', true);

  const form = new FormData();
  form.append('image', file);
  try {
    const { url } = await api('/api/upload', { method: 'POST', body: form });
    await applyUrl(url);
    toast('Screen updated');
    refreshGallery();
  } catch (e) {
    toast(e.message, true);
  }
});

refreshGallery();
