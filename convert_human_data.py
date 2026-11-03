#!/usr/bin/env python3
"""
Convert human_data/<demo>/vis_data/ → human_data/<demo>/data.json for the web viewer.

Expected files in vis_data/:
  pts3d_viz.npy       (T, N, 3)  – 3-D track positions, camera space
  smooth_abs_traj.npy (T, 4, 4)  – absolute tool trajectory (SE3 matrices)
  tool_pts.npy        (M, 3)     – tool object point cloud
  target_pts.npy      (M, 3)     – target object point cloud

Optional (drawn by the viewer as a background scene cloud when present):
  scene_pts.npy       (S, 3)     – dense scene point cloud, same camera frame
  scene_rgb.npy       (S, 3)     – its colors, uint8 0-255 or float 0-1

Usage:
  python3 convert_human_data.py                  # converts all human_data/* dirs
  python3 convert_human_data.py human_data/aria_1
"""
import numpy as np
import json
import os
import sys
import glob


def convert_demo(demo_dir):
    vd       = os.path.join(demo_dir, 'vis_data')
    out_path = os.path.join(demo_dir, 'data.json')

    tracks    = np.load(os.path.join(vd, 'pts3d_viz.npy'))       # (T, N, 3)
    abs_traj  = np.load(os.path.join(vd, 'smooth_abs_traj.npy')) # (T, 4, 4)
    tool_pts  = np.load(os.path.join(vd, 'tool_pts.npy'))        # (M, 3)
    tgt_pts   = np.load(os.path.join(vd, 'target_pts.npy'))      # (M, 3)

    T, N, _ = tracks.shape

    out = {
        "num_frames": int(T),
        "num_tracks": int(N),
        "tracks":    np.round(tracks.astype(np.float64), 5).tolist(),        # (T, N, 3)
        "pcd_tool":  np.round(tool_pts.ravel().astype(np.float64), 3).tolist(),  # flat [x,y,z,...]
        "pcd_target": np.round(tgt_pts.ravel().astype(np.float64), 3).tolist(),  # flat [x,y,z,...]
        "abs_traj":  np.round(abs_traj.astype(np.float64), 6).tolist(),      # (T, 4, 4)
    }

    scene_path = os.path.join(vd, 'scene_pts.npy')
    if os.path.isfile(scene_path):
        scene = np.load(scene_path)                                          # (S, 3)
        out["pcd_scene"] = np.round(scene.ravel().astype(np.float64), 3).tolist()
        rgb_path = os.path.join(vd, 'scene_rgb.npy')
        if os.path.isfile(rgb_path):
            rgb = np.load(rgb_path).astype(np.float64)                       # (S, 3)
            if rgb.max() <= 1.0:
                rgb = rgb * 255.0
            out["pcd_scene_rgb"] = np.clip(np.round(rgb), 0, 255).astype(int).ravel().tolist()

    with open(out_path, 'w') as f:
        json.dump(out, f, separators=(',', ':'))

    mb = os.path.getsize(out_path) / 1e6
    print(f'  {out_path}  ({mb:.1f} MB)  T={T}  N={N}  tool_pts={len(tool_pts)}  target_pts={len(tgt_pts)}')


def main():
    demo_dirs = sys.argv[1:] if len(sys.argv) > 1 else sorted(glob.glob('human_data/*'))
    if not demo_dirs:
        print('No demo dirs found.'); sys.exit(1)

    names = []
    for d in demo_dirs:
        vd = os.path.join(d, 'vis_data')
        if os.path.isdir(vd) and os.path.isfile(os.path.join(vd, 'pts3d_viz.npy')):
            print(f'Converting {d} …')
            convert_demo(d)
            names.append(os.path.basename(d))
        else:
            print(f'  skip {d} (no vis_data/pts3d_viz.npy)')

    manifest = 'human_data/manifest.json'
    with open(manifest, 'w') as f:
        json.dump(names, f)
    print(f'Manifest: {manifest}  {names}')


if __name__ == '__main__':
    main()
