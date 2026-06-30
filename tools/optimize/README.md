# Mesh optimization pipeline

The source scans are very large (binary STL meshes up to ~1 GB / 21 M triangles,
and a 137 MB anatomy GLB). These scripts decimate and Draco-compress them into the
few-hundred-KB GLBs in [`../../optimized/`](../../optimized) that ship with the app.

## Setup

```bash
npm install -g @gltf-transform/cli   # provides `gltf-transform`
npm install                          # @gltf-transform/core for the STL converter
```

## Segmented STL layers

`optimize.sh` runs: **STL → GLB → weld → simplify → Draco**.

```bash
# 1 GB / 21M-triangle eye shell -> ~320k triangles (~0.6 MB)
./optimize.sh original/eye.stl     ../../optimized/sample_1_seg_mesh/eye.glb     0.015
# 156 MB / 3.1M-triangle feature   -> ~190k triangles (~0.3 MB)
./optimize.sh original/feature.stl ../../optimized/sample_1_seg_mesh/feature.glb 0.06
```

Normals are intentionally dropped and recomputed in the browser after decimation.

## Anatomy GLB

The anatomy model is texture-dominated, so geometry simplification is disabled and
textures are recompressed to WebP:

```bash
gltf-transform optimize original/eye-anatomy.glb ../../optimized/eye-anatomy.glb \
  --simplify false --compress draco --texture-compress webp --texture-size 4096
```

## Results

| Asset             | Original | Optimized | Reduction |
|-------------------|---------:|----------:|----------:|
| `eye.stl`         | 1008 MB  | 0.6 MB    | ~1600×    |
| `feature.stl`     | 149 MB   | 0.3 MB    | ~450×     |
| `eye-anatomy.glb` | 137 MB   | 7.2 MB    | ~19×      |

> `original/` and `out/` are git-ignored — download the source meshes from the
> [Hugging Face dataset](https://huggingface.co/datasets/kush1434/awg_retina_tomography_ui)
> before running.
