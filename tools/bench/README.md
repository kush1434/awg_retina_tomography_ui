# Benchmarks

Two measurements back the numbers reported for this viewer: what the shipped
assets cost a visitor, and how much geometric accuracy the optimization
pipeline gives up to get there.

```bash
cd tools/bench && npm install   # every command on this page runs from tools/bench
```

Needs Node >= 20, the repository's floor; CI runs these benchmarks on Node 22.

## Asset inventory

```bash
node bench.mjs            # human-readable table
node bench.mjs --json     # per-asset rows only, machine-readable
```

Decodes every GLB in the four shipped asset directories under `optimized/`
(`sample_1_seg_mesh`, `F10_layers`, `F10_layers_solid`, `anatomy`) and reports
its size, triangle and vertex counts, bytes per triangle, and whether Draco
compression is present. That directory list is hard-coded in `shippedAssets()`
at the top of `bench.mjs`, so a new asset directory has to be added there or it
is silently skipped.

The human-readable run then totals the first-paint payload: the app shell —
`index.html`, its stylesheets, and the transitive closure of the relative module
imports reachable from it, walked from `index.html` rather than listed, so the
figure cannot go stale when a module moves — reported both raw and gzipped at
level 6, plus the default anatomy GLB. The `.glb` assets are Draco-compressed
already and are not gzipped again because they do not shrink further, so a host
that serves text assets gzipped transfers the gzipped shell plus the raw GLB.
This is where the 190 KB raw / 61 KB gzipped shell and the ~405 KB first visit
reported in the top-level README and in `paper.md` come from. `--json` stops
after the per-asset rows: it emits `generated` and `assets` only, none of the
totals.

This runs against the repository as checked out and needs no external data, so
CI decodes every shipped GLB on pushes to `main` and on every pull request; a
GLB that cannot be parsed fails the build. Whether Draco is present is reported
in the `draco` column, not asserted.

## Decimation error

`--verify` needs a full-resolution source mesh, which is not in git — see
[Getting the source meshes](#getting-the-source-meshes) below first.

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

Each direction is printed as mean, rms, p95, p99 and max. The mean and p99
figures quoted in the top-level README and in `paper.md` are the mean and p99
columns of the `decimated → original` row, and the symmetric Hausdorff line is
the larger of the two max columns, not a percentile. The run also prints the
byte and triangle reduction factors, the percentage of triangles kept, and the
surface-area change.

`--samples N` sets the number of points sampled per direction (default 50,000);
more samples tighten the tail statistics at linear cost. `--json` works with
`--verify` as well as with the inventory, emitting the same figures plus the raw
unnormalised distances and the elapsed time.

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
mkdir -p ../optimize/original && cd ../optimize/original
BASE=https://huggingface.co/datasets/kush1434/awg_retina_tomography_ui/resolve/main/sample_1_seg_mesh
curl -L -o eye.stl     "$BASE/eye.stl"       # ~1.0 GB
curl -L -o feature.stl "$BASE/feature.stl"   # ~150 MB
cd ../../bench                               # back to tools/bench for the commands above
```

`eye.stl` holds 21.1M triangles; indexing it needs roughly 8 GB of heap, hence
`--max-old-space-size`.
