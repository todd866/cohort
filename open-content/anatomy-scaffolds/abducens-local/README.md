# Abducens nerve and lateral rectus

An original illustration of the right lateral rectus, its motor nerve and the
neighbouring optic nerve, viewed obliquely from above. It supports teaching how
CN VI produces eye abduction and why a peripheral lesion causes impaired
abduction. It is not a complete orbital dissection.

The motor nerve approaches the muscle's deep, globe-facing side. Its actual
penetration point is hidden. The orbital apex, muscle origin, common tendinous
ring and intracranial course are outside this drawing's scope; do not use it to
assess those structures or surgical entry locations.

## Reuse

The files in this folder are released under the included MIT licence. The base
was generated from our own simple construction drawing and a text brief. No
atlas, cadaver photograph or other third-party image was supplied to generation.

- `base.png` is the unlabelled illustration.
- `diagram.svg` embeds that exact base and adds editable labels.
- `served.svg` adds the complete MIT notice as nonvisual SVG metadata for downloads.
- `labels.json` records the image hash, reviewed anchor patches and sources.
- `construction.svg` and `generation-prompt.txt` preserve the generation input.
- `source-review.json` records review scope, provenance and limitations.

Regenerate labels from the repository root:

```sh
node --import tsx scripts/images/anatomy-annotations.ts labels.json diagram.svg --root open-content/anatomy-scaffolds/abducens-local
```

Independent AI reviews examined the unlabelled pixels and the final labelled
image, including its readability at 375 pixels wide. This is not clinician
signoff. Geometry checks verify anchor placement, not anatomical truth.
The image is a reviewed reusable artifact; publication here does not itself
attach it to live study cards.
