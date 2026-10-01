# Left congenital diaphragmatic hernia

An original, simplified teaching diagram with editable labels. This example
shows one possible bowel-only pattern. It teaches the relationship between
herniated bowel, a smaller left lung and displacement of the heart toward the
patient's right. It does not establish the three-dimensional defect location
or reproduce every possible organ position in congenital diaphragmatic hernia.

The base image and final annotations received separate source and pixel
reviews by AI agents. No clinician signoff is claimed. Source facts and the
scope of those reviews are recorded in `source-review.json` and `labels.json`.

## Reuse

Everything in this folder is released under the included MIT licence. Copy,
edit, translate or include it in a deck; retain the licence notice. Third-party
reference images were inspected for anatomy, but their pixels were not used
as generation inputs or traced into this artwork.

- `diagram.svg` embeds the exact original PNG with editable SVG labels.
- `base.png` is the unlabelled drawing. Its hash is pinned in `labels.json`.
- `labels.json` contains reviewed label regions, endpoints and source facts.
- `shape-guide.svg` is the original construction guide used for generation.
  It is a development input, not the final illustration.
- The prompt files record generation and subsequent style and label-removal
  instructions. Generated candidates were reviewed separately from the guide.

The initial generation prompt also refers to the earlier original block map.
That historical debugging input can be regenerated with
`scripts/images/anatomy-scaffold.ts` from
`scripts/images/anatomy-scaffolds/left-cdh.json`. Its caudal inset was removed in
the later flattening pass. It is not part of the final illustration or needed
to regenerate its labels.

To regenerate the annotated SVG from the MD3 repository root:

```sh
node --import tsx scripts/images/anatomy-annotations.ts labels.json diagram.svg --root open-content/anatomy-scaffolds/left-cdh
```

The sibling checks receipt verifies the image integrity and that each anchor
is inside its declared region. Those regions are small, reviewed label patches,
not full organ masks. Editing their geometry still requires visible comparison
with the image. Passing geometry checks alone does not validate anatomy.

This anatomy example is separate from the 105-image conceptual collection and
has not been attached to live study cards.
