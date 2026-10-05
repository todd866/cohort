-- Private, derived feedback-search vectors. This mirrors the guarded provision
-- DDL in scripts/audit/feedback-search-store.ts so a fresh database and an
-- already-provisioned production database converge without data changes.
CREATE TABLE IF NOT EXISTS feedback_search_embeddings (
  source_key text PRIMARY KEY,
  source_kind text NOT NULL,
  source_id text NOT NULL,
  issue_id text UNIQUE REFERENCES "ContentIssue"(id) ON DELETE CASCADE,
  feedback_id text UNIQUE REFERENCES "UserFeedback"(id) ON DELETE CASCADE,
  card_progress_id text UNIQUE REFERENCES "CardProgress"(id) ON DELETE CASCADE,
  question_response_id text UNIQUE REFERENCES "QuestionResponse"(id) ON DELETE CASCADE,
  source_revision text NOT NULL,
  document_hash text NOT NULL,
  text_coverage text NOT NULL CHECK (text_coverage IN ('approved-summary', 'structured-only')),
  model text NOT NULL,
  dimensions integer NOT NULL CHECK (dimensions = 3072),
  embedding halfvec(3072) NOT NULL,
  indexed_at timestamptz(3) NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(issue_id, feedback_id, card_progress_id, question_response_id) = 1),
  CHECK (source_id = COALESCE(issue_id, feedback_id, card_progress_id, question_response_id)),
  CHECK (source_kind = CASE
    WHEN issue_id IS NOT NULL THEN 'content-issue'
    WHEN feedback_id IS NOT NULL THEN 'user-feedback'
    WHEN card_progress_id IS NOT NULL THEN 'card-flag'
    ELSE 'question-flag'
  END),
  CHECK (source_key = source_kind || ':' || source_id)
);

CREATE INDEX IF NOT EXISTS feedback_search_document_hash_idx
  ON feedback_search_embeddings(document_hash, model, dimensions);

CREATE INDEX IF NOT EXISTS feedback_search_cosine_idx
  ON feedback_search_embeddings USING hnsw (embedding halfvec_cosine_ops);

-- Updates invalidate derived vectors immediately, including trust revocation
-- and anonymisation of a ContentIssue. CREATE OR REPLACE keeps this safe when
-- the private provision command has already installed the same trigger.
CREATE OR REPLACE FUNCTION invalidate_feedback_search_issue()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM feedback_search_embeddings WHERE issue_id = NEW.id;
  RETURN NEW;
END
$$;

CREATE OR REPLACE TRIGGER feedback_search_issue_changed
AFTER UPDATE ON "ContentIssue"
FOR EACH ROW
EXECUTE FUNCTION invalidate_feedback_search_issue();
