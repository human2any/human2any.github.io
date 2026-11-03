// Human demonstration viewer: replays the 3-D tracks extracted from a human
// video in sync with that video (SpatialTracker-style rainbow trails).
//
// The inset <video> (test_pred_track.mp4) is the clock. Every animation frame
// reads video.currentTime and maps it to a track frame, so play, pause, loop
// and scrubbing all stay in sync without a second timer. If the video is
// missing, an internal clock takes over.
//
// data.json (from convert_human_data.py), all in the OpenCV camera frame:
//   tracks     (T, N, 3)  3-D positions of N tracked points on the tool
//   pcd_tool   flat xyz   tool cloud at frame 0
//   pcd_target flat xyz   target cloud (static)
//   abs_traj   (T, 4, 4)  tool pose; abs_traj[t] · inv(abs_traj[0]) moves pcd_tool
//   pcd_scene, pcd_scene_rgb (optional) dense scene cloud, rgb in 0..255

import * as THREE from 'three';
import { OrbitControls }       from 'three/addons/controls/OrbitControls.js';
import { LineSegments2 }       from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial }        from 'three/addons/lines/LineMaterial.js';

// ── Config ────────────────────────────────────────────────────────────────────
const HUMAN_DATA_ROOT = './human_data/';
const VIDEO_FPS     = 10;   // frame rate of every test_pred_track.mp4
// Video frame k shows track frame k - FRAME_OFFSET. Fitted by projecting the
// 3-D tracks onto the rainbow dots in each video: offset 7, time scale 1.0,
// consistent across all 12 demos.
const FRAME_OFFSET  = 7;
const TRAIL_LEN     = 12;   // frames of history drawn behind each track head
const TRAIL_WIDTH   = 2.5;  // px
const HEAD_SIZE     = 0.018; // world units (m)
const CLOUD_SIZE    = 0.009;
const BG_COLOR      = 0xf0f0f0;
const TOOL_COLOR    = 0xff8c2b; // same tool/target colors as the planning viewer
const TARGET_COLOR  = 0x2bcc63;
const PATH_COLOR    = 0x555555;
// Default view: from behind and above the capture camera (scene space, after
// the CV flip the capture camera looks down -Z).
const FIT_DIRECTION = new THREE.Vector3(0, 0.7, 1);
const FIT_MARGIN    = 1.08;
const SWEEP_AMPLITUDE = THREE.MathUtils.degToRad(40); // ± azimuth of the auto-orbit
const SWEEP_PERIOD  = 16;   // seconds per full left-right-left sweep
const FRUSTUM_DEPTH = 0.07; // m, size of the drawn capture camera
const FRUSTUM_VFOV  = THREE.MathUtils.degToRad(45);
// ─────────────────────────────────────────────────────────────────────────────

const _v = new THREE.Vector3();

// Round sprite for THREE.Points. `ring` adds a dark outline that keeps light
// colors (yellow, green) readable on the light background.
function makeDotTexture(ring) {
  const s = 64;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d');
  g.beginPath();
  g.arc(s / 2, s / 2, s / 2 - 4, 0, Math.PI * 2);
  g.fillStyle = '#ffffff';
  g.fill();
  if (ring) {
    g.lineWidth = 7;
    g.strokeStyle = 'rgba(0,0,0,0.45)';
    g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  // Points are only a few pixels wide; mipmaps would blur the disc's alpha
  // below alphaTest and make small points vanish.
  tex.generateMipmaps = false;
  tex.minFilter = THREE.LinearFilter;
  return tex;
}

// Row-major 4×4 nested array → THREE.Matrix4
function toMatrix4(m) {
  return new THREE.Matrix4().set(...m[0], ...m[1], ...m[2], ...m[3]);
}

class HumanViewer {
  constructor(containerId) {
    this._container = document.getElementById(containerId);
    this._canvas    = this._container.querySelector('canvas');

    this._renderer = new THREE.WebGLRenderer({ canvas: this._canvas, antialias: true });
    this._renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this._renderer.outputColorSpace = THREE.SRGBColorSpace;

    this._scene = new THREE.Scene();
    this._bg = new THREE.Color(BG_COLOR);
    this._scene.background = this._bg;

    this._camera = new THREE.PerspectiveCamera(55, 1, 0.001, 100);
    this._camera.position.set(0.5, 0.5, 1.5);

    this._controls = new OrbitControls(this._camera, this._canvas);
    this._controls.enableDamping = true;
    // Any drag, zoom or pan hands the camera to the user.
    this._controls.addEventListener('start', () => this._setSweep(false));

    this._scene.add(new THREE.AmbientLight(0xffffff, 1.0));

    // CV (Y-down, Z-fwd) → Three.js (Y-up, Z-back). After this flip the
    // capture camera sits at the origin looking down -Z with +Y up, which is
    // exactly the default three.js camera pose.
    this._world = new THREE.Group();
    this._world.rotation.x = Math.PI;
    this._scene.add(this._world);
    this._world.updateMatrixWorld(true);

    this._demoGroup  = null;  // everything rebuilt per demo
    this._trackGroup = null;
    this._trails     = null;
    this._heads      = null;
    this._relGroup   = null;
    this._triad      = null;
    this._pcdGroup   = null;
    this._toolCloud  = null;

    this._show = { tracks: true, rel: true, pcd: true };
    this._fullPaths = false;

    this._data   = null;
    this._T = 0;
    this._N = 0;
    this._frame = -1;
    this._trackColors = null;
    this._toolRel = [];      // abs_traj[t] · inv(abs_traj[0])
    this._poses   = [];      // abs_traj[t]
    this._fitPts  = null;    // scene-space sample of the whole demo
    this._fitBox  = null;    // its bounding box

    this._demos       = [];
    this._demoButtons = [];
    this._activeDemo  = -1;
    this._loadToken   = 0;

    // Auto-orbit: sinusoidal azimuth sweep around the fitted view.
    this._sweep      = true;
    this._sweepBase  = 0;
    this._sweepPhase = 0;
    this._spherical  = new THREE.Spherical();

    // Fallback clock, used only when the video cannot play.
    this._videoFailed     = false;
    this._fallbackPlaying = false;
    this._fallbackPos     = 0;
    this._clock = new THREE.Clock();

    this._elStatus = document.getElementById('hv-status');
    this._elDemos  = document.getElementById('hv-demos');
    this._elVideo  = document.getElementById('hv-video');
    this._elPlay   = document.getElementById('hv-btn-play');
    this._elSlider = document.getElementById('hv-slider');
    this._elLabel  = document.getElementById('hv-frame-label');
    this._elTracks = document.getElementById('hv-btn-tracks');
    this._elFull   = document.getElementById('hv-btn-full');
    this._elRel    = document.getElementById('hv-btn-rel');
    this._elPcd    = document.getElementById('hv-btn-pcd');
    this._elOrbit  = document.getElementById('hv-btn-orbit');

    this._dotTex  = makeDotTexture(false);
    this._headTex = makeDotTexture(true);

    this._resolution = new THREE.Vector2(1, 1);

    // Capture camera: frustum + live video on its image plane. Persistent
    // across demos; rebuilt when the video's aspect ratio becomes known.
    this._camGroup = new THREE.Group();
    this._world.add(this._camGroup);
    this._videoTex = null;
    if (this._elVideo) {
      this._videoTex = new THREE.VideoTexture(this._elVideo);
      this._videoTex.colorSpace = THREE.SRGBColorSpace;
    }
    this._buildFrustum(4 / 3);

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
    } catch (err) {
      this._status(`Error: ${err.message}`, '#c00');
      console.error('[HumanViewer]', err);
    }
  }

  // ── Demo selector ───────────────────────────────────────────────────────────
  _buildDemoButtons() {
    if (!this._elDemos) return;
    this._elDemos.innerHTML = '';

    this._demoButtons = this._demos.map((name, i) => {
      const btn = document.createElement('button');
      btn.className = 'button is-small';
      btn.textContent = name;
      btn.addEventListener('click', () =>
        Promise.resolve(this._selectDemo(i)).catch(e => {
          this._status(`Error: ${e.message}`, '#c00');
          console.error('[HumanViewer]', e);
        }));
      this._elDemos.appendChild(btn);
      return btn;
    });
  }

  async _selectDemo(i) {
    if (i === this._activeDemo) return;
    this._activeDemo = i;
    this._demoButtons.forEach((b, k) => b.classList.toggle('is-dark', k === i));
    const token = ++this._loadToken;

    this._status('Loading…');
    const r = await fetch(`${HUMAN_DATA_ROOT}${this._demos[i]}/data.json`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    if (token !== this._loadToken) return;   // a newer click won the race
    this._data = data;

    this._videoFailed     = false;
    this._fallbackPlaying = false;
    this._fallbackPos     = 0;
    if (this._elVideo) {
      this._elVideo.src = `${HUMAN_DATA_ROOT}${this._demos[i]}/test_pred_track.mp4`;
      this._elVideo.style.display = '';
      this._elVideo.load();
      this._elVideo.play().catch(() => {});
    }

    this._buildScene();
    this._fitCamera();
    if (this._sweep) this._setSweep(true);   // restart the sweep from the new view
    this._syncPlayLabel();
    this._elStatus.style.display = 'none';
  }

  // ── Scene build (once per demo) ─────────────────────────────────────────────
  _clearScene() {
    if (!this._demoGroup) return;
    this._world.remove(this._demoGroup);
    this._demoGroup.traverse(o => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        if (Array.isArray(o.material)) o.material.forEach(m => m.dispose());
        else o.material.dispose();
      }
    });
    this._demoGroup = null;
  }

  _buildScene() {
    this._clearScene();
    const d = this._data;
    this._T = d.num_frames;
    this._N = d.num_tracks;
    this._frame = -1;

    this._poses   = d.abs_traj.map(toMatrix4);
    const inv0    = this._poses[0].clone().invert();
    this._toolRel = this._poses.map(m => m.clone().multiply(inv0));

    this._demoGroup = new THREE.Group();
    this._world.add(this._demoGroup);

    this._buildClouds(d);
    this._buildTracks(d);
    this._buildRelMotion(d);
    this._computeFitBox(d);

    this._trackGroup.visible = this._show.tracks;
    this._relGroup.visible   = this._show.rel;
    this._pcdGroup.visible   = this._show.pcd;

    if (this._elSlider) {
      this._elSlider.max   = Math.max(0, this._T - 1);
      this._elSlider.value = 0;
    }
    this._setFrame(0);
  }

  _makePoints(flat, { color = 0xffffff, rgb = null, size = CLOUD_SIZE, opacity = 1 } = {}) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(flat), 3));
    if (rgb) {
      const cols = new Float32Array(rgb.length);
      const c = new THREE.Color();
      for (let i = 0; i < rgb.length; i += 3) {
        c.setRGB(rgb[i] / 255, rgb[i + 1] / 255, rgb[i + 2] / 255, THREE.SRGBColorSpace);
        cols[i] = c.r; cols[i + 1] = c.g; cols[i + 2] = c.b;
      }
      geo.setAttribute('color', new THREE.BufferAttribute(cols, 3));
    }
    return new THREE.Points(geo, new THREE.PointsMaterial({
      size, sizeAttenuation: true,
      // alphaTest compares after the opacity multiply, so scale it too.
      map: this._dotTex, alphaTest: 0.5 * opacity,
      vertexColors: !!rgb,
      color: rgb ? 0xffffff : color,
      transparent: opacity < 1, opacity, depthWrite: opacity >= 1,
    }));
  }

  _buildClouds(d) {
    this._pcdGroup = new THREE.Group();
    if (d.pcd_scene?.length) {
      this._pcdGroup.add(this._makePoints(d.pcd_scene, {
        rgb: d.pcd_scene_rgb?.length === d.pcd_scene.length ? d.pcd_scene_rgb : null,
        color: 0x9aa0a6, size: CLOUD_SIZE * 0.8,
      }));
    }
    this._pcdGroup.add(this._makePoints(d.pcd_target, { color: TARGET_COLOR, opacity: 0.6 }));
    // Tool cloud is rigidly moved by the tool pose each frame.
    this._toolCloud = this._makePoints(d.pcd_tool, { color: TOOL_COLOR, opacity: 0.55 });
    this._toolCloud.matrixAutoUpdate = false;
    this._pcdGroup.add(this._toolCloud);
    this._demoGroup.add(this._pcdGroup);
  }

  _buildTracks(d) {
    const T = this._T, N = this._N;

    // Identity colors, matching the inset video: CoTracker's rainbow mode
    // colors each track by its image row in the first frame (top = red).
    const rows = d.tracks[0].map(([x, y, z]) => y / z);
    const lo = Math.min(...rows), span = (Math.max(...rows) - lo) || 1;
    this._trackColors = new Float32Array(N * 3);
    const c = new THREE.Color();
    rows.forEach((row, n) => {
      c.setHSL(0.85 * (row - lo) / span, 0.95, 0.47, THREE.SRGBColorSpace);
      this._trackColors.set([c.r, c.g, c.b], n * 3);
    });

    this._trackGroup = new THREE.Group();

    // Trails: one instanced fat-line mesh sized for the full paths, rewritten
    // in place each frame and drawn with instanceCount.
    const maxSeg = N * Math.max(T - 1, 1);
    const geo = new LineSegmentsGeometry();
    geo.setPositions(new Float32Array(maxSeg * 6));
    geo.setColors(new Float32Array(maxSeg * 6));
    geo.instanceCount = 0;
    this._trails = new LineSegments2(geo, new LineMaterial({
      vertexColors: true, linewidth: TRAIL_WIDTH, worldUnits: false,
    }));
    this._trails.material.resolution.copy(this._resolution);
    this._trails.frustumCulled = false;   // bounds change every frame
    this._trackGroup.add(this._trails);

    // Heads: one round sprite per track at its current position.
    const hGeo = new THREE.BufferGeometry();
    hGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
    hGeo.setAttribute('color',    new THREE.BufferAttribute(this._trackColors, 3));
    this._heads = new THREE.Points(hGeo, new THREE.PointsMaterial({
      size: HEAD_SIZE, sizeAttenuation: true, vertexColors: true,
      map: this._headTex, alphaTest: 0.5,
    }));
    this._heads.frustumCulled = false;
    this._trackGroup.add(this._heads);

    this._demoGroup.add(this._trackGroup);
  }

  _buildRelMotion(d) {
    const T = this._T;
    this._relGroup = new THREE.Group();

    // Faint path of the tool origin over the whole demo.
    const pathPos = new Float32Array(T * 3);
    for (let t = 0; t < T; t++) {
      const m = d.abs_traj[t];
      pathPos.set([m[0][3], m[1][3], m[2][3]], t * 3);
    }
    const pathGeo = new THREE.BufferGeometry();
    pathGeo.setAttribute('position', new THREE.BufferAttribute(pathPos, 3));
    this._relGroup.add(new THREE.Line(pathGeo, new THREE.LineBasicMaterial({
      color: PATH_COLOR, transparent: true, opacity: 0.55,
    })));

    // One pose triad that follows abs_traj[t]. Cylinders give real thickness.
    const AXIS_LEN = 0.035;
    const AXIS_RAD = 0.0025;
    this._triad = new THREE.Group();
    this._triad.matrixAutoUpdate = false;
    const yUp  = new THREE.Vector3(0, 1, 0);
    const axes = [
      [new THREE.Vector3(1, 0, 0), 0xff3333],   // X = red
      [new THREE.Vector3(0, 1, 0), 0x33cc33],   // Y = green
      [new THREE.Vector3(0, 0, 1), 0x3399ff],   // Z = blue
    ];
    for (const [dir, color] of axes) {
      const mesh = new THREE.Mesh(
        new THREE.CylinderGeometry(AXIS_RAD, AXIS_RAD, AXIS_LEN, 10, 1),
        new THREE.MeshBasicMaterial({ color }));
      mesh.position.copy(dir).multiplyScalar(AXIS_LEN / 2);
      mesh.quaternion.setFromUnitVectors(yUp, dir);
      this._triad.add(mesh);
    }
    this._relGroup.add(this._triad);

    this._demoGroup.add(this._relGroup);
  }

  // Scene-space sample of everything the demo shows over its whole length
  // (tracks, target, tool cloud along its motion), so framing does not depend
  // on the current frame. Fitting to points rather than box corners keeps the
  // view tight when the data lies along a diagonal.
  _computeFitBox(d) {
    const pts = [];
    const add = (arr, i = 0) => pts.push(new THREE.Vector3().fromArray(arr, i));
    const tStep = Math.max(1, Math.floor(this._T / 12));
    for (let t = 0; t < this._T; t += tStep) for (const p of d.tracks[t]) add(p);
    for (const p of d.tracks[this._T - 1]) add(p);
    for (let i = 0; i < d.pcd_target.length; i += 12) add(d.pcd_target, i);
    for (let t = 0; t < this._T; t += Math.max(1, Math.floor(this._T / 8))) {
      for (let i = 0; i < d.pcd_tool.length; i += 24) {
        pts.push(new THREE.Vector3().fromArray(d.pcd_tool, i).applyMatrix4(this._toolRel[t]));
      }
    }
    const m = this._world.matrixWorld;
    for (const p of pts) p.applyMatrix4(m);
    this._fitPts = pts;
    this._fitBox = new THREE.Box3().setFromPoints(pts);
  }

  // ── Capture camera frustum ──────────────────────────────────────────────────
  _buildFrustum(aspect) {
    for (const o of [...this._camGroup.children]) {
      this._camGroup.remove(o);
      o.geometry.dispose();
      o.material.dispose();
    }
    const z = FRUSTUM_DEPTH;
    const h = z * Math.tan(FRUSTUM_VFOV / 2);
    const w = h * aspect;
    const corners = [[-w, -h, z], [w, -h, z], [w, h, z], [-w, h, z]];
    const pts = [];
    for (let i = 0; i < 4; i++) {
      pts.push(0, 0, 0, ...corners[i]);                    // apex → corner
      pts.push(...corners[i], ...corners[(i + 1) % 4]);    // image-plane edge
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    this._camGroup.add(new THREE.LineSegments(geo,
      new THREE.LineBasicMaterial({ color: 0x333333 })));

    if (this._videoTex) {
      // scale.y = -1 puts the video's top row at camera-frame -y (image up).
      const plane = new THREE.Mesh(
        new THREE.PlaneGeometry(2 * w, 2 * h),
        new THREE.MeshBasicMaterial({ map: this._videoTex, side: THREE.DoubleSide, toneMapped: false }));
      plane.position.set(0, 0, z);
      plane.scale.y = -1;
      this._camGroup.add(plane);
    }
  }

  // ── Per-frame update ────────────────────────────────────────────────────────
  _setFrame(t) {
    if (!this._data) return;
    t = Math.max(0, Math.min(t, this._T - 1));
    if (t === this._frame) return;
    this._frame = t;

    this._updateTracks(t);

    this._toolCloud.matrix.copy(this._toolRel[t]);
    this._toolCloud.matrixWorldNeedsUpdate = true;
    this._triad.matrix.copy(this._poses[t]);
    this._triad.matrixWorldNeedsUpdate = true;

    if (this._elSlider) this._elSlider.value = t;
    if (this._elLabel) this._elLabel.textContent = `${t} / ${Math.max(0, this._T - 1)}`;
  }

  _updateTracks(t) {
    const tracks = this._data.tracks;
    const N = this._N, T = this._T;
    const geo  = this._trails.geometry;
    const P    = geo.attributes.instanceStart.data;
    const C    = geo.attributes.instanceColorStart.data;
    const pos  = P.array, col = C.array;
    const tc   = this._trackColors, bg = this._bg;
    const full = this._fullPaths;
    const K    = TRAIL_LEN;

    // Segment s joins frame s → s+1. Trails show the last K frames up to t;
    // full paths show the whole demo with the future part faded.
    const s0 = full ? 0 : Math.max(0, t - K + 1);
    const s1 = full ? T - 1 : t;
    const weight = f => {
      if (f > t) return 0.22;
      if (full) return 1;
      return Math.max(0.08, 1 - (t - f) / K);
    };

    let k = 0;
    for (let n = 0; n < N; n++) {
      const r = tc[n * 3], g = tc[n * 3 + 1], b = tc[n * 3 + 2];
      for (let s = s0; s < s1; s++) {
        const a = tracks[s][n], e = tracks[s + 1][n];
        const o = k * 6;
        pos[o] = a[0]; pos[o + 1] = a[1]; pos[o + 2] = a[2];
        pos[o + 3] = e[0]; pos[o + 4] = e[1]; pos[o + 5] = e[2];
        const wa = weight(s), we = weight(s + 1);
        col[o]     = bg.r + (r - bg.r) * wa;
        col[o + 1] = bg.g + (g - bg.g) * wa;
        col[o + 2] = bg.b + (b - bg.b) * wa;
        col[o + 3] = bg.r + (r - bg.r) * we;
        col[o + 4] = bg.g + (g - bg.g) * we;
        col[o + 5] = bg.b + (b - bg.b) * we;
        k++;
      }
    }
    geo.instanceCount = k;
    P.needsUpdate = true;
    C.needsUpdate = true;

    const head = this._heads.geometry.attributes.position;
    for (let n = 0; n < N; n++) head.array.set(tracks[t][n], n * 3);
    head.needsUpdate = true;
  }

  // ── Clock ───────────────────────────────────────────────────────────────────
  _hasVideo() {
    const v = this._elVideo;
    return !!v && !this._videoFailed && v.readyState >= 1;
  }

  _currentFrame(dt) {
    if (this._hasVideo()) {
      return Math.floor(this._elVideo.currentTime * VIDEO_FPS + 1e-4) - FRAME_OFFSET;
    }
    if (this._fallbackPlaying) {
      this._fallbackPos = (this._fallbackPos + dt * VIDEO_FPS) % this._T;
    }
    return Math.floor(this._fallbackPos);
  }

  _isPlaying() {
    return this._hasVideo() ? !this._elVideo.paused : this._fallbackPlaying;
  }

  _syncPlayLabel() {
    if (this._elPlay) this._elPlay.textContent = this._isPlaying() ? '⏸ Pause' : '▶ Play';
  }

  _seek(t) {
    if (this._hasVideo()) {
      this._elVideo.pause();
      this._elVideo.currentTime = (t + FRAME_OFFSET + 0.5) / VIDEO_FPS;
    } else {
      this._fallbackPlaying = false;
      this._fallbackPos = t;
    }
    this._setFrame(t);
    this._syncPlayLabel();
  }

  // ── Camera ──────────────────────────────────────────────────────────────────
  // Frame the demo from behind and above the capture camera, at the distance
  // where every fit point stays inside both the horizontal and vertical field
  // of view for every azimuth the auto-orbit sweep will reach.
  _fitCamera() {
    if (!this._fitPts?.length) return;
    const center = this._fitBox.getCenter(new THREE.Vector3());
    const tanV   = Math.tan(THREE.MathUtils.degToRad(this._camera.fov) / 2);
    const tanH   = tanV * this._camera.aspect;
    const base   = new THREE.Spherical().setFromVector3(FIT_DIRECTION);
    const rel    = this._fitPts.map(p => p.clone().sub(center));

    const dir = new THREE.Vector3(), right = new THREE.Vector3(), up = new THREE.Vector3();
    let dist = 0;
    for (let k = 0; k <= 8; k++) {
      const s = base.clone();
      s.theta += SWEEP_AMPLITUDE * (k / 4 - 1);
      dir.setFromSpherical(s).normalize();          // center → eye
      right.crossVectors(THREE.Object3D.DEFAULT_UP, dir).normalize();
      up.crossVectors(dir, right);
      for (const c of rel) {
        const toward = c.dot(dir);                   // point's offset toward the eye
        dist = Math.max(dist,
          toward + Math.abs(c.dot(right)) / tanH,
          toward + Math.abs(c.dot(up))    / tanV);
      }
    }
    this._camera.position.copy(center).add(
      dir.setFromSpherical(base).normalize().multiplyScalar(dist * FIT_MARGIN));
    this._controls.target.copy(center);
    this._controls.update();
  }

  // Put the eye at the capture camera so the 3-D view has the same
  // perspective as the inset video. It looks at the demo's center rather than
  // down the optical axis because the videos are cropped off-center (the Aria
  // principal point sits about 24 px from the top edge).
  _cameraView() {
    if (!this._fitBox) return;
    this._setSweep(false);
    this._camera.position.set(0, 0, 0);
    this._fitBox.getCenter(this._controls.target);
    this._controls.update();
  }

  _setSweep(on) {
    this._sweep = on;
    if (on) {
      this._spherical.setFromVector3(_v.subVectors(this._camera.position, this._controls.target));
      this._sweepBase  = this._spherical.theta;
      this._sweepPhase = 0;
    }
    if (this._elOrbit) this._elOrbit.textContent = on ? 'Stop Orbit' : 'Orbit';
  }

  _applySweep(dt) {
    this._sweepPhase += dt * 2 * Math.PI / SWEEP_PERIOD;
    const target = this._controls.target;
    this._spherical.setFromVector3(_v.subVectors(this._camera.position, target));
    this._spherical.theta = this._sweepBase + SWEEP_AMPLITUDE * Math.sin(this._sweepPhase);
    this._camera.position.copy(target).add(_v.setFromSpherical(this._spherical));
  }

  // ── UI bindings ─────────────────────────────────────────────────────────────
  _bindUI() {
    const v = this._elVideo;
    if (v) {
      v.addEventListener('play',  () => this._syncPlayLabel());
      v.addEventListener('pause', () => this._syncPlayLabel());
      v.addEventListener('loadedmetadata', () => {
        if (v.videoWidth && v.videoHeight) this._buildFrustum(v.videoWidth / v.videoHeight);
        this._syncPlayLabel();
      });
      v.addEventListener('error', () => {
        if (!v.getAttribute('src')) return;
        this._videoFailed = true;
        this._fallbackPlaying = true;
        v.style.display = 'none';
        this._syncPlayLabel();
      });
    }

    this._elPlay?.addEventListener('click', () => {
      if (this._hasVideo()) {
        if (v.paused) v.play().catch(() => {});
        else v.pause();
      } else {
        this._fallbackPlaying = !this._fallbackPlaying;
        this._syncPlayLabel();
      }
    });

    this._elSlider?.addEventListener('input', e => this._seek(+e.target.value));

    this._elTracks?.addEventListener('click', e => {
      this._show.tracks = !this._show.tracks;
      if (this._trackGroup) this._trackGroup.visible = this._show.tracks;
      e.currentTarget.textContent = this._show.tracks ? 'Hide Tracks' : 'Show Tracks';
    });

    this._elFull?.addEventListener('click', e => {
      this._fullPaths = !this._fullPaths;
      e.currentTarget.textContent = this._fullPaths ? 'Short Trails' : 'Full Paths';
      if (this._data) this._updateTracks(Math.max(this._frame, 0));
    });

    this._elRel?.addEventListener('click', e => {
      this._show.rel = !this._show.rel;
      if (this._relGroup) this._relGroup.visible = this._show.rel;
      e.currentTarget.textContent = this._show.rel ? 'Hide Rel Motion' : 'Show Rel Motion';
    });

    this._elPcd?.addEventListener('click', e => {
      this._show.pcd = !this._show.pcd;
      if (this._pcdGroup) this._pcdGroup.visible = this._show.pcd;
      e.currentTarget.textContent = this._show.pcd ? 'Hide Cloud' : 'Show Cloud';
    });

    document.getElementById('hv-btn-camview')?.addEventListener('click', () => this._cameraView());
    this._elOrbit?.addEventListener('click', () => this._setSweep(!this._sweep));
    document.getElementById('hv-btn-fit')?.addEventListener('click', () => {
      this._fitCamera();
      if (this._sweep) this._setSweep(true);
    });
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
    this._resolution.set(w, h);
    this._trails?.material.resolution.set(w, h);
  }

  _renderLoop() {
    requestAnimationFrame(() => this._renderLoop());
    const dt = Math.min(this._clock.getDelta(), 0.1);
    if (this._data) this._setFrame(this._currentFrame(dt));
    if (this._sweep && this._fitBox) this._applySweep(dt);
    // Hide the drawn camera when the eye is inside it (Camera View).
    this._camGroup.visible = this._camera.position.length() > FRUSTUM_DEPTH * 2.5;
    this._controls.update();
    this._renderer.render(this._scene, this._camera);
  }
}

new HumanViewer('hv-container').load();
