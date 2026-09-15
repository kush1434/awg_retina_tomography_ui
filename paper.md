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
    orcid: 0009-0007-3121-2961
    affiliation: 1
  - name: Jian Gong
    orcid: 0000-0000-0000-0000            # TODO: Jian's ORCID, or delete this line
    affiliation: 2
affiliations:
  - name: Del Norte High School, San Diego, CA, USA
    index: 1
  - name: University of Wyoming, Laramie, WY, USA
    index: 2
date: 14 September 2026
bibliography: paper.bib
---

# Summary

`Retina Tomography Viewer` is a browser application for exploring segmented ocular
micro-computed-tomography (µCT) data in two linked 3D views. The left pane holds a published,
citable reference eye model; the right holds the toggleable segmented tissue layers of a scanned
specimen. Orbiting one view mirrors onto the other, so a segmented coat can be read against the
anatomy it matches, and every structure can be hidden, recoloured, faded or clipped with slice
planes. It is a static site opened from a URL — no installation, no account, no gigabyte download —
its dataset a CSV manifest URL supplied at run time.

![The two panes under a shared sagittal cut, cameras linked. Left: the `mesh.eye` reference model,
ten structures each independently styled. Right: four of the five segmented µCT coats of a murine
eye, each separately streamed.\label{fig:viewer}](figure.png)

# Statement of need

Segmented µCT of the eye produces surface meshes far too large to open casually. The mouse eye
shipped here is a 1.0 GB binary STL of 21.1 million triangles, and viewing it conventionally costs
a desktop install, the full download and a machine able to hold it. That is reasonable for an
investigator who works with the data daily, and prohibitive for the researchers, reviewers and
students who need to look at it once. This matters for space biology: spaceflight-associated
neuro-ocular syndrome is among the better-documented risks of long-duration spaceflight
[@lee2020sans], so ocular tissue recurs in spaceflight and analog studies. NASA's Open Science Data
Repository publishes these data openly [@gebre2025osdr; @berrios2021genelab]. But publishing a mesh
is not the same as making it explorable: the repository hands back a file, and the barrier to
looking at it is unchanged.

# State of the field

3D Slicer [@fedorov2012slicer] and ITK-SNAP [@yushkevich2006itksnap] do more than this viewer,
including named segments, per-segment visibility, colour and opacity, and synchronised cameras.
Both are desktop installs, and Slicer's user guide advises "10x more memory than the amount of data
that you load" [@slicerdocs]. In the browser, NiiVue [@niivue; @eckstein2026niivue], Neuroglancer
[@neuroglancer] and itk-vtk-viewer [@itkvtkviewer] render meshes client-side, and two already bind
a dataset at run time as this viewer does. itk-vtk-viewer takes mesh URLs as `?fileToLoad=`, and a
Neuroglancer scene is a pasteable link. The Open Anatomy Browser [@halle2017oabrowser] is closest,
being zero-install, manifest-described, named and static. We claim novelty in none of this.

What none supplies is the other half of the comparison. None of the Open Anatomy atlases is ocular,
and of six open eye-modelling projects we surveyed (ISETBio, OpenRetina, V-Cornea, OpenEyeSim,
`pulse2percept` and Open Source Brain) none ships usable 3D geometry. This viewer therefore ships
its own: three published eye models with per-structure names and provenance, in a second
camera-linked pane. A multi-toggle layer panel would have been a fair contribution to
itk-vtk-viewer, whose geometry panel selects one mesh at a time. The second pane would not: each of
those tools builds exactly one scene — one `vtkProxyManager` in itk-vtk-viewer, one `THREE.Scene`
in the Open Anatomy Browser — so a second populated scene changes a central assumption instead of
extending it. Hence a small library over three.js [@threejs], not a fork.

# Software design

The site is bare ES modules behind an import map, and the deploy workflow uploads the repository
tree itself, so a reviewer reads the files the browser runs. A bundled, vendored build would ship
fewer bytes and no third-party runtime. Refusing it leaves `three` (pinned at r169) and the Draco
decoder (gstatic 1.5.7) hand-pinned, fetched from public CDNs, outside the repository, and
load-bearing for the deployed viewer.

The core library cannot tell that it is running in a browser. Renderer and controls enter through
injected adapters, bytes through an injected `io`, state leaves only through an event emitter, and
a single module constructs the WebGL context. Every consumer must therefore supply an adapter
pair, and freedom from the DOM is enforced by a denylist scan over `core/` rather than proved. In
exchange the geometry, clipping and loading logic runs under Node in seconds, and the dataset is a
manifest URL, not a compiled-in path.

Decimation answers a client limit, not a hosting one. A gigabyte-scale segmentation exceeds what a
browser can fetch and hold however it is served, so the reduction would be needed behind a tiling
backend as well. An error-bounded simplifier [@meshoptimizer] holds the mesh inside the budget
reported below, which makes the result an instrument for orientation and triage rather than for
morphometry.

# Implementation

A documented pipeline (`tools/optimize/`) converts binary STL to glTF, welds it into an indexed
mesh, decimates it with `meshoptimizer` [@meshoptimizer] and compresses it with Draco [@draco].
Layers stream on toggle into the Cache Storage API, so each mesh downloads at most once per
browser.

`tools/bench` measures the cost as a symmetric point-to-surface distance, sampled area-weighted
over both meshes and normalised by the bounding-box diagonal.

| Source mesh | Triangles | Size | Shipped | Size reduction | Mean error | p99 | Area change |
|---|---:|---:|---:|---:|---:|---:|---:|
| `eye.stl` | 21,141,576 | 1008.1 MB | 633 KB | 1631× | 0.017% | 0.062% | +0.63% |
| `feature.stl` | 3,131,220 | 149.3 MB | 325 KB | 471× | 0.006% | 0.024% | +0.21% |

Discarding 98.5% of `eye.stl`'s triangles moves the surface by 0.017% of the diagonal on average.
The worst-case (Hausdorff) distances, 3.99% and 1.10%, fall almost entirely in the
original-to-decimated direction, consistent with fragments having been removed rather than the
principal surface displaced. A first visit transfers about 405 KB: a 190 KB shell — resolved by
walking `index.html`'s own module graph, served gzipped at 61 KB — plus the 343 KB
Draco-compressed anatomy, against 1.13 GB of source meshes, with `three` and the Draco decoder
fetched from CDNs on top.

# Reference anatomy and provenance

The left pane holds third-party published anatomy, not NASA data: `feelpp/mesh.eye`
[@chabannes2024mesheye; @sala2024ovs], the SolidWorks CAD eye it derives from, and the Upatras
OpenSim oculomotor model with its six extraocular muscles [@filip2018upat], each with one named
node per structure under its own upstream licence. The surveyed projects that ship none stay in
the menu, disabled, each with its reason. Because these models are human while the segmentation is
murine, the interface and the documentation state that the left pane is for orientation, not
cross-species morphometry.

# Research impact statement

The NASA GeneLab Analysis Working Group, for whom the viewer was built, has used it to load the
segmented µCT data and compare structures across it; the specimen in \autoref{fig:viewer} is that
data.

The viewer is deployed and publicly usable, and the data behind it are open and ungated. The
segmented meshes, the CSV manifest, the source reconstruction slices and the full-resolution
meshes the shipped assets were decimated from are not in the repository but are published under
MIT at <https://huggingface.co/datasets/kush1434/awg_retina_tomography_ui>, so a reader can
recompute the reduction factors and error bounds above instead of taking them on trust:
publishing the gigabyte a 633 KB derivative came from is what makes its accuracy claim
falsifiable. `tools/bench` samples with a fixed seed so runs are reproducible, and rests on
distance code cross-checked against brute force in the test suite.

`optimized/anatomy/README.md` is a licence-and-geometry audit of nine entries from eight open
eye-modelling projects. It reports per-structure triangle counts, volumes and upstream DOIs for
the three that distribute usable 3D eye geometry [@chabannes2024mesheye; @sala2024ovs;
@filip2018upat], and a recorded check for the six that distribute none. That geometry is other
groups' published work, carried under its own GPL-3.0 and CC BY 4.0 terms; MIT covers the viewer
code only.

# Quality control

507 unit tests on Node's built-in runner cover the data and caching layers, the geometry code
behind the reported error figures, and the core library. The core runs headless under a stub
renderer with the real orbit controls, so pane construction, clipping, synchronisation and the
loading state machines are exercised on synthetic STL and uncompressed glTF; the shipped Draco
assets are decoded only by the browser suite. 18 Playwright tests then drive the real application
in Chromium. CI runs the unit suite on Node 20 and 22, the browser suite on 22, and decodes every
shipped asset, so a corrupt mesh fails the build.

# AI usage disclosure

Generative AI was used in preparing this submission. The tools were Claude (Anthropic), accessed
through Claude Code, in September 2026, using Claude Opus 5 (`claude-opus-5`) and Claude Fable 5.1
(`claude-fable-5-1`).

- *Tests.* The unit-test suite (`test/*.test.js`, `test/core/*.test.js`) and the Playwright
  end-to-end suite (`test/e2e/viewer.spec.js`) were generated with AI assistance from the authors'
  description of the intended behaviour, then run, corrected and reviewed by the authors. Two
  AI-written assertions were wrong about the software's behaviour and were corrected against the
  code, not the other way round.
- *Benchmark tooling.* `tools/bench/`, the asset inventory and the point-to-surface error
  measurement (spatial hash, closest-point-on-triangle, area-weighted sampling), was implemented
  with AI assistance. Its correctness rests on the geometry tests, which cross-check the spatial
  index against brute force, and the numbers reported here were produced by running the tool, not
  by the model.
- *Core-library refactor.* The DOM-free `core/` library was extracted from the monolithic
  `viewer.js` with AI assistance, following a written architecture plan the authors reviewed.
  Code was moved verbatim where the plan specified, each step was gated on the full test suite,
  and behaviour was verified against the unchanged end-to-end tests.
- *Documentation and paper.* `CONTRIBUTING.md`, the README sections on testing and benchmarking,
  and the text of this paper were drafted with AI assistance and edited by the authors. The authors
  verified bibliographic entries against Crossref, arXiv and Zenodo records.

- *The original application.* The viewer as it existed before this submission — `viewer.js`,
  `data-loader.js`, `asset-loader.js`, the optimisation pipeline and the anatomy-model build
  scripts, developed between October 2025 and August 2026 — was also written with AI assistance,
  using Claude through Claude Code. [AUTHOR: confirm this names every tool used in that earlier
  period, and correct it if others were. JOSS requires the tools and models, and where each was
  used.]

The authors reviewed, edited and validated all AI-assisted output, ran every test and benchmark
themselves, and made the core design decisions: the two-pane linked-view concept, the choice to
ship decimated Draco assets with a documented accuracy budget, the use of published open eye
models as reference anatomy, and the survey of open eye-modelling projects. The authors take full
responsibility for the accuracy, originality and licensing of all submitted material.

# Acknowledgements

We thank the NASA GeneLab Analysis Working Group for access to the ocular µCT data, and the
authors of `mesh.eye` and the Upatras model for publishing their geometry openly. This work
received no external funding.

# References
