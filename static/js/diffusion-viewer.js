import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { PLYLoader }     from 'three/addons/loaders/PLYLoader.js';
import { Line2 }         from 'three/addons/lines/Line2.js';
import { LineGeometry }  from 'three/addons/lines/LineGeometry.js';
import { LineMaterial }  from 'three/addons/lines/LineMaterial.js';

const DIFFUSION_ROOT = './diffusion/example1/';
const NUM_STEPS      = 20;
const LINE_WIDTH     = 2.5;
const SUCCESS_COLOR  = '#2bcc63';
const FAIL_COLOR     = '#e03333';

function scoreColor(t) {
  return new THREE.Color().setHSL(t * 0.33, 1.0, 0.5);
}

// ── Single 3-D panel ──────────────────────────────────────────────────────────
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

    this._resolution = new THREE.Vector2(
      this._container.clientWidth, this._container.clientHeight
    );

    this._data     = null;
    this._scoreMin = 0;
    this._scoreMax = 1;

    window.addEventListener('resize', () => this._resize());
    this._resize();
    this._renderLoop();
  }

  async loadScene(url) {
    return new Promise((resolve, reject) => {
      new PLYLoader().load(url, geo => {
        const hasColor = geo.hasAttribute('color');
        this._scene.add(new THREE.Points(geo, new THREE.PointsMaterial({
          size: 0.004, sizeAttenuation: true,
          vertexColors: hasColor,
          color: hasColor ? 0xffffff : 0x9aa0a6,
        })));
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
      const t   = (score - this._scoreMin) / range;
      const col = scoreColor(t);
      for (const traj of trajs) {
        if (traj.length < 2) continue;
        const flat = new Float32Array(traj.length * 3);
        traj.forEach(([x, y, z], i) => { flat[i*3]=x; flat[i*3+1]=y; flat[i*3+2]=z; });
        const geo = new LineGeometry();
        geo.setPositions(flat);
        const mat = new LineMaterial({
          color: col.getHex(), linewidth: LINE_WIDTH,
          resolution: this._resolution, transparent: true, opacity: 0.8,
        });
        this._trajGroup.add(new Line2(geo, mat));
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
    this._resolution.set(w, h);
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
    this._left       = new DiffPanel('dv-left');
    this._right      = new DiffPanel('dv-right');
    this._slider     = document.getElementById('dv-slider');
    this._label      = document.getElementById('dv-step-label');
    this._videoLeft  = document.getElementById('dv-video-left');
    this._videoRight = document.getElementById('dv-video-right');
    this._elSeeds    = document.getElementById('dv-seeds');
    this._seedBtns   = [];
    this._activeSeed = null;
    this._seedCache  = {};   // seed key → loaded data object
    this._manifest   = null;
    this._currentStep = 0;

    this._slider?.addEventListener('input', e => this._setStep(+e.target.value));
    document.getElementById('dv-btn-fit')?.addEventListener('click', () => {
      this._left.fitCamera();
      this._right.fitCamera();
    });
  }

  async load() {
    const statusEl = document.getElementById('dv-status');
    try {
      if (statusEl) { statusEl.textContent = 'Loading…'; statusEl.style.display = ''; }

      // Load manifest
      const mResp = await fetch(DIFFUSION_ROOT + 'manifest.json');
      if (!mResp.ok) throw new Error(`HTTP ${mResp.status} fetching manifest`);
      this._manifest = await mResp.json();

      // Load shared scene PLY
      const sceneUrl = DIFFUSION_ROOT + 'scene.ply';
      await Promise.all([
        this._left.loadScene(sceneUrl),
        this._right.loadScene(sceneUrl),
      ]);

      this._buildSeedButtons();
      if (statusEl) statusEl.style.display = 'none';

      await this._setSeed(this._manifest.seeds[0]);
      this._left.fitCamera();
      this._right.fitCamera();
    } catch (err) {
      if (statusEl) { statusEl.textContent = `Error: ${err.message}`; statusEl.style.color = '#c00'; }
      console.error('[DiffusionViewer]', err);
    }
  }

  _buildSeedButtons() {
    if (!this._elSeeds || !this._manifest) return;
    this._elSeeds.innerHTML = '';
    const lbl = document.createElement('span');
    lbl.textContent = 'Seed:';
    lbl.className = 'is-size-7 has-text-grey';
    lbl.style.marginRight = '.15rem';
    this._elSeeds.appendChild(lbl);

    this._seedBtns = this._manifest.seeds.map((seed, i) => {
      const btn = document.createElement('button');
      btn.className = 'button is-small';
      btn.textContent = i;
      btn.addEventListener('click', () =>
        this._setSeed(seed).catch(e => console.error('[DiffusionViewer]', e))
      );
      this._elSeeds.appendChild(btn);
      return btn;
    });
  }

  async _setSeed(seed) {
    if (seed === this._activeSeed) return;
    this._activeSeed = seed;
    const idx = this._manifest.seeds.indexOf(seed);
    this._seedBtns.forEach((b, k) => b.classList.toggle('is-dark', k === idx));

    // Lazy-load per-seed data
    if (!this._seedCache[seed]) {
      const r = await fetch(`${DIFFUSION_ROOT}data_${seed}.json`);
      if (!r.ok) throw new Error(`HTTP ${r.status} loading data_${seed}.json`);
      this._seedCache[seed] = await r.json();
    }
    const data = this._seedCache[seed];
    const { score_min, score_max } = this._manifest;

    this._left.setData(data.no_steer, score_min, score_max);
    this._right.setData(data.ours,    score_min, score_max);
    this._setStep(this._currentStep, true);

    // Update videos with success/fail borders
    const results = this._manifest.results;
    const setVideo = (el, method) => {
      el.src = `${DIFFUSION_ROOT}${method}/${seed}/out.mp4`;
      el.style.display = '';
      const success = results?.[method]?.[seed];
      el.style.borderColor = success ? SUCCESS_COLOR : FAIL_COLOR;
      el.load();
      el.play().catch(() => {});
    };
    if (this._videoLeft)  setVideo(this._videoLeft,  'no_steer');
    if (this._videoRight) setVideo(this._videoRight, 'ours');
  }

  _setStep(idx, force = false) {
    if (idx === this._currentStep && !force) return;
    this._currentStep = idx;
    if (this._slider) this._slider.value = idx;
    const diffStep = NUM_STEPS - 1 - idx;
    if (this._label) this._label.textContent = `Diffusion Step: ${diffStep}`;
    this._left.setStep(idx);
    this._right.setStep(idx);
  }
}

new DiffusionViewer().load();
