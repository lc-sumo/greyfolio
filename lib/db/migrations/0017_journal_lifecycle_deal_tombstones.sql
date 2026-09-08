ALTER TABLE "commission_journals"
  ADD COLUMN "posting_status" text DEFAULT 'sealed' NOT NULL,
  ADD COLUMN "sealed_at" timestamp with time zone DEFAULT now();
ALTER TABLE "commission_journals" ALTER COLUMN "sealed_at" DROP DEFAULT;
ALTER TABLE "commission_journals"
  ADD CONSTRAINT "commission_journals_posting_status"
  CHECK ("posting_status" IN ('posting', 'sealed'));

DROP TRIGGER "commission_immutable_journals" ON "commission_journals";
DROP TRIGGER "commission_immutable_journal_lines" ON "commission_journal_lines";

CREATE OR REPLACE FUNCTION commission_protect_journal_header() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.posting_status = 'sealed' THEN
    RAISE EXCEPTION 'sealed accounting journals are immutable; post a reversal in an open period';
  END IF;
  IF NEW.posting_status = 'sealed' THEN
    IF (NEW.id, NEW.source_key, NEW.source_type, NEW.date, NEW.memo, NEW.fingerprint,
            NEW.metadata, NEW.reversal_of, NEW.created_at, NEW.logical_source_key,
            NEW.source_version, NEW.correction_date, NEW.detected_at)
           IS DISTINCT FROM
           (OLD.id, OLD.source_key, OLD.source_type, OLD.date, OLD.memo, OLD.fingerprint,
            OLD.metadata, OLD.reversal_of, OLD.created_at, OLD.logical_source_key,
            OLD.source_version, OLD.correction_date, OLD.detected_at) THEN
      RAISE EXCEPTION 'sealing may not mutate journal content';
    END IF;
    NEW.sealed_at := COALESCE(NEW.sealed_at, now());
    RETURN NEW;
  END IF;
  IF NEW.sealed_at IS NOT NULL THEN
    RAISE EXCEPTION 'a posting journal cannot have sealed_at';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER commission_protect_journal_header
BEFORE UPDATE OR DELETE ON "commission_journals"
FOR EACH ROW EXECUTE FUNCTION commission_protect_journal_header();

CREATE OR REPLACE FUNCTION commission_protect_journal_lines() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE jid uuid; state text; journal_date date;
BEGIN
  jid := CASE WHEN TG_OP = 'DELETE' THEN OLD.journal_id ELSE NEW.journal_id END;
  SELECT posting_status, date INTO state, journal_date
  FROM commission_journals WHERE id = jid FOR UPDATE;
  IF state IS NULL THEN RAISE EXCEPTION 'journal does not exist'; END IF;
  IF state <> 'posting' THEN
    RAISE EXCEPTION 'sealed accounting journal lines are immutable; post a reversal in an open period';
  END IF;
  IF EXISTS (
    SELECT 1 FROM commission_accounting_periods p
    WHERE p.status = 'closed' AND journal_date BETWEEN p.start AND p.end
  ) THEN
    RAISE EXCEPTION 'accounting period is closed for %', journal_date;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.journal_id <> OLD.journal_id THEN
    RAISE EXCEPTION 'journal lines cannot be moved between journals';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER commission_protect_journal_lines
BEFORE INSERT OR UPDATE OR DELETE ON "commission_journal_lines"
FOR EACH ROW EXECUTE FUNCTION commission_protect_journal_lines();

CREATE OR REPLACE FUNCTION commission_require_sealed_journal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE state text;
BEGIN
  SELECT posting_status INTO state FROM commission_journals WHERE id = NEW.id;
  IF state <> 'sealed' THEN
    RAISE EXCEPTION 'journal must be sealed before transaction commit';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER commission_journal_must_be_sealed
AFTER INSERT ON "commission_journals" DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION commission_require_sealed_journal();

CREATE OR REPLACE FUNCTION commission_seal_journal(target_id uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE d numeric; c numeric; state text;
BEGIN
  SELECT posting_status INTO state FROM commission_journals WHERE id = target_id FOR UPDATE;
  IF state IS NULL THEN RAISE EXCEPTION 'journal does not exist'; END IF;
  IF state <> 'posting' THEN RAISE EXCEPTION 'journal is already sealed'; END IF;
  SELECT COALESCE(sum(debit), 0), COALESCE(sum(credit), 0)
    INTO d, c FROM commission_journal_lines WHERE journal_id = target_id;
  IF d = 0 OR d <> c THEN RAISE EXCEPTION 'journal lines must be nonempty and balance to cents'; END IF;
  UPDATE commission_journals SET posting_status = 'sealed', sealed_at = now() WHERE id = target_id;
END $$;

ALTER TABLE "commission_deals"
  ADD COLUMN "deleted_at" timestamp with time zone,
  ADD COLUMN "deleted_by" text REFERENCES "commission_reps"("id") ON DELETE restrict;
CREATE INDEX "commission_deals_active_idx" ON "commission_deals" ("date", "id")
WHERE "deleted_at" IS NULL;
CREATE VIEW "commission_operational_deals" AS
SELECT * FROM "commission_deals" WHERE "deleted_at" IS NULL;