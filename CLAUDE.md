# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

The project page for the CoRL 2026 paper *Human2Any: Human-to-Robot Transfer via Constraint-Aware Compositional Planning*. It is a static GitHub Pages site served from the root of `main`. There is no build step, no package manager, no linter and no test suite. Pushing to `main` deploys.

## Running locally

The viewers are ES modules that `fetch()` JSON and PLY files, so `file://` does not work. Serve the repo root over HTTP:

```bash
python3 -m http.server 8765        # then open http://localhost:8765/
google-chrome --headless=new --no-sandbox --disable-gpu --window-size=1600,1000 \
  --screenshot=/tmp/site.png http://localhost:8765/   # quick visual check
```

Regenerate the human-demo viewer data from `human_data/<demo>/vis_data/*.npy` (needs numpy):

```bash
python3 convert_human_data.py      # all demos; also rewrites human_data/manifest.json
```

Passing a single demo dir (`python3 convert_human_data.py human_data/aria1`) also overwrites `manifest.json` with only that demo. Restore the full list afterwards.

## Page structure

- `index.html` is the whole site. Each `<section id=...>` has a matching `<li><a href="#id">` in the fixed `.contents` rail. `static/js/index.js` drives the rail's active state and progress line from those hashes, so a new section needs both entries.
- `static/css/index.css` (adapted from adept-dexterity.github.io) overrides Bulma's typography and colors. Design tokens live on `:root`. Bulma 0.9.4 is still loaded because the viewers use its `button is-small` classes, `is-dark` as the active-button state, and helpers like `has-text-grey`. Viewer layout is mostly inline styles in `index.html`.
- Results, simulation and VLM-planning media are hardcoded `<video>`/`<img>` paths into `real_demos/`, `sim_demos/` and `task_planning/`. The GPT and Opus planning folders use different task names (`hangmugtree` vs `hang_mug`, `pourinbowl` vs `pour`).
- The Video, Code and X Thread hero buttons are inert `<span class="publication-button is-pending">` placeholders. Turn each into an `<a href>` when its URL exists. The meta description and keywords still hold `[TODO]` text.

## Interactive 3D viewers

Three independent ES modules, each one class that owns a Three.js renderer, `OrbitControls`, a render loop and a `_fitCamera()`. Each injects its selector buttons at runtime and uses DOM ids with its own prefix.

Three.js and urdf-loader are vendored under `static/vendor/` and resolved through the `<script type="importmap">` in `index.html`. There is no runtime CDN for viewer code. Only the `controls/`, `lines/` and `loaders/` addons are vendored, so a new Three.js addon import must be copied into `static/vendor/three/examples/jsm/` first.

| Viewer | File | DOM prefix | Data |
|---|---|---|---|
| Planning visualizer | `static/js/robot-viewer.js` | `rv-` | `results/trials.json` |
| Human data | `static/js/human-viewer.js` | `hv-` | `human_data/manifest.json` |
| Diffusion | `static/js/diffusion-viewer.js` | `dv-` | `diffusion/example1/manifest.json` |

**Robot viewer.** `results/trials.json` nests trial → sample. Each trial names a `robot`, a `root` dir, scene PLYs and an optional `rgb.png` overlay. Each sample points at a `trajectory.json` of `{joint_names, frames}` that is fetched lazily and cached. The `ROBOTS` map at the top of the file maps `trial.robot` (`franka`, `rby1`) to a URDF, and `joint_names` must match that URDF's joint names. Scene PLYs are XYZ-only and get a flat color from `SCENE_COLORS` keyed by file basename. Source data is Z-up, so everything is parented to a world group rotated -90° about X. `trials.json` comes from `tools/make_plans.py`, which is gitignored and not in this repo.

**Human viewer.** `manifest.json` is an array of demo dir names. Each demo has `data.json` (output of `convert_human_data.py`: tracks `(T,N,3)`, flat tool/target point clouds, `abs_traj` `(T,4,4)`, optional `pcd_scene`/`pcd_scene_rgb`) plus `test_pred_track.mp4` for the corner overlay. Data is in OpenCV camera frame, so the world group is rotated 180° about X. That puts the capture camera at the origin looking down -Z, which is where the frustum is drawn and where "Camera View" puts the eye.

The inset video is the playback clock: each render frame maps `video.currentTime` to track frame `floor(t·10) − FRAME_OFFSET`. `FRAME_OFFSET = 7` was fitted by projecting the 3D tracks onto the video's rainbow dots, and it holds for all 12 demos, each video having 6 more frames than T. Seeking needs HTTP Range support. `python3 -m http.server` lacks it, so locally the slider snaps the video back to 0. GitHub Pages supports it. The tool cloud is stored at frame 0 and moved rigidly by `abs_traj[t] · inv(abs_traj[0])`. Track colors match the video's CoTracker rainbow (hue by first-frame image row).

**Diffusion viewer.** Two side-by-side panels ("No Steering" vs "Ours") share one slider. `manifest.json` lists `seeds`, `score_min`/`score_max` for color normalization, and per-method success booleans that set the green/red video border. `data_<seed>.json` holds `{no_steer, ours}`, each an array of 20 steps of `{score, trajs}` particles. Slider index 0 shows diffusion step 19 (noisiest). Videos load from `<method>/<seed>/out.mp4`. The per-particle `.npy` files under `<method>/<seed>/steer/` are committed but not read by the page, and no generator script for this data is in the repo.

The inline error handler at the bottom of `index.html` surfaces module-load failures in `rv-status` and `hv-status` only. A diffusion viewer failure shows only in `dv-status` via its own catch.

## Repo gotchas

- `.gitignore` ignores `*.py` and `tools`. `convert_human_data.py` was force-added, so a new tracked script needs `git add -f`.
- All media is committed directly (no Git LFS), about 8k files and a 230 MB `.git`. GitHub rejects any single file over 100 MB.
- The `origin` remote uses the SSH host alias `github-human2any`, which must exist in `~/.ssh/config` for push to work.
