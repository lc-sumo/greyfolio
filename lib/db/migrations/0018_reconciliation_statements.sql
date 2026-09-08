ALTER TABLE "commission_reconciliations"
  ADD COLUMN "statement_start" date,
  ADD COLUMN "opening_balance" numeric(14,2);

UPDATE "commission_reconciliations"
SET "statement_start" = "statement_date",
    "opening_balance" = 0
WHERE "statement_start" IS NULL OR "opening_balance" IS NULL;

ALTER TABLE "commission_reconciliations"
  ALTER COLUMN "statement_start" SET NOT NULL,
  ALTER COLUMN "opening_balance" SET NOT NULL,
  DROP CONSTRAINT "commission_reconciliation_status";

UPDATE "commission_reconciliations" SET status = 'completed' WHERE status = 'complete';

ALTER TABLE "commission_reconciliations"
  ADD CONSTRAINT "commission_reconciliation_status" CHECK (status IN ('open','completed')),
  ADD CONSTRAINT "commission_reconciliation_interval" CHECK (statement_start <= statement_date);