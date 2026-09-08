CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE "commission_accounting_periods"
  ADD CONSTRAINT "commission_accounting_period_status" CHECK (status IN ('open','closed')),
  ADD CONSTRAINT "commission_accounting_period_no_overlap" EXCLUDE USING gist (daterange("start","end",'[]') WITH &&);
ALTER TABLE "commission_reconciliations" ADD CONSTRAINT "commission_reconciliation_status" CHECK (status IN ('open','complete'));
ALTER TABLE "commission_reconciliation_matches" ADD CONSTRAINT "commission_reconciliation_match_nonzero" CHECK (amount <> 0);
CREATE OR REPLACE FUNCTION commission_assert_journal_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d numeric; c numeric;
BEGIN
 SELECT coalesce(sum(debit),0), coalesce(sum(credit),0) INTO d,c FROM commission_journal_lines WHERE journal_id = COALESCE(NEW.journal_id, OLD.journal_id);
 IF d <> c THEN RAISE EXCEPTION 'journal lines must balance to cents'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER commission_journal_balance
AFTER INSERT OR UPDATE OR DELETE ON "commission_journal_lines" DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION commission_assert_journal_balanced();
CREATE OR REPLACE FUNCTION commission_reject_closed_period_journal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS (SELECT 1 FROM commission_accounting_periods p WHERE p.status='closed' AND NEW.date BETWEEN p.start AND p.end) THEN
   RAISE EXCEPTION 'accounting period is closed for %', NEW.date;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER commission_reject_closed_period_journal BEFORE INSERT ON "commission_journals"
FOR EACH ROW EXECUTE FUNCTION commission_reject_closed_period_journal();