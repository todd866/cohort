# MD3 content licence

MD3 uses separate licences for software and educational content.

The educational material is provided for learning purposes only, is not
medical advice, and comes without any warranty of accuracy, completeness, or
currency. Clinical decisions should use current authoritative sources and
qualified healthcare professionals.

- Software source code is licensed under the MIT License in [`LICENSE`](./LICENSE).
- Original educational prose, questions, cards, diagrams, and documentation
  authored by MD3 contributors are licensed under the
  [Creative Commons Attribution 4.0 International licence](https://creativecommons.org/licenses/by/4.0/)
  (`CC-BY-4.0`). Attribution may be given as “MD3 contributors” with a link to
  the repository.

This grant covers contributor-owned MD3 material whether it is used in MD3 or
later reused by Cohort. The automated public-product boundary remains
deliberately fail-closed: a learning item must still be explicitly marked
`CC-BY-4.0` (or listed in a cleared-content manifest) before MD3 serves or
exports it. File presence alone is never evidence that third-party material
was authored by an MD3 contributor.

The following remain excluded unless their own compatible licence and
attribution are recorded:

- imported or derived AnKing and other Anki-deck material;
- First Aid, textbook, lecture, question-bank, social-media, and other
  third-party source material;
- third-party images, video, audio, figures, and quoted evidence;
- content with unknown or incomplete provenance.

Compatibly licensed third-party content, if later admitted, keeps its own
per-item licence and attribution. For example, a `CC-BY-SA-4.0` item is not
relicensed under MD3's default `CC-BY-4.0` grant, and downstream distributions
must honor its share-alike terms.

The exact evidence passages in `open-content/usmle/step1/sources.json` retain
the per-source terms and attribution recorded beside each passage; MD3's CC BY
grant does not relicense those quotations.

An MD3-authored learning item and the evidence quoted beside it are separate
works. The current FOSS release accepts only evidence passages with compatible
redistribution terms; a citation to restricted material cannot place its quote
inside the checked-in source registry or public export.

Until provenance metadata is complete, public exporters and USMLE loaders
must exclude unmarked content rather than infer permission from a source name,
file location, or absent copyright notice.
