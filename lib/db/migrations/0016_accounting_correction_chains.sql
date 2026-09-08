ALTER TABLE "commission_journals" ADD COLUMN "logical_source_key" text;
ALTER TABLE "commission_journals" ADD COLUMN "source_version" integer DEFAULT 1 NOT NULL;
ALTER TABLE "commission_journals" ADD COLUMN "correction_date" date;
ALTER TABLE "commission_journals" ADD COLUMN "detected_at" timestamp with time zone;
-- 0012 deliberately makes journal headers immutable.  This is the sole
-- controlled historical rewrite in this migration.  Disabling the named
-- trigger (rather than ALL triggers) leaves FK/internal protections active;
-- PostgreSQL's transactional DDL also guarantees a failed backfill cannot
-- leave the protection disabled.
ALTER TABLE "commission_journals" DISABLE TRIGGER "commission_immutable_journals";
UPDATE "commission_journals" SET "logical_source_key" = "source_key" WHERE "logical_source_key" IS NULL;
ALTER TABLE "commission_journals" ENABLE TRIGGER "commission_immutable_journals";
ALTER TABLE "commission_journals" ALTER COLUMN "logical_source_key" SET NOT NULL;
ALTER TABLE "commission_journals" ADD CONSTRAINT "commission_journals_reversal_of_fk"
  FOREIGN KEY ("reversal_of") REFERENCES "commission_journals"("id") ON DELETE restrict;
CREATE UNIQUE INDEX "commission_journals_logical_version_kind_idx"
  ON "commission_journals" USING btree ("logical_source_key","source_version","source_type");

CREATE TABLE "commission_accounting_source_chains" (
  "logical_source_key" text PRIMARY KEY NOT NULL,
  "source_version" integer DEFAULT 1 NOT NULL,
  "effective_journal_id" uuid REFERENCES "commission_journals"("id") ON DELETE restrict,
  "current_fingerprint" text,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
INSERT INTO "commission_accounting_source_chains"
  ("logical_source_key","source_version","effective_journal_id","current_fingerprint")
SELECT "logical_source_key", max("source_version"),
       (array_agg("id" ORDER BY "source_version" DESC))[1],
       (array_agg("fingerprint" ORDER BY "source_version" DESC))[1]
FROM "commission_journals" GROUP BY "logical_source_key"
ON CONFLICT ("logical_source_key") DO NOTHING;

CREATE OR REPLACE FUNCTION commission_assert_journal_header_has_lines() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM commission_journal_lines WHERE journal_id = NEW.id) THEN
    RAISE EXCEPTION 'journal must contain at least one line';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER commission_journal_has_lines
AFTER INSERT ON "commission_journals" DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION commission_assert_journal_header_has_lines();