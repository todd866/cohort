-- Put human-authored flag prose behind an explicit admin review boundary.
-- Agent workflows read ContentIssue metadata, so raw reporter text must not
-- remain in metadata or CardProgress.flagContext.

ALTER TABLE "ContentIssue"
  ADD COLUMN IF NOT EXISTS "reportTrustState" TEXT NOT NULL DEFAULT 'trusted',
  ADD COLUMN IF NOT EXISTS "quarantinedMessage" TEXT,
  ADD COLUMN IF NOT EXISTS "quarantinedContext" JSONB,
  ADD COLUMN IF NOT EXISTS "approvedSummary" TEXT,
  ADD COLUMN IF NOT EXISTS "trustReviewedAt" TIMESTAMPTZ(3),
  ADD COLUMN IF NOT EXISTS "trustReviewedBy" TEXT;

-- Preserve raw legacy message / user-agent / client snapshot for the admin
-- review surface, but remove them from agent-visible fields. The canonical
-- card/question snapshot is restored below.
UPDATE "ContentIssue" AS issue
SET
  "quarantinedMessage" = COALESCE(
    issue."quarantinedMessage",
    NULLIF(BTRIM(issue.metadata ->> 'message'), '')
  ),
  "quarantinedContext" = COALESCE(issue."quarantinedContext", NULLIF(
    jsonb_strip_nulls(jsonb_build_object(
      'userAgent', issue.metadata #> '{render,ua}',
      'clientContentSnapshot', to_jsonb(issue."contentSnapshot"),
      'legacyPath', to_jsonb(issue.path)
    )),
    '{}'::jsonb
  )),
  "reportTrustState" = CASE
    WHEN NULLIF(BTRIM(issue.metadata ->> 'message'), '') IS NULL THEN 'structured'
    ELSE 'quarantined'
  END,
  metadata = (issue.metadata - 'message') #- '{render,ua}',
  path = NULL,
  rotation = CASE
    WHEN issue.rotation ~ '^[a-z0-9][a-z0-9-]{0,49}$' THEN issue.rotation
    ELSE NULL
  END,
  "contentSnapshot" = CASE
    WHEN issue."targetType" = 'card' THEN (
      SELECT LEFT(card.front, 200)
      FROM "Card" AS card
      WHERE card.id = issue."targetId"
    )
    WHEN issue."targetType" = 'question' THEN (
      SELECT LEFT(question.stem, 200)
      FROM "Question" AS question
      WHERE question.id = issue."targetId"
    )
    ELSE NULL
  END
WHERE issue."reportTrustState" = 'trusted'
  AND issue.metadata ->> 'reporterType' IN ('user', 'external', 'external-anki', 'anonymous');

-- Older card-flag writers sometimes put the note only in flagContext. Preserve
-- it when the context carries a valid issue link before clearing that state.
UPDATE "ContentIssue" AS issue
SET
  "quarantinedMessage" = NULLIF(BTRIM(progress."flagContext" ->> 'message'), ''),
  "reportTrustState" = 'quarantined'
FROM "CardProgress" AS progress
WHERE jsonb_typeof(progress."flagContext") = 'object'
  AND progress."flagContext" ->> 'issueId' = issue.id
  AND issue."quarantinedMessage" IS NULL
  AND NULLIF(BTRIM(progress."flagContext" ->> 'message'), '') IS NOT NULL;

-- CardProgress is user-facing state, not the report-review store. Keep its
-- issue link and structured render numbers, but remove reporter prose and UA.
UPDATE "CardProgress"
SET "flagContext" = ("flagContext" - 'message') #- '{render,ua}'
WHERE "flagContext" IS NOT NULL
  AND jsonb_typeof("flagContext") = 'object';

UPDATE "CardProgress"
SET "flagContext" = NULL
WHERE "flagContext" IS NOT NULL
  AND jsonb_typeof("flagContext") <> 'object';

-- Fail closed during the migrate-to-application window. The old application
-- omits this new column, so any late report must land quarantined instead of
-- inheriting trusted agent-workflow access. Internal writers in the compatible
-- application set `trusted` explicitly.
ALTER TABLE "ContentIssue"
  ALTER COLUMN "reportTrustState" SET DEFAULT 'quarantined';

CREATE INDEX IF NOT EXISTS "ContentIssue_reportTrustState_idx"
  ON "ContentIssue" ("reportTrustState");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'ContentIssue_report_trust_state_check'
      AND conrelid = '"ContentIssue"'::regclass
  ) THEN
    ALTER TABLE "ContentIssue"
      ADD CONSTRAINT "ContentIssue_report_trust_state_check"
      CHECK ("reportTrustState" IN ('trusted', 'structured', 'quarantined', 'approved', 'rejected'));
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'ContentIssue_approved_report_has_review_check'
      AND conrelid = '"ContentIssue"'::regclass
  ) THEN
    ALTER TABLE "ContentIssue"
      ADD CONSTRAINT "ContentIssue_approved_report_has_review_check"
      CHECK (
        "reportTrustState" <> 'approved'
        OR (
          NULLIF(BTRIM("approvedSummary"), '') IS NOT NULL
          AND "trustReviewedAt" IS NOT NULL
          AND "trustReviewedBy" IS NOT NULL
        )
      );
  END IF;
END
$$;
