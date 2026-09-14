#!/usr/bin/env bash
# Rebuild every reference eye model under optimized/anatomy/.
#
#   ./build-anatomy.sh [work_dir] [model ...]
#
# Clones each upstream source, tessellates / sweeps it into one watertight mesh
# per anatomical structure, packs each model into a glTF with one named node per
# structure, then Draco-compresses.
#
#   mesheye   feelpp/mesh.eye  Eye.step      10 structures  ~352 KB  GPL-3.0
#   humaneye  feelpp/mesh.eye  human_eye.stp 10 structures  ~360 KB  GPL-3.0
#   upat      Upatras OpenSim oculomotor      8 structures  ~30 KB   CC BY 4.0
#
# Requires: python3 with `gmsh trimesh numpy networkx` (pip), git, and the
# gltf-transform CLI (`npm i -g @gltf-transform/cli`).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
DEST="$HERE/../../../optimized/anatomy"
WORK="${1:-$HERE/work}"
shift || true

mkdir -p "$WORK/src" "$DEST"

clone() {   # clone <url> <dir>
  [ -d "$WORK/src/$2" ] || { echo "  clone $1"; git clone --depth 1 -q "$1" "$WORK/src/$2"; }
}
echo "1/4  fetch sources"
clone https://github.com/feelpp/mesh.eye.git            mesh.eye
clone https://gitlab.com/mitkof6/upat_eye_model.git     upat_eye_model

echo "2/4  build meshes"
python3 "$HERE/build_models.py" "$WORK/src" "$WORK/out" "$@"

echo "3/4  Draco compress"
for f in "$WORK"/out/*.glb; do
  gltf-transform draco "$f" "$DEST/$(basename "$f")" >/dev/null
  printf '  %-24s %s\n' "$(basename "$f")" "$(du -h "$DEST/$(basename "$f")" | cut -f1)"
done

echo "4/4  refresh licences + structure manifest"
cp "$WORK/src/mesh.eye/LICENSE"       "$DEST/LICENSE-mesh.eye-GPL-3.0.txt"
cp "$WORK/src/upat_eye_model/LICENSE" "$DEST/LICENSE-upat-CC-BY-4.0.txt"
cp "$WORK/out/structures.json"        "$DEST/structures.json"

echo "done -> $DEST"
