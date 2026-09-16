# MD3 original medical diagrams

Warm hand-painted educational illustrations, free to copy, edit, translate,
teach with, put in Anki decks, and redistribute under the [MIT licence](LICENSE).
Keep the licence notice with redistributed copies.

Download the Anki decks and source bundles from the
[public diagram gallery](https://md3.info/diagrams). Large collections are divided into
numbered volumes: import every Anki volume for the full deck, or extract every
source ZIP into the same directory for the complete collection. The
[release manifest](https://md3.info/downloads/md3-original-diagrams.manifest.json)
lists every file with its size and checksum. These downloads are served by the
MD3 build containing this collection.

Each figure has its own Anki note. The bundle contains the full-size PNGs,
original generation/edit prompts, conceptual scaffolds, source references, review notes and exact
SHA-256 checksums in [manifest.json](manifest.json). There are no patient images
or textbook image files in this collection. The original written clinical
specifications were illustrated with OpenAI's built-in ImageGen tool; its exact
backend model identifier was not exposed.

## Figures

Browse the [complete illustrated gallery](https://md3.info/diagrams), or use
[manifest.json](manifest.json) as the machine-readable inventory. Every entry
records the full-size image, teaching point, source references and review status.

## Reuse

Drag a PNG into an Anki field, document or presentation. To use it on a website,
copy the file to your own image directory and supply descriptive alternative text:

```html
<img src="gowers-sign-standing-sequence.png"
     alt="Four stages of the Gowers manoeuvre when rising from the floor">
```

For an image question, keep the answer-bearing title, caption and explanation on
the answer side. The manifest contains a separate original question and answer
for each figure. New diagrams keep generic disclaimers and generation provenance
out of the image. A short qualifier stays beside a claim only when it changes
the teaching meaning; collection provenance and review notes live in the manifest.

These are deliberately simplified teaching diagrams. Review records distinguish
agent visual/source checks from clinician review; acceptance in this collection
does not claim human clinical validation. Clinical sources ground the facts,
and do not license third-party figures for inclusion here.

## Rebuild and contribute

The complete MD3 repository contains the deterministic ZIP and Anki builder in
`scripts/export/build_medical_figures.py`. This collection is independently
reusable without the application or its private build tooling.

For new work, follow the [authoring guide](../../docs/workflows/medical-diagram-authoring.md)
and [pedagogy research](../../docs/designs/2026-09-13-textbook-diagram-pedagogy-research.md).
Use normal MD3 flashcards: hide one retrieval target, retain useful neighbouring
labels, then reveal a brief answer. Label counts follow the anatomy and teaching
purpose; authoring controls and QA records stay out of the learner card.

Recognisable anatomy in a restrained atlas style is welcome. Generate an
unlabelled base and add reviewed editable labels with the
[annotation module](../../scripts/images/anatomy-annotations.ts). Independent
source/endpoint review, complete revision checks and full-size/phone inspection
are specified in the guide. Preserve the original bytes, hashes and records.

The MIT release currently admits conceptual figures only; this is a tooling
limit. Netter-derived flashcards use a separate personal MD3.info workflow with
an explicit owner-managed copyright whitelist. They retain their source
copyright and never enter this MIT collection, Cohort.md FOSS or public exports.
A paywall does not substitute for the whitelist.
