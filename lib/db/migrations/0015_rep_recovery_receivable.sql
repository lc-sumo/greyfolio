INSERT INTO "commission_accounts" ("code","name","type","purpose") VALUES
 ('1200','Rep recovery receivable','asset','rep_recovery_receivable')
ON CONFLICT ("code") DO NOTHING;
CREATE UNIQUE INDEX "commission_reconciliation_matches_line_unique_idx"
ON "commission_reconciliation_matches" USING btree ("journal_line_id");