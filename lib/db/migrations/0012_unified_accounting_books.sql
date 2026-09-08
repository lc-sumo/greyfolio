CREATE TABLE "commission_accounts" (
 "code" text PRIMARY KEY NOT NULL, "name" text NOT NULL, "type" text NOT NULL, "purpose" text NOT NULL UNIQUE,
 "system" boolean DEFAULT true NOT NULL, "active" boolean DEFAULT true NOT NULL, "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE "commission_accounting_periods" (
 "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL, "start" date NOT NULL, "end" date NOT NULL, "status" text DEFAULT 'open' NOT NULL,
 "closed_at" timestamp with time zone, "closed_by" text REFERENCES "commission_reps"("id"), "reopened_at" timestamp with time zone,
 "reopened_by" text REFERENCES "commission_reps"("id"), "created_at" timestamp with time zone DEFAULT now() NOT NULL,
 CONSTRAINT "commission_accounting_period_dates" CHECK ("start" <= "end")
);
CREATE UNIQUE INDEX "commission_accounting_period_range_idx" ON "commission_accounting_periods" USING btree ("start","end");
CREATE TABLE "commission_journals" (
 "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL, "source_key" text NOT NULL, "source_type" text NOT NULL, "date" date NOT NULL,
 "memo" text NOT NULL, "fingerprint" text NOT NULL, "metadata" jsonb, "reversal_of" uuid, "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX "commission_journals_source_key_idx" ON "commission_journals" USING btree ("source_key");
CREATE INDEX "commission_journals_date_idx" ON "commission_journals" USING btree ("date");
CREATE TABLE "commission_journal_lines" (
 "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL, "journal_id" uuid NOT NULL REFERENCES "commission_journals"("id") ON DELETE restrict,
 "account_code" text NOT NULL REFERENCES "commission_accounts"("code") ON DELETE restrict, "debit" numeric(14,2) DEFAULT 0 NOT NULL,
 "credit" numeric(14,2) DEFAULT 0 NOT NULL, "memo" text, "created_at" timestamp with time zone DEFAULT now() NOT NULL,
 CONSTRAINT "commission_journal_lines_one_side" CHECK ((debit > 0 AND credit = 0) OR (credit > 0 AND debit = 0))
);
CREATE INDEX "commission_journal_lines_journal_idx" ON "commission_journal_lines" USING btree ("journal_id");
CREATE INDEX "commission_journal_lines_account_idx" ON "commission_journal_lines" USING btree ("account_code");
CREATE TABLE "commission_reconciliations" (
 "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL, "account_code" text NOT NULL REFERENCES "commission_accounts"("code"),
 "statement_date" date NOT NULL, "statement_balance" numeric(14,2) NOT NULL, "status" text DEFAULT 'open' NOT NULL, "note" text,
 "created_by" text REFERENCES "commission_reps"("id"), "created_at" timestamp with time zone DEFAULT now() NOT NULL,
 "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE "commission_reconciliation_matches" (
 "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL, "reconciliation_id" uuid NOT NULL REFERENCES "commission_reconciliations"("id") ON DELETE cascade,
 "journal_line_id" uuid NOT NULL REFERENCES "commission_journal_lines"("id") ON DELETE restrict, "amount" numeric(14,2) NOT NULL,
 "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX "commission_reconciliation_match_unique_idx" ON "commission_reconciliation_matches" USING btree ("reconciliation_id","journal_line_id");
INSERT INTO "commission_accounts" ("code","name","type","purpose") VALUES
 ('1000','Cash','asset','cash'),('1100','Lender commission A/R','asset','lender_ar'),('2000','Rep payable','liability','rep_payable'),
 ('2010','Referral payable','liability','referral_payable'),('3000','Opening equity','equity','opening_equity'),
 ('4000','Commission revenue','revenue','commission_revenue'),('4090','Clawback contra-revenue/loss','revenue','clawback_loss'),
 ('5000','Rep commission expense','expense','rep_expense'),('5010','Referral expense','expense','referral_expense')
ON CONFLICT ("code") DO NOTHING;
CREATE OR REPLACE FUNCTION commission_protect_system_accounts() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF OLD.system THEN RAISE EXCEPTION 'system purpose accounts cannot be deleted'; END IF; RETURN OLD; END $$;
CREATE TRIGGER commission_protect_system_accounts BEFORE DELETE ON "commission_accounts" FOR EACH ROW EXECUTE FUNCTION commission_protect_system_accounts();
CREATE OR REPLACE FUNCTION commission_immutable_journal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'source-linked accounting journals are immutable; post a reversal in an open period'; END $$;
CREATE TRIGGER commission_immutable_journals BEFORE UPDATE OR DELETE ON "commission_journals" FOR EACH ROW EXECUTE FUNCTION commission_immutable_journal();
CREATE TRIGGER commission_immutable_journal_lines BEFORE UPDATE OR DELETE ON "commission_journal_lines" FOR EACH ROW EXECUTE FUNCTION commission_immutable_journal();