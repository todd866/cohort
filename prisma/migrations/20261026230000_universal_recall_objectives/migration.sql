-- Content registration only: no learner progress or queues are changed.
-- Stable IDs intentionally bypass MDX cloze splitting. Existing rows are not overwritten.
INSERT INTO "Card" ("id", "stableId", "cardType", "rotation", "sourceComponent", "front", "back", "topics", "moduleNodes", "complexity")
VALUES
('universal-recall:arrest-hs:v1', 'universal-recall:arrest-hs:v1', 'cloze', 'universal-core', 'UniversalRecall',
 'List all four H categories of reversible cardiac arrest causes.',
 'Hypoxaemia; hypovolaemia; hyper/hypokalaemia and metabolic disorders; hypo/hyperthermia',
 ARRAY['universal-recall', 'resuscitation'], ARRAY[]::text[], 2),
('universal-recall:arrest-ts:v1', 'universal-recall:arrest-ts:v1', 'cloze', 'universal-core', 'UniversalRecall',
 'List all four T categories of reversible cardiac arrest causes.',
 'Tension pneumothorax; tamponade; toxins, poisons or drugs; pulmonary or coronary thrombosis',
 ARRAY['universal-recall', 'resuscitation'], ARRAY[]::text[], 2)
ON CONFLICT DO NOTHING;
