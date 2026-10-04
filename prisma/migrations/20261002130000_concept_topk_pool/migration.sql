-- Precomputed concept top-K (docs/designs/2026-10-02-neon-scale.md, section 1).
--
-- Every statement is idempotent (IF NOT EXISTS, CREATE OR REPLACE). Whether a
-- failure part-way (a CREATE TRIGGER that waits past the release's 5 s
-- lock_timeout) can leave earlier objects committed depends on how the
-- migration engine sends the file; idempotence makes recovery the same either
-- way. Recovery is then
-- `prisma migrate resolve --rolled-back 20261002130000_concept_topk_pool` and
-- a re-run, which completes whatever is missing. Run the release while no seed
-- or embed holds row locks on Card or Question.
--
-- The scheduler's concept top-K is the same for every learner who shares a
-- rotation, locale and cross-source scope, yet every scheduler pass recomputed
-- it over the embedding tables. These tables hold it precomputed per
-- (item type, concept, partition, locale class); the read path merges a
-- session's partitions and falls back to the live query for anything missing
-- or stale.
--
-- Freshness is enforced by triggers, not by asking every content writer to
-- remember a version bump. Each trigger APPENDS to "CandidatePoolChange"; a
-- scope's epoch is the SUM of its weights. Appends never block one another, so
-- a long seed transaction cannot stall a request that shelves a card, and no
-- pair of writers can deadlock on a shared counter row. Compaction replaces a
-- scope's rows with one row carrying their summed weight, so the epoch never
-- goes backwards. A partition built from a snapshot that preceded a change sees
-- a larger epoch afterwards and is treated as stale.

CREATE TABLE IF NOT EXISTS "CandidatePoolChange" (
    "id" BIGSERIAL NOT NULL,
    "scope" TEXT NOT NULL,
    "weight" BIGINT NOT NULL DEFAULT 1,
    "changedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CandidatePoolChange_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "CandidatePoolChange_scope_idx" ON "CandidatePoolChange" ("scope");

CREATE TABLE IF NOT EXISTS "ConceptTopKPartition" (
    "itemType" TEXT NOT NULL,
    "partition" TEXT NOT NULL,
    "sessionRotation" TEXT NOT NULL,
    "localeClasses" TEXT[] NOT NULL,
    "itemEpoch" BIGINT NOT NULL,
    "conceptEpoch" BIGINT NOT NULL,
    "topK" INTEGER NOT NULL,
    "conceptCount" INTEGER NOT NULL,
    "buildMs" INTEGER NOT NULL,
    "builtAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConceptTopKPartition_pkey" PRIMARY KEY ("itemType", "partition")
);

CREATE TABLE IF NOT EXISTS "ConceptTopKList" (
    "itemType" TEXT NOT NULL,
    "partition" TEXT NOT NULL,
    "conceptId" TEXT NOT NULL,
    "localeClass" TEXT NOT NULL,
    "itemIds" TEXT[] NOT NULL,
    "similarities" DOUBLE PRECISION[] NOT NULL,
    "builtAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConceptTopKList_pkey" PRIMARY KEY ("itemType", "partition", "conceptId", "localeClass"),
    CONSTRAINT "ConceptTopKList_parallel_arrays" CHECK (cardinality("itemIds") = cardinality("similarities"))
);

-- The last full plan and the state it saw. Planning scans "Card" and
-- "Question", so the refresh plans again only when that state has moved (an
-- item epoch, the rotations with concepts, a missing manifest) or the plan is
-- six hours old; a run with nothing changed reads only the small tables.
CREATE TABLE IF NOT EXISTS "ConceptTopKPlan" (
    "id" TEXT NOT NULL,
    "itemEpochTotal" BIGINT NOT NULL,
    "sessionRotations" TEXT[] NOT NULL,
    "partitionCount" INTEGER NOT NULL,
    "plannedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConceptTopKPlan_pkey" PRIMARY KEY ("id")
);

-- A partition build that failed recently. The refresh skips it for a while
-- instead of spending its statement ceiling on it every run; a successful
-- build deletes the row.
CREATE TABLE IF NOT EXISTS "ConceptTopKBuildFailure" (
    "itemType" TEXT NOT NULL,
    "partition" TEXT NOT NULL,
    "error" TEXT NOT NULL,
    "failedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConceptTopKBuildFailure_pkey" PRIMARY KEY ("itemType", "partition")
);

-- From here to the INSERT that ends the embedding-table section, every statement
-- is also in src/lib/manifold/concept-topk-triggers.ts, verbatim:
-- scripts/manifold/setup-manifold.ts runs that copy after it recreates the
-- embedding tables, and a test fails if the two differ.

-- One append per distinct scope; NULLs (a join that found no parent) are skipped.
CREATE OR REPLACE FUNCTION "concept_topk_record_changes"(scopes TEXT[])
RETURNS void
LANGUAGE sql
AS $$
    INSERT INTO "CandidatePoolChange" ("scope")
    SELECT DISTINCT s FROM unnest(scopes) AS s WHERE s IS NOT NULL;
$$;

-- TRUNCATE fires no row or DELETE trigger, and everything built from the table
-- goes with it. Mark every scope of the truncated kind the log already knows
-- (TG_ARGV[0], 'card:' or 'question:'), plus 'concepts': every partition is
-- validated against it, so that also reaches rotations with no change row yet.
CREATE OR REPLACE FUNCTION "concept_topk_table_truncated"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM "concept_topk_record_changes"(ARRAY(
        SELECT DISTINCT c.scope FROM "CandidatePoolChange" c WHERE starts_with(c.scope, TG_ARGV[0])
    ) || 'concepts'::text);
    RETURN NULL;
END;
$$;

-- Embedding tables: statement-level with transition tables, so a bulk upsert
-- of thousands of vectors appends one row per affected rotation, not per row.
-- The embedding tables carry no foreign key to their parent, so the rotation
-- comes from a join; an orphan vector contributes nothing (its parent's own
-- trigger covers the parent's deletion). An UPDATE reads both transition
-- tables: a vector re-pointed at another item leaves the old item's rotation
-- as well as joining the new one's.
CREATE OR REPLACE FUNCTION "concept_topk_card_embeddings_changed"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        PERFORM "concept_topk_record_changes"(ARRAY(
            SELECT DISTINCT 'card:' || c.rotation FROM old_rows o JOIN "Card" c ON c.id = o.card_id));
    ELSIF TG_OP = 'UPDATE' THEN
        PERFORM "concept_topk_record_changes"(ARRAY(
            SELECT DISTINCT 'card:' || c.rotation
            FROM (SELECT card_id FROM old_rows UNION SELECT card_id FROM new_rows) k
            JOIN "Card" c ON c.id = k.card_id));
    ELSE
        PERFORM "concept_topk_record_changes"(ARRAY(
            SELECT DISTINCT 'card:' || c.rotation FROM new_rows n JOIN "Card" c ON c.id = n.card_id));
    END IF;
    RETURN NULL;
END;
$$;

CREATE OR REPLACE TRIGGER "card_embeddings_topk_insert"
AFTER INSERT ON card_embeddings
REFERENCING NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION "concept_topk_card_embeddings_changed"();

CREATE OR REPLACE TRIGGER "card_embeddings_topk_update"
AFTER UPDATE ON card_embeddings
REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION "concept_topk_card_embeddings_changed"();

CREATE OR REPLACE TRIGGER "card_embeddings_topk_delete"
AFTER DELETE ON card_embeddings
REFERENCING OLD TABLE AS old_rows
FOR EACH STATEMENT EXECUTE FUNCTION "concept_topk_card_embeddings_changed"();

CREATE OR REPLACE TRIGGER "card_embeddings_topk_truncate"
AFTER TRUNCATE ON card_embeddings
FOR EACH STATEMENT EXECUTE FUNCTION "concept_topk_table_truncated"('card:');

CREATE OR REPLACE FUNCTION "concept_topk_question_embeddings_changed"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        PERFORM "concept_topk_record_changes"(ARRAY(
            SELECT DISTINCT 'question:' || q.rotation FROM old_rows o JOIN "Question" q ON q.id = o.question_id));
    ELSIF TG_OP = 'UPDATE' THEN
        PERFORM "concept_topk_record_changes"(ARRAY(
            SELECT DISTINCT 'question:' || q.rotation
            FROM (SELECT question_id FROM old_rows UNION SELECT question_id FROM new_rows) k
            JOIN "Question" q ON q.id = k.question_id));
    ELSE
        PERFORM "concept_topk_record_changes"(ARRAY(
            SELECT DISTINCT 'question:' || q.rotation FROM new_rows n JOIN "Question" q ON q.id = n.question_id));
    END IF;
    RETURN NULL;
END;
$$;

CREATE OR REPLACE TRIGGER "question_embeddings_topk_insert"
AFTER INSERT ON question_embeddings
REFERENCING NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION "concept_topk_question_embeddings_changed"();

CREATE OR REPLACE TRIGGER "question_embeddings_topk_update"
AFTER UPDATE ON question_embeddings
REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION "concept_topk_question_embeddings_changed"();

CREATE OR REPLACE TRIGGER "question_embeddings_topk_delete"
AFTER DELETE ON question_embeddings
REFERENCING OLD TABLE AS old_rows
FOR EACH STATEMENT EXECUTE FUNCTION "concept_topk_question_embeddings_changed"();

CREATE OR REPLACE TRIGGER "question_embeddings_topk_truncate"
AFTER TRUNCATE ON question_embeddings
FOR EACH STATEMENT EXECUTE FUNCTION "concept_topk_table_truncated"('question:');

-- A concept vector that changes or disappears invalidates every list built
-- from it. A new concept invalidates nothing: it simply has no list yet, and
-- the read path computes it live until the next refresh.
CREATE OR REPLACE FUNCTION "concept_topk_concept_embeddings_changed"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM "concept_topk_record_changes"(ARRAY['concepts']);
    RETURN NULL;
END;
$$;

CREATE OR REPLACE TRIGGER "concept_embeddings_topk_update"
AFTER UPDATE ON concept_embeddings
FOR EACH STATEMENT EXECUTE FUNCTION "concept_topk_concept_embeddings_changed"();

CREATE OR REPLACE TRIGGER "concept_embeddings_topk_delete"
AFTER DELETE ON concept_embeddings
FOR EACH STATEMENT EXECUTE FUNCTION "concept_topk_concept_embeddings_changed"();

CREATE OR REPLACE TRIGGER "concept_embeddings_topk_truncate"
AFTER TRUNCATE ON concept_embeddings
FOR EACH STATEMENT EXECUTE FUNCTION "concept_topk_table_truncated"();

-- (Re)installing these triggers invalidates everything built before: while any
-- was absent (dropping a table drops its triggers), changes went unrecorded.
-- Every partition is validated against 'concepts', so one row reaches them all.
INSERT INTO "CandidatePoolChange" ("scope") VALUES ('concepts');

-- Parent rows. INSERT is statement-level (a seed's createMany appends once per
-- rotation); an inserted row can make an orphan vector eligible. UPDATE is
-- row-level behind a WHEN on the columns that decide whether a row may be
-- served: those the top-K predicates read, plus those the cached candidate
-- pools filter on (src/lib/knowledge/bulk-candidates.ts; a test there checks
-- this list against the queries it sends). The hot-path rewrites
-- (facilityIndex, analytics) match none of them and never call the function.
-- "id" is watched because every cached row and every list is keyed by it.
-- Question."explanation" is the column behind the Prisma field `context`.
-- Card."ownerUserId" cannot change ("Card_private_identity_immutable" rejects
-- it); it is listed so the WHEN states the whole dependency.
CREATE OR REPLACE FUNCTION "concept_topk_card_rows_inserted"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM "concept_topk_record_changes"(ARRAY(SELECT DISTINCT 'card:' || n.rotation FROM new_rows n));
    RETURN NULL;
END;
$$;

CREATE OR REPLACE TRIGGER "Card_topk_insert"
AFTER INSERT ON "Card"
REFERENCING NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION "concept_topk_card_rows_inserted"();

CREATE OR REPLACE FUNCTION "concept_topk_card_row_changed"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        PERFORM "concept_topk_record_changes"(ARRAY['card:' || OLD.rotation]);
    ELSE
        PERFORM "concept_topk_record_changes"(ARRAY['card:' || OLD.rotation, 'card:' || NEW.rotation]);
    END IF;
    RETURN NULL;
END;
$$;

CREATE OR REPLACE TRIGGER "Card_topk_update"
AFTER UPDATE OF "id", "rotation", "moduleNodes", "ownerUserId", "deletedAt", "shelvedAt", "practiceLocale",
    "topics", "imageRole", "clipRole" ON "Card"
FOR EACH ROW
WHEN (
    OLD."id" IS DISTINCT FROM NEW."id"
    OR OLD."rotation" IS DISTINCT FROM NEW."rotation"
    OR OLD."moduleNodes" IS DISTINCT FROM NEW."moduleNodes"
    OR OLD."ownerUserId" IS DISTINCT FROM NEW."ownerUserId"
    OR OLD."deletedAt" IS DISTINCT FROM NEW."deletedAt"
    OR OLD."shelvedAt" IS DISTINCT FROM NEW."shelvedAt"
    OR OLD."practiceLocale" IS DISTINCT FROM NEW."practiceLocale"
    OR OLD."topics" IS DISTINCT FROM NEW."topics"
    OR OLD."imageRole" IS DISTINCT FROM NEW."imageRole"
    OR OLD."clipRole" IS DISTINCT FROM NEW."clipRole"
)
EXECUTE FUNCTION "concept_topk_card_row_changed"();

CREATE OR REPLACE TRIGGER "Card_topk_delete"
AFTER DELETE ON "Card"
FOR EACH ROW EXECUTE FUNCTION "concept_topk_card_row_changed"();

CREATE OR REPLACE TRIGGER "Card_topk_truncate"
AFTER TRUNCATE ON "Card"
FOR EACH STATEMENT EXECUTE FUNCTION "concept_topk_table_truncated"('card:');

CREATE OR REPLACE FUNCTION "concept_topk_question_rows_inserted"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM "concept_topk_record_changes"(ARRAY(SELECT DISTINCT 'question:' || n.rotation FROM new_rows n));
    RETURN NULL;
END;
$$;

CREATE OR REPLACE TRIGGER "Question_topk_insert"
AFTER INSERT ON "Question"
REFERENCING NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION "concept_topk_question_rows_inserted"();

CREATE OR REPLACE FUNCTION "concept_topk_question_row_changed"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        PERFORM "concept_topk_record_changes"(ARRAY['question:' || OLD.rotation]);
    ELSE
        PERFORM "concept_topk_record_changes"(ARRAY['question:' || OLD.rotation, 'question:' || NEW.rotation]);
    END IF;
    RETURN NULL;
END;
$$;

CREATE OR REPLACE TRIGGER "Question_topk_update"
AFTER UPDATE OF "id", "rotation", "moduleNodes", "contentState", "practiceLocale",
    "topics", "explanation", "sourceFile" ON "Question"
FOR EACH ROW
WHEN (
    OLD."id" IS DISTINCT FROM NEW."id"
    OR OLD."rotation" IS DISTINCT FROM NEW."rotation"
    OR OLD."moduleNodes" IS DISTINCT FROM NEW."moduleNodes"
    OR OLD."contentState" IS DISTINCT FROM NEW."contentState"
    OR OLD."practiceLocale" IS DISTINCT FROM NEW."practiceLocale"
    OR OLD."topics" IS DISTINCT FROM NEW."topics"
    OR OLD."explanation" IS DISTINCT FROM NEW."explanation"
    OR OLD."sourceFile" IS DISTINCT FROM NEW."sourceFile"
)
EXECUTE FUNCTION "concept_topk_question_row_changed"();

CREATE OR REPLACE TRIGGER "Question_topk_delete"
AFTER DELETE ON "Question"
FOR EACH ROW EXECUTE FUNCTION "concept_topk_question_row_changed"();

CREATE OR REPLACE TRIGGER "Question_topk_truncate"
AFTER TRUNCATE ON "Question"
FOR EACH STATEMENT EXECUTE FUNCTION "concept_topk_table_truncated"('question:');
