/**
 * The change-log triggers that keep the precomputed concept top-K and the
 * cached candidate pools fresh (docs/designs/2026-10-02-neon-scale.md).
 *
 * The migration 20261002130000_concept_topk_pool installs them. Dropping a
 * table drops its triggers, and scripts/manifold/setup-manifold.ts --reset
 * drops and recreates the embedding tables, so it reinstalls the
 * embedding-table triggers from EMBEDDING_TABLE_TRIGGER_STATEMENTS: the same
 * statements as the migration, verbatim (concept-topk-integration.test.ts
 * fails if the two differ by a character).
 *
 * Without these triggers no epoch moves, so nothing precomputed or cached can
 * be trusted. The read path and the refresh therefore check pg_trigger for
 * every trigger in CONCEPT_TOPK_TRIGGERS and refuse to serve or build while
 * one is missing or disabled.
 */

export interface ConceptTopKTrigger {
  table: string;
  name: string;
}

export const CONCEPT_TOPK_TRIGGERS: readonly ConceptTopKTrigger[] = Object.freeze([
  ...['insert', 'update', 'delete', 'truncate'].map((event) => ({ table: 'card_embeddings', name: `card_embeddings_topk_${event}` })),
  ...['insert', 'update', 'delete', 'truncate'].map((event) => ({ table: 'question_embeddings', name: `question_embeddings_topk_${event}` })),
  ...['update', 'delete', 'truncate'].map((event) => ({ table: 'concept_embeddings', name: `concept_embeddings_topk_${event}` })),
  ...['insert', 'update', 'delete', 'truncate'].map((event) => ({ table: 'Card', name: `Card_topk_${event}` })),
  ...['insert', 'update', 'delete', 'truncate'].map((event) => ({ table: 'Question', name: `Question_topk_${event}` })),
]);

/** Strip the indentation a template literal picks up from the source code. */
function statement(text: string): string {
  const lines = text.replace(/^\n/, '').replace(/\n\s*$/, '').split('\n');
  const indent = Math.min(...lines.filter((line) => line.trim()).map((line) => /^ */.exec(line)![0].length));
  return lines.map((line) => line.slice(indent)).join('\n');
}

/**
 * Functions and triggers for the three embedding tables, in order, each
 * without its terminating semicolon. The last statement invalidates every
 * partition: while any of these triggers was absent, changes went unrecorded,
 * and every partition is validated against the 'concepts' epoch.
 */
export const EMBEDDING_TABLE_TRIGGER_STATEMENTS: readonly string[] = Object.freeze([
  statement(`
    CREATE OR REPLACE FUNCTION "concept_topk_record_changes"(scopes TEXT[])
    RETURNS void
    LANGUAGE sql
    AS $$
        INSERT INTO "CandidatePoolChange" ("scope")
        SELECT DISTINCT s FROM unnest(scopes) AS s WHERE s IS NOT NULL;
    $$
  `),
  statement(`
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
    $$
  `),
  statement(`
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
    $$
  `),
  statement(`
    CREATE OR REPLACE TRIGGER "card_embeddings_topk_insert"
    AFTER INSERT ON card_embeddings
    REFERENCING NEW TABLE AS new_rows
    FOR EACH STATEMENT EXECUTE FUNCTION "concept_topk_card_embeddings_changed"()
  `),
  statement(`
    CREATE OR REPLACE TRIGGER "card_embeddings_topk_update"
    AFTER UPDATE ON card_embeddings
    REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
    FOR EACH STATEMENT EXECUTE FUNCTION "concept_topk_card_embeddings_changed"()
  `),
  statement(`
    CREATE OR REPLACE TRIGGER "card_embeddings_topk_delete"
    AFTER DELETE ON card_embeddings
    REFERENCING OLD TABLE AS old_rows
    FOR EACH STATEMENT EXECUTE FUNCTION "concept_topk_card_embeddings_changed"()
  `),
  statement(`
    CREATE OR REPLACE TRIGGER "card_embeddings_topk_truncate"
    AFTER TRUNCATE ON card_embeddings
    FOR EACH STATEMENT EXECUTE FUNCTION "concept_topk_table_truncated"('card:')
  `),
  statement(`
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
    $$
  `),
  statement(`
    CREATE OR REPLACE TRIGGER "question_embeddings_topk_insert"
    AFTER INSERT ON question_embeddings
    REFERENCING NEW TABLE AS new_rows
    FOR EACH STATEMENT EXECUTE FUNCTION "concept_topk_question_embeddings_changed"()
  `),
  statement(`
    CREATE OR REPLACE TRIGGER "question_embeddings_topk_update"
    AFTER UPDATE ON question_embeddings
    REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
    FOR EACH STATEMENT EXECUTE FUNCTION "concept_topk_question_embeddings_changed"()
  `),
  statement(`
    CREATE OR REPLACE TRIGGER "question_embeddings_topk_delete"
    AFTER DELETE ON question_embeddings
    REFERENCING OLD TABLE AS old_rows
    FOR EACH STATEMENT EXECUTE FUNCTION "concept_topk_question_embeddings_changed"()
  `),
  statement(`
    CREATE OR REPLACE TRIGGER "question_embeddings_topk_truncate"
    AFTER TRUNCATE ON question_embeddings
    FOR EACH STATEMENT EXECUTE FUNCTION "concept_topk_table_truncated"('question:')
  `),
  statement(`
    CREATE OR REPLACE FUNCTION "concept_topk_concept_embeddings_changed"()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
        PERFORM "concept_topk_record_changes"(ARRAY['concepts']);
        RETURN NULL;
    END;
    $$
  `),
  statement(`
    CREATE OR REPLACE TRIGGER "concept_embeddings_topk_update"
    AFTER UPDATE ON concept_embeddings
    FOR EACH STATEMENT EXECUTE FUNCTION "concept_topk_concept_embeddings_changed"()
  `),
  statement(`
    CREATE OR REPLACE TRIGGER "concept_embeddings_topk_delete"
    AFTER DELETE ON concept_embeddings
    FOR EACH STATEMENT EXECUTE FUNCTION "concept_topk_concept_embeddings_changed"()
  `),
  statement(`
    CREATE OR REPLACE TRIGGER "concept_embeddings_topk_truncate"
    AFTER TRUNCATE ON concept_embeddings
    FOR EACH STATEMENT EXECUTE FUNCTION "concept_topk_table_truncated"()
  `),
  statement(`
    INSERT INTO "CandidatePoolChange" ("scope") VALUES ('concepts')
  `),
]);

/** Anything that can run one raw statement. */
export interface RawStatementExecutor {
  $executeRawUnsafe(sql: string): PromiseLike<unknown>;
}

/**
 * Reinstall the embedding-table triggers and invalidate every partition built
 * before. Idempotent; run it whenever an embedding table has been recreated.
 */
export async function installEmbeddingTableTriggers(client: RawStatementExecutor): Promise<void> {
  for (const sql of EMBEDDING_TABLE_TRIGGER_STATEMENTS) await client.$executeRawUnsafe(sql);
}

/** Anything that can run one tagged raw query. */
export interface RawQueryClient {
  $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): PromiseLike<T>;
}

/**
 * The expected triggers that are absent or cannot fire (disabled, or enabled
 * only for replication), in the schema the application's queries resolve to.
 * Empty when every one is in place: one small catalog query.
 */
export async function missingConceptTopKTriggers(client: RawQueryClient): Promise<ConceptTopKTrigger[]> {
  const names = CONCEPT_TOPK_TRIGGERS.map((trigger) => trigger.name);
  // relname and tgname are Postgres `name` columns, which Prisma's raw-query
  // deserializer rejects ("Failed to deserialize column of type 'name'"), so
  // they are cast to text. Uncast, every store read failed and the precompute
  // never served (caught by the Neon-branch rehearsal, not by the PGlite test,
  // which does not go through Prisma).
  const rows = await client.$queryRaw<Array<{ table: string; name: string }>>`
    SELECT c.relname::text AS "table", t.tgname::text AS "name"
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema()
      AND NOT t.tgisinternal
      AND t.tgenabled IN ('O', 'A')
      AND t.tgname = ANY(${names}::text[])
  `;
  const present = new Set(rows.map((row) => `${row.table}.${row.name}`));
  return CONCEPT_TOPK_TRIGGERS.filter((trigger) => !present.has(`${trigger.table}.${trigger.name}`));
}

export function describeTriggers(triggers: readonly ConceptTopKTrigger[]): string[] {
  return triggers.map((trigger) => `${trigger.table}.${trigger.name}`);
}
