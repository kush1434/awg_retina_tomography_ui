# Benchmarks

Two measurements back the numbers reported for this viewer: what the shipped
assets cost a visitor, and how much geometric accuracy the optimization
pipeline gives up to get there.

```bash
cd tools/bench && npm install
```

## Asset inventory

```bash
node bench.mjs            # human-readable table
node bench.mjs --json     # machine-readable
```

Decodes every GLB under `optimized/` and reports its size, triangle and vertex
counts, bytes per triangle, and whether Draco compression is present, then
totals the first-paint payload. This runs against the repository as checked out
and needs no external data, so CI runs it on every push — a corrupt or
uncompressed asset fails the build.

## Decimation error

```bash
node --max-old-space-size=16384 bench.mjs \
  --verify ../optimize/original/eye.stl \
  ../../optimized/sample_1_seg_mesh/eye.glb \
  --samples 50000
```

Reports the symmetric surface distance between a full-resolution source mesh
and the decimated GLB the viewer ships, as a percentage of the bounding-box
diagonal:

- **decimated → original** — how far the shipped surface strays from the scan.
- **original → decimated** — detail that decimation dropped.
- **symmetric Hausdorff** — the worst case in either direction.

Points are sampled area-weighted over each surface with a fixed seed, so runs
are reproducible. Distances are exact: `TriangleGrid` bins triangles by centroid
in a uniform spatial hash and expands cell shells until no unvisited cell could
contain anything closer, and `pointTriangleDistSq` is the standard closest-point
computation over all seven Voronoi regions of a triangle. Both are covered by
`test/geometry.test.js`, which cross-checks the grid against brute force.

### Getting the source meshes

The full-resolution scans are not in git — they are in the
[Hugging Face dataset](https://huggingface.co/datasets/kush1434/awg_retina_tomography_ui).
Fetch them into the (git-ignored) working directory the optimize pipeline uses:

```bash
mkdir -p tools/optimize/original && cd tools/optimize/original
BASE=https://huggingface.co/datasets/kush1434/awg_retina_tomography_ui/resolve/main/sample_1_seg_mesh
curl -L -o eye.stl     "$BASE/eye.stl"       # ~1.0 GB
curl -L -o feature.stl "$BASE/feature.stl"   # ~150 MB
```

`eye.stl` holds 21.1M triangles; indexing it needs roughly 8 GB of heap, hence
`--max-old-space-size`.
