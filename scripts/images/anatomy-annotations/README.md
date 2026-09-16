# Labels over a reviewed PNG

This specification adds editable SVG text and leader lines to an existing PNG.
The renderer embeds the original PNG bytes as a data URI at their natural width
and height. It does not redraw, crop, paint over or otherwise alter those bytes.

The checked region polygons bind each label anchor to a named part of the
image. A successful render establishes that the coordinates and declared
regions satisfy the geometric contract. It does not establish that a region
is the organ claimed, that the source image is anatomically correct, or that a
medical professional has approved it.

## Author and render

1. Start with `example.json`, which is deliberately an unrenderable draft.
   It contains abstract rectangles, a missing image path, a placeholder hash
   and placeholder source links. It supplies no reviewed anatomy.
2. Choose an existing PNG and record its exact SHA-256 hash and natural pixel
   dimensions. Review the image itself and write concrete review notes.
3. Define a simple polygon for each named region, in the same pixel coordinate
   system. Record the source URL and the specific fact it supports. Inspect
   the polygon against the actual image before recording its review.
4. Add labels. Put each `anchor` strictly inside its `targetRegion`, then place
   its `elbow` and `textPosition` for a clear leader line. Review the wording,
   leader destination and surrounding anatomy together.
5. Change the base-image and region review statuses to `agent-reviewed` only
   after that review has actually happened. Keep the notes. Run the renderer:

```sh
node --import tsx scripts/images/anatomy-annotations.ts path/to/spec.json path/to/output.svg --root /absolute/project/root
```

`--root` defaults to the current working directory. The specification path,
`baseImage.file` and output path must be safe paths relative to that root.
Absolute file arguments, traversal, backslashes, symlinks and non-regular
input files are rejected. The root itself is the explicit filesystem boundary.

The renderer writes the SVG and a sibling checks receipt ending in
`.checks.json`. Provenance is embedded in SVG metadata. The same accepted
inputs produce deterministic outputs; receipts contain no run timestamps.
Inspect the SVG in a browser or vector editor at its natural size, then zoom
to every leader endpoint. Check label readability, line crossings, text
overlap and canvas edges as well as anatomical placement. Open the checks
receipt alongside the specification when reviewing the result.

## Coordinate and validation contract

- The canvas is exactly the PNG's natural dimensions, with origin `(0, 0)` at
  the top left, x increasing rightward and y increasing downward. Every point
  is a finite `[x, y]` pair within inclusive bounds `0..width` and `0..height`.
- Region polygons are implicitly closed and contain at least three unique
  vertices. They must be simple: no holes, self-intersections, degenerate
  edges, overlapping adjacent edges or adjacent backtracking.
- A label's anchor must be strictly inside its named region. An anchor on the
  boundary, or within the `1e-7` pixel boundary tolerance, is rejected.
- Region and label IDs share one unique namespace. The specification's own
  `id` is separate. Every `targetRegion` must name a declared region.
- Each region needs at least one HTTPS source URL and a nonempty fact, plus
  review notes. Source URLs must have no credentials or whitespace. Links
  record supporting evidence; their presence does not prove a mask is right.
- Base-image and region reviews must be `agent-reviewed` to render. `draft`
  is an authoring state allowed by the schema, not a render approval. Agent
  review is distinct from clinician approval.
- Unknown fields are rejected at every object level. Optional text alignment
  is `start`, `middle` or `end`; an optional font size must be positive and
  finite. Titles and footers use the same coordinate system as labels.
- Optional `textBlocks` add panel titles or orientation markers using the same
  `{text, position, align?, fontSize?}` fields as the title and footer. They
  have no `targetRegion`; do not invent anatomical regions for headings. Their
  positions must still lie within the full canvas.

`schema.json` checks the document shape. Runtime checks additionally enforce
the image hash and PNG dimensions, coordinate upper bounds, reference
membership, ID uniqueness, polygon geometry, anchor containment and filesystem
safety. Passing JSON Schema alone does not authorize rendering or publishing.

The PNG check verifies chunk CRCs, supported header methods, palette presence
when required, and bounded decompression with the expected scanline lengths
and filter bytes (including Adam7 images). Input files are limited to 50 MiB;
decoded scanlines are limited to 256 MiB. This is format validation, not an
anatomical image classifier. Invalid inputs fail before either output is written.
Existing outputs are replaced through temporary files; SVG and receipt are two
separate files, so check the receipt's `svgSha256` after an interrupted run.

Keep corrections to labels and leaders in the specification and regenerate
the SVG. This tool does not perform SVG-to-PNG editing. Any separate raster
export is another artifact to inspect and cannot replace the original PNG's
hash or the geometry receipt.
