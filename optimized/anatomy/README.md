# Reference eye models — provenance & licences

The viewer's **left** pane shows a published, citable eye model for orientation
beside the segmented µCT coats on the right. None of this is NASA data. Pick a
model from the **ANATOMY** panel, or with `?model=<id>`.

Each file is one Draco-compressed glTF with **one named node per anatomical
structure**, so the viewer can toggle, recolour, fade and slice each structure
independently. Shared convention: millimetres, globe centred on the origin,
antero-posterior axis along **X** with the cornea at **−X**.

Rebuild everything with [`../../tools/optimize/anatomy/build-anatomy.sh`](../../tools/optimize/anatomy/build-anatomy.sh).

| id | File | Structures | Size | Licence |
|----|------|-----------:|-----:|---------|
| `mesheye`  | `eye-anatomy.glb`      | 10 | 352 KB | GPL-3.0 |
| `humaneye` | `human-eye-cad.glb`    | 10 | 360 KB | GPL-3.0 |
| `upat`     | `upat-oculomotor.glb`  |  8 |  30 KB | CC BY 4.0 |

---

## `mesheye` — feelpp/mesh.eye

*A 3D geometrical model and meshing procedures for the human eyeball* — Vincent
Chabannes, Christophe Prud'homme, Thomas Saigre, Lorenzo Sala, Marcela Szopos,
Christophe Trophime (Cemosis / IRMA UMR 7501, Université de Strasbourg, CNRS).

- <https://github.com/feelpp/mesh.eye> · DOI [10.5281/zenodo.13829740](https://doi.org/10.5281/zenodo.13829740)
- Model described in: Sala L, Prud'homme C, Guidoboni G, Szopos M, Harris A.
  *The ocular mathematical virtual simulator.* Int J Numer Meth Biomed Engng.
  2024; 40(2):e3791. <https://doi.org/10.1002/cnm.3791>

`Eye.step` tessellated with gmsh's OpenCASCADE kernel. Solid order follows the
`MakePartition` call in `construct-eye-STP.py`.

| Structure | Triangles | Volume (mm³) |
|-----------|----------:|-------------:|
| Cornea | 6,414 | 128.14 |
| Aqueous humour | 13,344 | 150.75 |
| Iris | 17,210 | 252.48 |
| Lens | 2,856 | 88.31 |
| Vitreous humour | 19,862 | 4,675.78 |
| Sclera | 36,686 | 1,644.49 |
| Choroid | 25,038 | 631.67 |
| Retina | 22,388 | 428.86 |
| Lamina cribrosa | 278 | 0.36 |
| Optic nerve | 2,668 | 17.53 |

147 k triangles. All ten solids verified watertight.

## `humaneye` — the CAD eye mesh.eye is derived from

`human_eye.stp`, the SolidWorks model in the same repository that
`construct-eye-STP.py` reads as its input, and the geometry the Feel++ ocular
heat/flow work is ultimately built on. It carries two structures the derived
`Eye.step` does not — the **suspensory ligament** (zonules, 124 separate fibre
surfaces) and the **central retinal artery and vein** — but lacks the lamina
cribrosa, the separated aqueous humour and the standalone optic nerve that
mesh.eye's script constructs.

| Structure | Triangles | Volume (mm³) |
|-----------|----------:|-------------:|
| Cornea | 6,418 | 128.14 |
| Iris & ciliary body | 15,452 | 252.49 |
| Suspensory ligament | 10,510 | 35.64 |
| Lens | 1,882 | 88.18 |
| Vitreous humour | 18,176 | 4,641.99 |
| Sclera | 40,712 | 1,792.76 |
| Choroid | 25,022 | 631.66 |
| Retina | 26,208 | 524.83 |
| Retinal vein | 2,514 | 1.90 |
| Central retinal artery | 2,514 | 1.90 |

149 k triangles. Solids were identified from the geometry (volume, centroid,
radial nesting) and then cross-checked against `mesheye`: cornea 128.14 in both,
iris 252.48 / 252.49, choroid 631.67 / 631.66 — the two files agree structure by
structure, which is what confirms both mappings. The artery and vein are
near-identical twins separated only in y and take the source script's own
`Vein_h, Artery_h` order.

## `upat` — Upatras OpenSim oculomotor model

*An Open-Source OpenSim Oculomotor Model for Kinematics and Dynamics Simulation*
— Konstantinos Filip, Dimitar Stanev, Konstantinos Moustakas, University of Patras.
[arXiv:1807.07332](https://arxiv.org/abs/1807.07332) ·
<https://simtk.org/projects/eye> · source at
<https://gitlab.com/mitkof6/upat_eye_model>.

Globe and pupil come from the model's own `sclera.obj` / `pupil.obj`. The six
extraocular muscles are swept from the `PathPoint` sets in
`UPAT_Eye_Model_Passive_Pulleys_v4.osim`: the polyline is resampled finely and
any point falling inside the 12 mm wrap sphere is pushed onto its surface, which
is what the solver's `axial` wrap does and what makes the muscles hug the sclera
the way real recti do. The cross-section is a flattened ellipse — wide
tangentially, thin radially — because the recti are broad straps, not cords.

Structures: globe, cornea/pupil, lateral / medial / superior / inferior rectus,
superior and inferior oblique. 10 k triangles.

The Upatras model points anterior along **+X**; it is rotated 180° about Y (a
proper rotation, so it stays a right eye) to match the others.

---

## Projects surveyed but not loadable

These are listed, disabled, in the model menu rather than hidden, so it is clear
they were considered. None ships 3D anatomical geometry:

| Project | Why not | How that was checked |
|---------|---------|----------------------|
| ISETBio | MATLAB scene→retinal-image optics and cone-mosaic simulation. Its "geometry" is a 2D cone packing | Repo tree contains **zero** `.obj/.stl/.ply/.vtp/.glb/.gltf/.step/.stp/.off/.msh` files |
| OpenRetina | Networks predicting retinal spike responses to stimuli; nothing spatial to draw | Model weights and stimulus/response tensors only |
| V-Cornea | The published CompuCell3D lattice is **two-dimensional** — a 200 × 90 cross-section of epithelium, not a 3D cornea | Parsed `Epithelium.piff`: 12,085 cell boxes over 9 cell types (BASAL, LIMB, MEMB, STEM, STROMA, SUPER, TEAR, WALL, WING), `z1 = z2 = 0` on every one |
| OpenEyeSim | Not publicly obtainable. Covers the same ground as the Upatras model, which is public | SimTK project page: *"IF YOU WANT TO GET IT NOW WRITE US AN EMAIL"* — no download files |
| pulse2percept | Models retinal **implants**, not eyes: its geometry is disc-electrode arrays (`DiskElectrode(r=250 µm, x, y, z)`) | Zero mesh files; electrodes are constructed in code. (Also won't install on Python 3.13 — it needs the removed `numpy.distutils`) |
| Open Source Brain | NeuroML single-neuron morphologies — a ganglion cell, not ocular anatomy | Morphology files describe soma + dendrite segments |

Three of these could contribute a *non-eye* 3D object if that were ever wanted —
a pulse2percept electrode array sitting on the retina, an ISETBio cone-mosaic
patch, or an Open Source Brain ganglion-cell morphology. They would be overlays
on an eye rather than eye models, so they are not offered as choices here.

---

## Licences

The viewer's own code is **MIT** (repository root
[`LICENSE`](../../LICENSE)). The models here keep their upstream licences and
are merely aggregated with it — loading these files does not make the viewer a
derivative work of them.

- `eye-anatomy.glb`, `human-eye-cad.glb` — **GPL-3.0**, see
  [`LICENSE-mesh.eye-GPL-3.0.txt`](LICENSE-mesh.eye-GPL-3.0.txt)
- `upat-oculomotor.glb` — **CC BY 4.0**, see
  [`LICENSE-upat-CC-BY-4.0.txt`](LICENSE-upat-CC-BY-4.0.txt)

To use a model that isn't here, point the viewer at it with `?anatomy=<url>`; if
its glTF node names don't match a registered model the per-structure panel is
skipped and it simply renders whole.
