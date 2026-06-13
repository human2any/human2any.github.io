import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const HUMAN_DATA_ROOT = './human_data/';

class HumanViewer {
  constructor(containerId) {
    this._container = document.getElementById(containerId);
    this._canvas    = this._container.querySelector('canvas');

    this._renderer = new THREE.WebGLRenderer({ canvas: this._canvas, antialias: true });
    this._renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this._renderer.outputColorSpace = THREE.SRGBColorSpace;

    this._scene = new THREE.Scene();
    this._scene.background = new THREE.Color(0xffffff);

    this._camera = new THREE.PerspectiveCamera(55, 1, 0.001, 100);
    this._camera.position.set(0.5, 0.5, 1.5);

    this._controls = new OrbitControls(this._camera, this._canvas);
    this._controls.enableDamping = true;

    this._scene.add(new THREE.AmbientLight(0xffffff, 1.0));

    // CV (Y-down, Z-fwd) → Three.js (Y-up, Z-back)
    this._world = new THREE.Group();
    this._world.rotation.x = Math.PI;
    this._scene.add(this._world);

    this._trackGroup  = null;
    this._trackLines  = [];
    this._relGroup    = null;
    this._pathLine    = null;
    this._pcdGroup    = null;

    this._data    = null;

    this._demos        = [];
    this._demoButtons  = [];
    this._activeDemo   = -1;

    this._elStatus = document.getElementById('hv-status');
    this._elDemos  = document.getElementById('hv-demos');
    this._elTracks = document.getElementById('hv-btn-tracks');
    this._elRel    = document.getElementById('hv-btn-rel');
    this._elPcd    = document.getElementById('hv-btn-pcd');
    this._elVideo  = document.getElementById('hv-video');

    this._bindUI();
    this._resize();
    window.addEventListener('resize', () => this._resize());
    this._renderLoop();
  }

  // ── Public entry point ──────────────────────────────────────────────────────
  async load() {
    try {
      this._status('Loading…');
      const r = await fetch(HUMAN_DATA_ROOT + 'manifest.json');
      this._demos = r.ok ? await r.json() : ['demo_0001'];
      this._buildDemoButtons();
      await this._selectDemo(0);
      this._elStatus.style.display = 'none';
    } catch (err) {
      this._status(`Error: ${err.message}`, '#c00');
      console.error('[HumanViewer]', err);
    }
  }

  // ── Demo selector ───────────────────────────────────────────────────────────
  _buildDemoButtons() {
    if (!this._elDemos) return;
    this._elDemos.innerHTML = '';
    const lbl = document.createElement('span');
    lbl.textContent = 'Demo:';
    lbl.className = 'is-size-7 has-text-grey';
    lbl.style.marginRight = '.15rem';
    this._elDemos.appendChild(lbl);

    this._demoButtons = this._demos.map((name, i) => {
      const btn = document.createElement('button');
      btn.className = 'button is-small';
      btn.textContent = name;
      btn.addEventListener('click', () =>
        Promise.resolve(this._selectDemo(i)).catch(e =>
          this._status(`Error: ${e.message}`, '#c00')));
      this._elDemos.appendChild(btn);
      return btn;
    });
  }

  async _selectDemo(i) {
    if (i === this._activeDemo) return;
    this._activeDemo = i;
    this._demoButtons.forEach((b, k) => b.classList.toggle('is-dark', k === i));

    this._status('Loading…');
    const r = await fetch(`${HUMAN_DATA_ROOT}${this._demos[i]}/data.json`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    this._data = await r.json();

    if (this._elVideo) {
      this._elVideo.src = `${HUMAN_DATA_ROOT}${this._demos[i]}/test_pred_track.mp4`;
      this._elVideo.style.display = '';
      this._elVideo.load();
      this._elVideo.play().catch(() => {});
    }

    this._buildScene();
    this._fitCamera();
    this._elStatus.style.display = 'none';
  }

  // ── Scene build (called once per demo load) ─────────────────────────────────
  _clearScene() {
    for (const obj of [...this._world.children]) {
      this._world.remove(obj);
      obj.traverse(o => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) {
          if (Array.isArray(o.material)) o.material.forEach(m => m.dispose());
          else o.material.dispose();
        }
      });
    }
    this._trackGroup = null;
    this._trackLines = [];
    this._relGroup   = null;
    this._pathLine   = null;
    this._pcdGroup   = null;
  }

  _buildScene() {
    this._clearScene();
    const d = this._data;
    const T = d.num_frames;
    const N = d.num_tracks;

    // Per-time-step colours: HSV(t/(T-1),1,1) = HSL(t/(T-1),1,0.5) in Three.js
    const timeColors = Array.from({ length: T }, (_, t) =>
      new THREE.Color().setHSL(t / Math.max(T - 1, 1), 1.0, 0.5)
    );

    // ── Point cloud (static, grey) ──────────────────────────────────────────
    this._pcdGroup = new THREE.Group();
    const pcdGeo = new THREE.BufferGeometry();
    pcdGeo.setAttribute('position',
      new THREE.BufferAttribute(new Float32Array(d.pcd), 3));
    this._pcdGroup.add(new THREE.Points(
      pcdGeo,
      new THREE.PointsMaterial({ size: 0.008, color: 0x939393, sizeAttenuation: true })
    ));
    this._world.add(this._pcdGroup);

    // ── Track lines — full rainbow paths, always visible ──────────────────
    this._trackGroup = new THREE.Group();
    this._trackLines = [];
    for (let n = 0; n < N; n++) {
      const pos = new Float32Array(T * 3);
      const col = new Float32Array(T * 3);
      for (let t = 0; t < T; t++) {
        const [lx, ly, lz] = d.tracks[t][n];
        pos[t*3]=lx; pos[t*3+1]=ly; pos[t*3+2]=lz;
        col[t*3]=timeColors[t].r; col[t*3+1]=timeColors[t].g; col[t*3+2]=timeColors[t].b;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('color',    new THREE.BufferAttribute(col, 3));
      const line = new THREE.Line(geo,
        new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.85 }));
      this._trackGroup.add(line);
      this._trackLines.push(line);
    }
    this._world.add(this._trackGroup);

    // ── Absolute trajectory path from abs_traj[:, :3, 3] ───────────────────
    this._relGroup = new THREE.Group();
    const pathPos = new Float32Array(T * 3);
    const pathCol = new Float32Array(T * 3);
    for (let t = 0; t < T; t++) {
      const m = d.abs_traj[t];
      pathPos[t*3]=m[0][3]; pathPos[t*3+1]=m[1][3]; pathPos[t*3+2]=m[2][3];
      const c = timeColors[t];
      pathCol[t*3]=c.r; pathCol[t*3+1]=c.g; pathCol[t*3+2]=c.b;
    }
    const pathGeo = new THREE.BufferGeometry();
    pathGeo.setAttribute('position', new THREE.BufferAttribute(pathPos, 3));
    pathGeo.setAttribute('color',    new THREE.BufferAttribute(pathCol, 3));
    this._pathLine = new THREE.Line(pathGeo,
      new THREE.LineBasicMaterial({ vertexColors: true, linewidth: 2 }));
    this._relGroup.add(this._pathLine);

    // Pose frames: cylinder-based axes (supports real thickness unlike AxesHelper)
    const AXIS_LEN = 0.022;
    const AXIS_RAD = 0.003;
    const cylGeo   = new THREE.CylinderGeometry(AXIS_RAD, AXIS_RAD, AXIS_LEN, 8, 1);
    const yUp      = new THREE.Vector3(0, 1, 0);
    const axColors = [0xff3333, 0x33cc33, 0x3399ff]; // X=red, Y=green, Z=blue
    const axMats   = axColors.map(c => new THREE.MeshBasicMaterial({ color: c }));

    const stride = Math.max(1, Math.round(T / 20));
    const frameSet = new Set();
    for (let t = 0; t < T; t += stride) frameSet.add(t);
    frameSet.add(T - 1);

    for (const t of frameSet) {
      const m = d.abs_traj[t];
      const pos = new THREE.Vector3(m[0][3], m[1][3], m[2][3]);
      // Local X, Y, Z column vectors of the rotation matrix
      const cols = [
        new THREE.Vector3(m[0][0], m[1][0], m[2][0]),
        new THREE.Vector3(m[0][1], m[1][1], m[2][1]),
        new THREE.Vector3(m[0][2], m[1][2], m[2][2]),
      ];
      for (let a = 0; a < 3; a++) {
        const mesh = new THREE.Mesh(cylGeo, axMats[a]);
        mesh.position.copy(pos).addScaledVector(cols[a], AXIS_LEN / 2);
        mesh.quaternion.setFromUnitVectors(yUp, cols[a]);
        this._relGroup.add(mesh);
      }
    }

    this._world.add(this._relGroup);

    // Reset toggle button labels
    if (this._elTracks) this._elTracks.textContent = 'Hide Tracks';
    if (this._elRel)    this._elRel.textContent    = 'Hide Rel Motion';
    if (this._elPcd)    this._elPcd.textContent    = 'Hide Cloud';
  }

  // ── Camera fit ──────────────────────────────────────────────────────────────
  _fitCamera() {
    if (!this._data) return;
    this._scene.updateMatrixWorld(true);
    const box = new THREE.Box3();
    this._scene.traverseVisible(obj => {
      if (obj.isMesh || obj.isPoints) box.expandByObject(obj);
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

  // ── UI bindings ─────────────────────────────────────────────────────────────
  _bindUI() {
    this._elTracks?.addEventListener('click', e => {
      if (!this._trackGroup) return;
      this._trackGroup.visible = !this._trackGroup.visible;
      e.target.textContent = this._trackGroup.visible ? 'Hide Tracks' : 'Show Tracks';
    });

    this._elRel?.addEventListener('click', e => {
      if (!this._relGroup) return;
      this._relGroup.visible = !this._relGroup.visible;
      e.target.textContent = this._relGroup.visible ? 'Hide Rel Motion' : 'Show Rel Motion';
    });

    this._elPcd?.addEventListener('click', e => {
      if (!this._pcdGroup) return;
      this._pcdGroup.visible = !this._pcdGroup.visible;
      e.target.textContent = this._pcdGroup.visible ? 'Hide Cloud' : 'Show Cloud';
    });

    document.getElementById('hv-btn-fit')?.addEventListener('click', () => this._fitCamera());
  }

  _status(msg, color = '#555') {
    if (!this._elStatus) return;
    this._elStatus.textContent   = msg;
    this._elStatus.style.color   = color;
    this._elStatus.style.display = '';
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

new HumanViewer('hv-container').load();
