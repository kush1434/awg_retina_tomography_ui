#!/usr/bin/env bash
# Decimate + Draco-compress a binary STL into a tiny GLB for the web.
#
#   ./optimize.sh <input.stl> <output.glb> [target_ratio] [max_error]
#
# Example (21M-triangle mesh -> ~320k triangles):
#   ./optimize.sh original/eye.stl ../../optimized/sample_1_seg_mesh/eye.glb 0.015
#
# Requires: node, and the gltf-transform CLI (`npm i -g @gltf-transform/cli`).
set -euo pipefail

IN="${1:?input .stl required}"
OUT="${2:?output .glb required}"
RATIO="${3:-0.05}"      # fraction of triangles to keep
ERROR="${4:-0.004}"     # max simplification error (fraction of mesh size)

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$(dirname "$OUT")"

echo "1/4  STL -> raw GLB"
node --max-old-space-size=16384 "$(dirname "$0")/stl2glb.mjs" "$IN" "$TMP/raw.glb"

echo "2/4  weld (index + merge vertices)"
gltf-transform weld "$TMP/raw.glb" "$TMP/weld.glb"

echo "3/4  simplify (ratio=$RATIO, error=$ERROR)"
gltf-transform simplify "$TMP/weld.glb" "$TMP/simp.glb" --ratio "$RATIO" --error "$ERROR"

echo "4/4  Draco compress"
gltf-transform draco "$TMP/simp.glb" "$OUT"

echo "done -> $OUT ($(du -h "$OUT" | cut -f1))"
