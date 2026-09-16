# Original anatomy scaffolds

These MIT constructions expose a limited set of spatial claims for checking.
The rectangular map is a debugging view; its visual design was rejected as a
teaching illustration. A finished schematic needs recognisable
structures and clear visual teaching. Realistic surfaces are optional and do not
provide evidence that the anatomy is correct.

`left-cdh.json` describes a selected left congenital diaphragmatic hernia using
paired frontal occupancy maps and a separate caudal location map. The renderer
is currently a CDH template, not a general organ-layout engine. Blocks represent
compartments and occupancy, not organ contours, tissue layers or a literal section.

```bash
node --import tsx scripts/images/anatomy-scaffold.ts \
  scripts/images/anatomy-scaffolds/left-cdh.json \
  output/anatomy-scaffolds/left-cdh.svg
npx vitest run scripts/images/anatomy-scaffold.test.ts
```

The SVG embeds the source evidence, construction status and geometry digest.
The adjacent checks JSON records the evaluated relationships. Two named palettes
share identical geometry; labels and displacement arrows derive from the saved
coordinates. The construction catches reversed sides, invalid bounds, wrong
compartments in either comparison, organ overlap, disconnected occupancy,
corner-only connections, passage across an intact boundary and invalid apertures.

For another anatomical subject, author a separate source-backed specification and
renderer with its own meaningful constraints. Fix projection and axes first;
name the structures, contents, boundaries and connections; place label endpoints;
then encode failures that would change the teaching. Inspect the reference figure
itself for claims that depend on spatial relationships. Record the exact figure
and which relationship it establishes. Do not trace restricted source contours.

Render and inspect at full and card size. An independent reviewer must compare
the actual geometry with its sources and intended teaching scope. Construction
tests establish only the encoded constraints. They cannot establish completeness,
clinical accuracy or exact text fit. The current example remains a construction
draft, separate from the accepted raster collection and its image-count target.

If using image generation for a later style pass, provide the original scaffold,
preserve its topology and label targets, and compare the generated pixels with
the exact scaffold. Hold outputs that move or invent structures. Keep accepted
schematics, their specifications, evidence and licences together for reuse.

The curved-organ revision is in `open-content/anatomy-scaffolds/left-cdh`.
It received separate source and pixel reviews for its limited anterior-cutaway,
bowel-only scope. It makes no posterior defect-location claim. Passing the
rectangular-map tests does not validate that revised geometry. Its labels use
the separate annotation tool, with image-specific region and endpoint checks.
Keep structural debugging information and review records outside the teaching
illustration.
