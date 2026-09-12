---
title: 'Retina Tomography Viewer: a zero-install browser viewer for segmented ocular micro-tomography'
tags:
  - JavaScript
  - WebGL
  - micro-CT
  - visualization
  - space biology
  - ophthalmology
  - open data
authors:
  - name: Kush Shah
    orcid: 0000-0000-0000-0000            # TODO: register at orcid.org — JOSS requires this
    affiliation: 1
  - name: Jian Gong                        # TODO: confirm authorship and ORCID before submitting
    orcid: 0000-0000-0000-0000
    affiliation: 2
affiliations:
  - name: Del Norte High School, San Diego, CA, USA   # TODO: confirm
    index: 1
  - name: NASA GeneLab Analysis Working Group          # TODO: confirm
    index: 2
date: 10 September 2026
bibliography: paper.bib
---

# Summary

`Retina Tomography Viewer` is a browser application for exploring segmented
ocular micro-computed-tomography (µCT) data. It presents two linked 3D views
side by side: a published, citable reference eye model on the left, and the
individually toggleable segmented tissue layers of a scanned specimen on the
right. Orbiting one view can be mirrored onto the other, so a segmented coat can
be read against the anatomy it corresponds to. Every structure in both panes can
be shown, hidden, recoloured, faded, or clipped with orthogonal slice planes.

The application is a static site with no build step and no server. It is opened
from a URL and needs no installation, no account, and no local compute. Its
dataset is described by a plain CSV manifest, and any manifest can be supplied
at run time with a URL parameter, so the viewer is not tied to the particular
scan it ships with.

# Statement of need

Segmented µCT of the eye is produced as surface meshes that are far too large to
open casually. The mouse eye distributed with this project is a 1.0 GB binary
STL of 21.1 million triangles. Inspecting it conventionally means installing a
desktop package such as 3D Slicer [@fedorov2012slicer], downloading the full
mesh, and having a workstation able to hold it in memory. That is a reasonable
cost for an investigator who works with the data daily, and a prohibitive one
for everybody else — a collaborator checking a claim, a reviewer, an educator, a
student, or a researcher from an adjacent field deciding whether a dataset is
worth their time.

This matters for space biology specifically. Spaceflight-associated neuro-ocular
syndrome (SANS) is among the better-documented physiological risks of long-
duration spaceflight [@lee2020sans], and ocular tissue is consequently a
recurring subject of spaceflight and analog studies. NASA's Open Science Data
Repository publishes these data openly [@gebre2025osdr; @berrios2021genelab],
but publishing a mesh is not the same as making it explorable: the repository
hands back a file, and the barrier to actually looking at it is unchanged.

`Retina Tomography Viewer` closes that specific gap. It turns a
multi-gigabyte segmentation into something that opens in a few hundred
kilobytes, in any browser, on a phone, in seconds — while remaining faithful
enough to the source geometry to be worth looking at.

# Implementation

The viewer is written in ES modules against Three.js [@threejs], with no
bundler, no framework, and no runtime dependency beyond Three.js itself. It is
structured as a core library exposed through a web experience, in an MVC-style
split: `core/` holds the model — scenes, cameras, clipping, camera sync, the
layer and anatomy loading state machines and the view state — and never
touches the DOM, taking its renderer and controls through injected adapters
and reporting every transition through an event emitter; `app/ui/` is the
view — the two side panels and the surrounding chrome, which turn DOM input
into calls on that core and render its events — `viewer.js` the controller
entry that assembles them, and one small adapter module is the only place a
WebGL renderer is constructed. The core is importable on its own (`package.json` exposes it as
the package entry, with a headless adapter set for use outside a browser);
`README.md` documents the entry points, the record and event contracts and a
worked minimal page.
Meshes are streamed with progress reporting and cancellation, and stored in
the Cache Storage API so a mesh is downloaded at most once per browser.

The assets it serves are produced by a documented pipeline
(`tools/optimize/`): binary STL is converted to glTF, welded into an indexed
mesh, decimated with `meshoptimizer`'s error-bounded simplifier
[@meshoptimizer], and compressed with Draco [@draco]. Layers are fetched only
when a user toggles them on.

The cost of that reduction is measurable, and `tools/bench` measures it. Surface
error is reported as a symmetric point-to-surface distance — sampled
area-weighted over both meshes, computed exactly against a uniform spatial
hash — normalised by the bounding-box diagonal:

| Source mesh | Triangles | Size | Shipped | Reduction | Mean error | p99 | Area change |
|---|---:|---:|---:|---:|---:|---:|---:|
| `eye.stl` | 21,141,576 | 1008.1 MB | 633 KB | 1631× | 0.017% | 0.062% | +0.63% |
| `feature.stl` | 3,131,220 | 149.3 MB | 325 KB | 471× | 0.006% | 0.024% | +0.21% |

Discarding 98.5% of the triangles of `eye.stl` moves the surface by 0.017% of
the object's diagonal on average, and total surface area changes by well under
one percent. The worst-case (Hausdorff) distances are larger — 3.99% and 1.10%
respectively — and are concentrated almost entirely in the original-to-decimated
direction, which is the signature of a small number of tiny disconnected
fragments being removed rather than of the principal surface being displaced.
The viewer is therefore appropriate for orientation, teaching, qualitative
inspection and triage, and is explicitly *not* a substitute for the source mesh
in morphometric analysis.

A first visit costs roughly 476 KB — a 132 KB application shell plus the 343 KB
default anatomy model — against the 1.16 GB of source meshes it stands in for.
With every layer toggled on the total is 3.2 MB.

# Reference anatomy and provenance

The left pane deliberately holds third-party, published anatomy rather than
NASA data: `feelpp/mesh.eye` [@chabannes2024mesheye; @sala2024ovs], the
SolidWorks CAD eye it derives from, and the University of Patras OpenSim
oculomotor model with its six extraocular muscles [@filip2018upat]. Each ships
as one named node per structure, under its own upstream licence, with a
structure-by-structure provenance table recording triangle counts, volumes and
how each solid was identified.

The model menu also lists, disabled and with the reason, the open eye-modelling
projects that were surveyed and ship no usable 3D geometry — ISETBio,
OpenRetina, V-Cornea, OpenEyeSim, `pulse2percept` and Open Source Brain —
together with how that was verified in each case. Making a negative result
visible rather than silently omitting it is, we think, the more useful choice
for anyone else looking for open ocular geometry.

Because these are human models while the shipped segmentation is murine, the
interface and documentation state plainly that the left pane is for
orientation and not for cross-species morphometric comparison.

# Quality control

The data layer, the caching layer, the geometry code underlying the reported
error figures, the core library itself and the view modules are covered by
477 unit tests on the Node test runner. The core runs headless under a stub renderer with the
real Three.js orbit controls, so pane construction, clipping and cap geometry,
camera synchronisation, the loading state machines and every view transition
are exercised without a browser; the geometry-loading path is driven with
synthetic STL and uncompressed glTF meshes there, while the shipped
Draco-compressed assets are decoded only by the browser suite. A static scan
asserts that no core module references a DOM, timer or network global, and
the view modules are rendered into a small fake DOM over that headless core. 18
Playwright tests drive the real application in a real browser, asserting that
WebGL initialises, that a toggled layer reaches the GPU, that the cache is
populated, and that the controls behave. Continuous integration runs both, and
additionally decodes every shipped asset so that a corrupt or uncompressed mesh
fails the build.

# Acknowledgements

We thank the NASA GeneLab Analysis Working Group for access to the ocular µCT
data, and the authors of `mesh.eye` and the Upatras oculomotor model for
publishing eye geometry openly.

# References
