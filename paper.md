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
date: 12 September 2026
bibliography: paper.bib
---

# Summary

`Retina Tomography Viewer` is a browser application for exploring segmented
ocular micro-computed-tomography (µCT) data. It presents two linked 3D views: a
published, citable reference eye model on the left, and the toggleable segmented
tissue layers of a scanned specimen on the right. Orbiting one view mirrors onto
the other, so a segmented coat is read against the anatomy it matches, and every
structure can be hidden, recoloured, faded or clipped with slice planes. It is a
static site opened from a URL — no installation, no account, no local compute —
its dataset a CSV manifest URL supplied at run time.

# Statement of need

Segmented µCT of the eye produces surface meshes far too large to open casually:
the mouse eye shipped here is a 1.0 GB binary STL of 21.1 million triangles.
The conventional route costs a desktop install, the full download and a machine
able to hold it — reasonable for an investigator who works with the data daily,
prohibitive for everyone else.

This matters for space biology: spaceflight-associated neuro-ocular syndrome is
among the better-documented risks of long-duration spaceflight [@lee2020sans],
so ocular tissue recurs in spaceflight and analog studies. NASA's Open Science
Data Repository publishes these data openly
[@gebre2025osdr; @berrios2021genelab], but publishing a mesh is not making it
explorable: it hands back a file, and the barrier to looking at it is unchanged.

# State of the field

3D Slicer [@fedorov2012slicer] and ITK-SNAP [@yushkevich2006itksnap] do more
than this viewer — named segments, per-segment visibility, colour and opacity,
synchronised cameras — but both are desktop installs, and Slicer advises "10x
more memory than the amount of data that you load". In the browser, NiiVue
[@niivue; @eckstein2026niivue], Neuroglancer [@neuroglancer] and itk-vtk-viewer
[@itkvtkviewer] render meshes client-side, and two already bind a dataset at run
time as this viewer does: itk-vtk-viewer takes mesh URLs as `?fileToLoad=`, and
a Neuroglancer scene is a pasteable link. The Open Anatomy Browser
[@halle2017oabrowser] is closest — zero-install, manifest-described, named,
static. We claim novelty in none of this.

What none supplies is the other half of the comparison. Open Anatomy's six
atlases cover brain, liver, knee, inner ear, abdomen and thorax, not the eye;
and of six open eye-modelling projects surveyed — ISETBio, OpenRetina, V-Cornea,
OpenEyeSim, `pulse2percept`, Open Source Brain — none ships usable 3D geometry.
This viewer therefore ships its own: three published, per-structure-named eye
models with provenance, in a second camera-linked pane, so a murine segmentation
can be read against human anatomy from one link.

A multi-toggle layer panel would have been a fair contribution to
itk-vtk-viewer, whose geometry panel honours a supplied `metadata.name` but
selects one mesh at a time from a dropdown otherwise reading `Geometry 0`. The
second pane would not: each builds exactly one scene — one `vtkProxyManager` in
itk-vtk-viewer, one `THREE.Scene` in the Open Anatomy Browser, whose only other
WebGL context is a 150 × 150 orientation inset — so a second populated scene
changes a central assumption rather than extending it. Hence a small library
over three.js [@threejs], not a fork.

# Software design

**No build step, and its bill.** The site is bare ES modules behind an import
map; the deploy workflow uploads the repository tree itself, so a reviewer reads
the files the browser runs. A bundled, vendored build would ship fewer bytes and
no third-party runtime; refusing it leaves `three` and the Draco decoder
hand-pinned, fetched from public CDNs, outside the repository, and load-bearing
for the deployed viewer.

**A core that cannot tell it is in a browser.** Renderer and controls enter
through injected adapters, bytes through an injected `io`, and state leaves only
through an event emitter; a single module constructs the WebGL context. Every
consumer must therefore supply an adapter pair, and freedom from the DOM is
enforced by a denylist scan over `core/` rather than proved. In exchange the
geometry, clipping and loading logic runs under Node in seconds, and the dataset
is a manifest URL rather than a compiled-in path.

**Decimation answers a client limit, not a hosting one.** A gigabyte-scale
segmentation exceeds what a browser can fetch and hold however it is served, so
the reduction would be needed behind a tiling backend too. An error-bounded
simplifier [@meshoptimizer] holds it inside the budget reported under
Implementation, making the result an instrument for orientation and triage
rather than morphometry.

# Implementation

A documented pipeline (`tools/optimize/`) converts binary STL to glTF, welds it
into an indexed mesh, decimates it with `meshoptimizer` [@meshoptimizer] and
compresses it with Draco [@draco]; layers stream on toggle into the Cache
Storage API, so each mesh downloads at most once per browser.

`tools/bench` measures the cost as a symmetric point-to-surface distance,
sampled area-weighted over both meshes, normalised by the bounding-box diagonal:

| Source mesh | Triangles | Size | Shipped | Reduction | Mean error | p99 | Area change |
|---|---:|---:|---:|---:|---:|---:|---:|
| `eye.stl` | 21,141,576 | 1008.1 MB | 633 KB | 1631× | 0.017% | 0.062% | +0.63% |
| `feature.stl` | 3,131,220 | 149.3 MB | 325 KB | 471× | 0.006% | 0.024% | +0.21% |

Discarding 98.5% of `eye.stl`'s triangles moves the surface by 0.017% of the
diagonal on average; the worst-case (Hausdorff) distances, 3.99% and 1.10%, fall
almost entirely in the original-to-decimated direction — fragments removed, not
the principal surface displaced.

A first visit fetches about 520 KB from the site — a 177 KB shell, resolved by
walking `index.html`'s own module graph, plus the 343 KB default anatomy —
against 1.16 GB of source meshes; `three` and the Draco decoder come from CDNs
on top. The full-resolution meshes are not in the repository; `tools/bench`
recomputes every figure above from the copies published in the Hugging Face
dataset, as `tools/bench/README.md` describes.

# Reference anatomy and provenance

The left pane holds third-party published anatomy rather than NASA data:
`feelpp/mesh.eye` [@chabannes2024mesheye; @sala2024ovs], the SolidWorks CAD eye
it derives from, and the University of Patras OpenSim oculomotor model with its
six extraocular muscles [@filip2018upat] — each one named node per structure,
under its own upstream licence. The six surveyed projects that ship none stay in
the menu, disabled, each with its reason. Because these are human models while
the segmentation is murine, the interface and documentation state that the left
pane is for orientation, not cross-species morphometry.

# Research impact statement

The viewer is deployed and publicly usable, and the data behind it are open and
ungated. The segmented meshes, the CSV manifest and the source reconstruction
slices are published on Hugging Face under MIT, and so are the full-resolution
meshes the shipped assets were decimated from: 1008.1 MB of `eye.stl` and
149.3 MB of `feature.stl`. A reader can therefore fetch the originals and
recompute the reduction factors and error bounds reported above instead of
taking them on trust. `tools/bench` performs exactly that comparison, samples
both surfaces with a fixed seed so runs are reproducible, and rests on distance
code cross-checked against brute force in the test suite. Publishing the
gigabyte a 633 KB derivative came from is what makes its accuracy claim
falsifiable.

`optimized/anatomy/README.md` is a licence-and-geometry audit of nine open
eye-modelling projects: per-structure triangle counts, volumes and upstream DOIs
for the three that distribute usable 3D eye geometry
[@chabannes2024mesheye; @sala2024ovs; @filip2018upat], and a recorded check for
six that do not distribute 3D eye geometry at all. That geometry is other
groups' published work, carried here under its own GPL-3.0 and CC BY 4.0 terms;
MIT covers the viewer code only.

# Quality control

507 unit tests on Node's runner cover the data and caching layers, the geometry
code behind the reported error figures, and the core library. The core runs
headless under a stub renderer with the real orbit controls, so pane
construction, clipping, synchronisation and the loading state machines are
exercised on synthetic STL and uncompressed glTF; the shipped Draco assets are
decoded only by the browser suite. 18 Playwright tests then drive the real
application in a real browser. Continuous integration runs both and decodes
every shipped asset, so a corrupt mesh fails the build.

# AI usage disclosure

Generative AI was used in preparing this submission, and we disclose it here in full.

**Tools.** Claude (Anthropic), accessed through Claude Code, in September 2026; the models
were Claude Opus 5 (`claude-opus-5`) and Claude Fable 5.1 (`claude-fable-5-1`).

**Where and to what extent.**

- *Tests.* The unit-test suite (`test/*.test.js`, `test/core/*.test.js`) and the Playwright
  end-to-end suite (`test/e2e/viewer.spec.js`) were generated with AI assistance, from the
  authors' description of the intended behaviour, and then run, corrected and reviewed by the
  authors. Two AI-written assertions were initially wrong about the software's actual
  behaviour and were corrected against the code, not the other way round.
- *Benchmark tooling.* `tools/bench/` — the asset inventory and the point-to-surface error
  measurement (spatial hash, closest-point-on-triangle, area-weighted sampling) — was
  implemented with AI assistance. Its correctness is established by the geometry tests, which
  cross-check the spatial index against brute force; the numbers reported in this paper were
  produced by running that tool, not by the model.
- *Core-library refactor.* The extraction of the DOM-free `core/` library from the original
  monolithic `viewer.js` was carried out with AI assistance following a written architecture
  plan that the authors reviewed. Code was moved verbatim where the plan specified; each step
  was gated on the full test suite; behaviour was verified against the unchanged end-to-end
  tests.
- *Documentation and paper.* `CONTRIBUTING.md`, the README sections on testing and
  benchmarking, and the text of this paper were drafted with AI assistance and edited by the
  authors. Bibliographic entries were verified by the authors against Crossref, arXiv and
  Zenodo records.

[AUTHOR DECISION 1 — fill in truthfully: was generative AI used for the ORIGINAL application
code — viewer.js, data-loader.js, asset-loader.js, the optimize pipeline, the anatomy-model
build scripts — before September 2026? If yes, say which tools and how; if no, state that
the original application was written without AI assistance.]

**Human review.** The authors reviewed, edited and validated all AI-assisted output, ran every
test and benchmark themselves, and made the core design decisions: the two-pane linked-view
concept, the choice to ship decimated Draco assets with a documented accuracy budget, the use
of published open eye models as reference anatomy, and the survey of open eye-modelling
projects. The authors take full responsibility for the accuracy, originality and licensing of
all submitted material.

[AUTHOR DECISION 2 — this paragraph is only true if you actually do it before submitting: read
the tests, the bench code and the core/ modules, run the suites yourself, and edit anything
you would not defend in review. JOSS treats an inaccurate disclosure as an ethical breach.]

# Acknowledgements

We thank the NASA GeneLab Analysis Working Group for access to the ocular µCT
data, and the authors of `mesh.eye` and the Upatras model for publishing their
geometry openly.

[AUTHOR: replace this bracket with the truthful funding statement. JOSS asks for
all sources of financial support and whether the sponsor had any involvement in
the work. If there was none: "This work received no external funding."]

# References
