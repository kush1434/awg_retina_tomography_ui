"""
Build every eye model the viewer offers, one Draco glTF each with one named
node per anatomical structure.

  python build_models.py <src_dir> <out_dir> [model ...]

src_dir must contain:
  mesh.eye/          clone of https://github.com/feelpp/mesh.eye        (GPL-3.0)
  upat_eye_model/    clone of https://gitlab.com/mitkof6/upat_eye_model (CC BY 4.0)

Orientation convention shared by every model: millimetres, antero-posterior axis
along X with the cornea at -X, and every structure translated by the bounding-box
centre of that model's `centre` solid (see JOBS). That is not the same as
globe-centred for humaneye: its sclera carries a posterior extension, which
leaves that model's globe ~4.39 mm anterior of mesheye's. The viewer frames the
pane from the -X side, so all models open on the same three-quarter anterior
view.
"""
import json
import os
import sys
import xml.etree.ElementTree as ET

import numpy as np
import trimesh

SRC = sys.argv[1] if len(sys.argv) > 1 else "."
OUT = sys.argv[2] if len(sys.argv) > 2 else "models"
ONLY = sys.argv[3:]

# --------------------------------------------------------------------------
#  Model definitions
# --------------------------------------------------------------------------
# For the two STEP models the solid order is the order the source's own script
# extracts them in; each mapping was checked against the geometry (nesting
# radii, antero-posterior centroids, volumes) before being trusted.

MESHEYE_SOLIDS = {           # Eye.step — MakePartition order in construct-eye-STP.py
    1:  ("cornea",      "Cornea"),
    2:  ("aqueous",     "Aqueous humour"),
    3:  ("iris",        "Iris"),
    4:  ("lens",        "Lens"),
    5:  ("vitreous",    "Vitreous humour"),
    6:  ("sclera",      "Sclera"),
    7:  ("choroid",     "Choroid"),
    8:  ("retina",      "Retina"),
    9:  ("lamina",      "Lamina cribrosa"),
    10: ("optic_nerve", "Optic nerve"),
}

# human_eye.stp — identified by geometry; see the volume/extent table in the
# build log. Tags 7 and 8 are the two retinal vessels: equal in triangle count,
# area and volume, and running alongside each other without touching, so the
# mesh cannot tell them apart. They take the source's own Vein-then-Artery
# order, which is the only thing the labelling rests on.
HUMANEYE_SOLIDS = {
    6:  ("cornea",     "Cornea"),
    1:  ("iris",       "Iris & ciliary body"),
    9:  ("zonules",    "Suspensory ligament"),
    2:  ("lens",       "Lens"),
    10: ("vitreous",   "Vitreous humour"),
    3:  ("sclera",     "Sclera"),
    4:  ("choroid",    "Choroid"),
    5:  ("retina",     "Retina"),
    7:  ("vein",       "Retinal vein"),
    8:  ("artery",     "Central retinal artery"),
}

UPAT_MUSCLES = [
    ("r_Lateral_Rectus",   "lateral_rectus",   "Lateral rectus"),
    ("r_Medial_Rectus",    "medial_rectus",    "Medial rectus"),
    ("r_Superior_Rectus",  "superior_rectus",  "Superior rectus"),
    ("r_Inferior_Rectus",  "inferior_rectus",  "Inferior rectus"),
    ("r_Superior_Oblique", "superior_oblique", "Superior oblique"),
    ("r_Inferior_Oblique", "inferior_oblique", "Inferior oblique"),
]

# key -> (rgb 0-1, alpha, roughness). The viewer overrides these at runtime, but
# baking them keeps the file sensible in any other glTF viewer.
STYLE = {
    "sclera":   ((0.78, 0.76, 0.70), 1.00, 0.52),
    "globe":    ((0.78, 0.76, 0.70), 1.00, 0.52),
    "cornea":   ((0.84, 0.93, 0.96), 0.30, 0.05),
    "aqueous":  ((0.85, 0.94, 0.97), 0.16, 0.05),
    "iris":     ((0.54, 0.34, 0.15), 1.00, 0.70),
    "pupil":    ((0.06, 0.06, 0.07), 1.00, 0.40),
    "lens":     ((0.94, 0.86, 0.65), 0.82, 0.10),
    "zonules":  ((0.90, 0.88, 0.78), 0.85, 0.35),
    "vitreous": ((0.75, 0.89, 0.94), 0.10, 0.08),
    "retina":   ((0.85, 0.39, 0.30), 1.00, 0.62),
    "choroid":  ((0.56, 0.17, 0.24), 1.00, 0.58),
    "lamina":   ((0.56, 0.75, 0.60), 1.00, 0.62),
    "optic_nerve": ((0.87, 0.83, 0.72), 1.00, 0.66),
    "artery":   ((0.78, 0.18, 0.18), 1.00, 0.55),
    "vein":     ((0.27, 0.35, 0.66), 1.00, 0.55),
}
MUSCLE_STYLE = ((0.72, 0.26, 0.24), 1.00, 0.66)

# --------------------------------------------------------------------------
#  STEP models
# --------------------------------------------------------------------------
def tessellate_step(path, solids, lc, scale=1.0):
    """
    Mesh every solid's boundary conformally, return {key: (label, Trimesh)}.

    `lc` is the target element size in the file's own units and `scale` converts
    those units to millimetres -- the two STEP files disagree: Eye.step is
    exported in micrometres, human_eye.stp is already in millimetres.
    """
    import gmsh
    gmsh.initialize()
    gmsh.option.setNumber("General.Terminal", 0)
    gmsh.model.occ.importShapes(path)
    gmsh.model.occ.synchronize()
    gmsh.option.setNumber("Mesh.MeshSizeMin", lc * 0.25)
    gmsh.option.setNumber("Mesh.MeshSizeMax", lc)
    gmsh.option.setNumber("Mesh.MeshSizeFromCurvature", 22)
    gmsh.option.setNumber("Mesh.MeshSizeExtendFromBoundary", 0)
    gmsh.option.setNumber("Mesh.Algorithm", 6)
    gmsh.model.mesh.generate(2)

    out = {}
    for dim, tag in gmsh.model.getEntities(3):
        if tag not in solids:
            continue
        key, label = solids[tag]
        verts, pts, tris = {}, [], []
        for (_d, s) in gmsh.model.getBoundary([(dim, tag)], oriented=False):
            ntags, ncoords, _ = gmsh.model.mesh.getNodes(2, s, includeBoundary=True)
            ncoords = np.array(ncoords).reshape(-1, 3)
            for nt, xyz in zip(ntags, ncoords):
                if nt not in verts:
                    verts[nt] = len(pts); pts.append(xyz)
            etypes, _etags, enodes = gmsh.model.mesh.getElements(2, s)
            for et, en in zip(etypes, enodes):
                if et != 2:          # 3-node triangle
                    continue
                for tri in np.array(en).reshape(-1, 3):
                    tris.append([verts[t] for t in tri])
        if not tris:
            print(f"    !! {key}: no triangles"); continue
        m = trimesh.Trimesh(vertices=np.array(pts) * scale, faces=np.array(tris), process=True, validate=True)
        m.merge_vertices(); m.fix_normals()
        out[key] = (label, m)
        print(f"    {key:<14} {len(m.faces):>7} tris  vol={abs(m.volume):9.2f}  watertight={m.is_watertight}")
    gmsh.finalize()
    return out


# --------------------------------------------------------------------------
#  Upatras OpenSim oculomotor model
# --------------------------------------------------------------------------
def muscle_tube(points, globe_r, centre, width=3.4, thick=0.85, seg=15):
    """
    Sweep a flat, strap-like cross-section along a muscle path.

    The .osim stores each muscle as a few path points plus a wrap object; a
    straight polyline between them would cut through the globe. Resample the
    polyline finely and push every point nearer the centre than globe_r + thick
    out to exactly that radius, so the centreline clears the wrap surface by the
    full strap thickness and the strap lands on the sclera rather than inside
    it — that is what the solver's `axial` wrap does, and it makes the muscle hug
    the sclera the way a real rectus does. The cross-section is an ellipse,
    wide tangentially and thin radially, because the recti are broad flat
    straps rather than cords.
    """
    pts = []
    for a, b in zip(points[:-1], points[1:]):
        for t in np.linspace(0, 1, 26, endpoint=False):
            pts.append(a * (1 - t) + b * t)
    pts.append(points[-1])
    pts = np.array(pts)

    radial = pts - centre
    dist = np.linalg.norm(radial, axis=1, keepdims=True)
    inside = (dist < globe_r + thick).ravel()
    pts[inside] = centre + radial[inside] / dist[inside] * (globe_r + thick)

    # drop duplicates the projection may have created
    keep = np.concatenate([[True], np.linalg.norm(np.diff(pts, axis=0), axis=1) > 1e-4])
    pts = pts[keep]
    if len(pts) < 3:
        return None

    verts, faces = [], []
    for i, p in enumerate(pts):
        fwd = pts[min(i + 1, len(pts) - 1)] - pts[max(i - 1, 0)]
        n = np.linalg.norm(fwd)
        if n < 1e-9:
            fwd = np.array([1.0, 0, 0]); n = 1.0
        fwd = fwd / n
        rad = p - centre
        rad = rad / (np.linalg.norm(rad) or 1.0)
        tan = np.cross(rad, fwd)
        tn = np.linalg.norm(tan)
        tan = tan / tn if tn > 1e-9 else np.cross(fwd, [0, 0, 1.0])
        rad = np.cross(fwd, tan)
        for k in range(seg):
            a = 2 * np.pi * k / seg
            verts.append(p + tan * (np.cos(a) * width / 2) + rad * (np.sin(a) * thick / 2))
    for i in range(len(pts) - 1):
        for k in range(seg):
            a = i * seg + k
            b = i * seg + (k + 1) % seg
            faces += [[a, b, a + seg], [b, b + seg, a + seg]]
    m = trimesh.Trimesh(vertices=np.array(verts), faces=np.array(faces), process=True)
    m.fix_normals()
    return m


def build_upat(root):
    model_dir = os.path.join(root, "model")
    osim = ET.parse(os.path.join(model_dir, "UPAT_Eye_Model_Passive_Pulleys_v4.osim")).getroot()

    wrap = next(w for w in osim.iter("WrapEllipsoid") if w.get("name") == "right_eye_wrap")
    globe_r = float(wrap.find("dimensions").text.split()[0]) * 1000.0     # m -> mm
    centre = np.zeros(3)   # Right_Eye_Joint has no ground offset: r_eye sits on ground

    out = {}
    for fname, key, label in [("sclera.obj", "globe", "Globe (sclera)"), ("pupil.obj", "pupil", "Pupil / cornea")]:
        m = trimesh.load(os.path.join(model_dir, fname), force="mesh")
        out[key] = (label, m)
        print(f"    {key:<18} {len(m.faces):>7} tris")

    for osim_name, key, label in UPAT_MUSCLES:
        mus = next(x for x in osim.iter("Millard2012EquilibriumMuscle") if x.get("name") == osim_name)
        pts = np.array([[float(v) * 1000.0 for v in pp.find("location").text.split()]
                        for pp in mus.iter("PathPoint")])
        m = muscle_tube(pts, globe_r, centre)
        if m is None:
            print(f"    !! {key}: degenerate path"); continue
        out[key] = (label, m)
        print(f"    {key:<18} {len(m.faces):>7} tris  {len(pts)} path points")

    # The Upatras model points anterior along +X; every other model here points
    # it along -X. Rotate 180 deg about Y (a proper rotation, so the eye stays a
    # right eye) to put them all in the same frame.
    R = trimesh.transformations.rotation_matrix(np.pi, [0, 1, 0])
    for _k, (_l, m) in out.items():
        m.apply_transform(R)
    return out


# --------------------------------------------------------------------------
#  Packaging
# --------------------------------------------------------------------------
def write_glb(parts, order, out_path, centre_on):
    """parts: {key: (label, Trimesh)}; order: key list controlling node order."""
    ref = parts.get(centre_on) or next(iter(parts.values()))
    origin = ref[1].bounds.mean(axis=0)

    scene = trimesh.Scene()
    manifest, total = [], 0
    for key in order:
        if key not in parts:
            continue
        label, m = parts[key]
        m = m.copy()
        m.apply_translation(-origin)
        rgb, alpha, rough = STYLE.get(key, MUSCLE_STYLE)
        m.visual = trimesh.visual.TextureVisuals(material=trimesh.visual.material.PBRMaterial(
            name=key,
            baseColorFactor=[*[int(round(c * 255)) for c in rgb], int(round(alpha * 255))],
            metallicFactor=0.0, roughnessFactor=rough,
            alphaMode="BLEND" if alpha < 1 else "OPAQUE", doubleSided=True))
        scene.add_geometry(m, geom_name=key, node_name=key)
        total += len(m.faces)
        manifest.append(dict(key=key, label=label, faces=int(len(m.faces)),
                             watertight=bool(m.is_watertight),
                             volume_mm3=round(float(abs(m.volume)), 3),
                             bounds=[[round(v, 3) for v in m.bounds[0]], [round(v, 3) for v in m.bounds[1]]]))
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "wb") as f:
        f.write(trimesh.exchange.gltf.export_glb(scene, include_normals=True))
    print(f"  -> {out_path}  {total} tris, {os.path.getsize(out_path)/1e6:.2f} MB raw")
    return manifest


JOBS = {
    "mesheye": dict(
        out="eye-anatomy.glb",
        order=["sclera", "choroid", "retina", "cornea", "aqueous", "iris", "lens", "vitreous", "lamina", "optic_nerve"],
        centre="sclera",
    ),
    "humaneye": dict(
        out="human-eye-cad.glb",
        order=["sclera", "choroid", "retina", "cornea", "iris", "zonules", "lens", "vitreous", "artery", "vein"],
        centre="sclera",
    ),
    "upat": dict(
        out="upat-oculomotor.glb",
        order=["globe", "pupil", "lateral_rectus", "medial_rectus", "superior_rectus",
               "inferior_rectus", "superior_oblique", "inferior_oblique"],
        centre="globe",
    ),
}

manifests = {}
for name, job in JOBS.items():
    if ONLY and name not in ONLY:
        continue
    print(f"\n== {name}")
    if name == "mesheye":
        parts = tessellate_step(os.path.join(SRC, "mesh.eye", "Eye.step"), MESHEYE_SOLIDS, lc=500.0, scale=0.001)
    elif name == "humaneye":
        parts = tessellate_step(os.path.join(SRC, "mesh.eye", "human_eye.stp"), HUMANEYE_SOLIDS, lc=0.5)
    else:
        parts = build_upat(os.path.join(SRC, "upat_eye_model"))
    manifests[name] = write_glb(parts, job["order"], os.path.join(OUT, job["out"]), job["centre"])

with open(os.path.join(OUT, "structures.json"), "w") as f:
    json.dump(manifests, f, indent=2)
print("\nwrote", os.path.join(OUT, "structures.json"))
