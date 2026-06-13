import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { PLYLoader }     from 'three/addons/loaders/PLYLoader.js';

const DIFFUSION_ROOT = './diffusion/example1/';
const NUM_STEPS      = 20;   // slider 0 (noisiest) → 19 (cleanest)

// ── Utility: score [0,1] → THREE.Color red→green ─────────────────────────────
function scoreColor(t) {
  return new THREE.Color().setHSL(t * 0.33, 1.0, 0.5);
}

// ── Single panel: scene + trajectories ───────────────────────────────────────
class DiffPanel {
  constructor(containerId) {
    this._container = document.getElementById(containerId);
    this._canvas    = this._container.querySelector('canvas');

    this._renderer = new THREE.WebGLRenderer({ canvas: this._canvas, antialias: true });
    this._renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this._renderer.outputColorSpace = THREE.SRGBColorSpace;

    this._scene = new THREE.Scene();
    this._scene.background = new THREE.Color(0xf5f5f5);

    this._camera = new THREE.PerspectiveCamera(55, 1, 0.001, 100);
    this._camera.position.set(0, 0.5, 1.5);

    this._controls = new OrbitControls(this._camera, this._canvas);
    this._controls.enableDamping = true;

    this._scene.add(new THREE.AmbientLight(0xffffff, 1.0));

    this._trajGroup = new THREE.Group();
    this._scene.add(this._trajGroup);

    this._pcdLoaded  = false;
    this._data       = null;   // reference to method's steps array
    this._scoreMin   = 0;
    this._scoreMax   = 1;

    window.addEventListener('resize', () => this._resize());
    this._resize();
    this._renderLoop();
  }

  // Load shared scene PLY (call once)
  async loadScene(url) {
    return new Promise((resolve, reject) => {
      new PLYLoader().load(url, geo => {
        const hasColor = geo.hasAttribute('color');
        const pts = new THREE.Points(geo, new THREE.PointsMaterial({
          size: 0.004, sizeAttenuation: true,
          vertexColors: hasColor,
          color: hasColor ? 0xffffff : 0x9aa0a6,
        }));
        this._scene.add(pts);
        this._pcdLoaded = true;
        resolve();
      }, undefined, reject);
    });
  }

  setData(stepsArray, scoreMin, scoreMax) {
    this._data     = stepsArray;
    this._scoreMin = scoreMin;
    this._scoreMax = scoreMax;
  }

  setStep(sliderIdx) {
    if (!this._data) return;
    // Clear previous trajectories
    for (const obj of [...this._trajGroup.children]) {
      this._trajGroup.remove(obj);
      obj.traverse(o => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) o.material.dispose();
      });
    }

    const particles = this._data[sliderIdx];
    const range = this._scoreMax - this._scoreMin || 1;

    for (const { score, trajs } of particles) {
      const t = (score - this._scoreMin) / range;
      const col = scoreColor(t);
      const mat = new THREE.LineBasicMaterial({ color: col, transparent: true, opacity: 0.75 });

      for (const traj of trajs) {
        if (traj.length < 2) continue;
        const pos = new Float32Array(traj.length * 3);
        traj.forEach(([x, y, z], i) => { pos[i*3]=x; pos[i*3+1]=y; pos[i*3+2]=z; });
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        this._trajGroup.add(new THREE.Line(geo, mat));
      }
    }
  }

  fitCamera() {
    this._scene.updateMatrixWorld(true);
    const box = new THREE.Box3();
    this._scene.traverseVisible(obj => {
      if (obj.isMesh || obj.isPoints || obj.isLine) box.expandByObject(obj);
    });
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const radius = box.getSize(new THREE.Vector3()).length() * 0.8;
    this._camera.position.copy(center).addScaledVector(
      new THREE.Vector3(0.3, 0.55, 1).normalize(), radius * 1.45
    );
    this._controls.target.copy(center);
    this._controls.update();
  }

  _resize() {
    const w = this._container.clientWidth;
    const h = this._container.clientHeight;
    this._renderer.setSize(w, h, false);
    this._camera.aspect = w / h;
    this._camera.updateProjectionMatrix();
  }

  _renderLoop() {
    requestAnimationFrame(() => this._renderLoop());
    this._controls.update();
    this._renderer.render(this._scene, this._camera);
  }
}

// ── Shared controller ─────────────────────────────────────────────────────────
class DiffusionViewer {
  constructor() {
    this._left    = new DiffPanel('dv-left');
    this._right   = new DiffPanel('dv-right');
    this._slider  = document.getElementById('dv-slider');
    this._label   = document.getElementById('dv-step-label');
    this._step    = 0;

    this._slider?.addEventListener('input', e => {
      this._setStep(+e.target.value);
    });
    document.getElementById('dv-btn-fit')?.addEventListener('click', () => {
      this._left.fitCamera();
      this._right.fitCamera();
    });
  }

  async load() {
    const statusEl = document.getElementById('dv-status');
    try {
      if (statusEl) { statusEl.textContent = 'Loading…'; statusEl.style.display = ''; }

      const resp = await fetch(DIFFUSION_ROOT + 'data.json');
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();

      const sceneUrl = DIFFUSION_ROOT + 'scene/init.ply';
      await Promise.all([
        this._left.loadScene(sceneUrl),
        this._right.loadScene(sceneUrl),
      ]);

      this._left.setData(data.rej_samp, data.score_min, data.score_max);
      this._right.setData(data.ours,    data.score_min, data.score_max);

      if (statusEl) statusEl.style.display = 'none';

      this._setStep(0);
      this._left.fitCamera();
      this._right.fitCamera();
    } catch (err) {
      if (statusEl) { statusEl.textContent = `Error: ${err.message}`; statusEl.style.color = '#c00'; }
      console.error('[DiffusionViewer]', err);
    }
  }

  _setStep(idx) {
    this._step = idx;
    if (this._slider) this._slider.value = idx;
    // slider 0 = noisiest = diffusion step 19, slider 19 = cleanest = step 0
    const diffStep = NUM_STEPS - 1 - idx;
    if (this._label) this._label.textContent = `Diffusion Step: ${diffStep}`;
    this._left.setStep(idx);
    this._right.setStep(idx);
  }
}

new DiffusionViewer().load();
