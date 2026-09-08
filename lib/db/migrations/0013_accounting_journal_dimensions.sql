ALTER TABLE "commission_journal_lines" ADD COLUMN "deal_id" text REFERENCES "commission_deals"("id") ON DELETE restrict;
ALTER TABLE "commission_journal_lines" ADD COLUMN "rep_id" text REFERENCES "commission_reps"("id") ON DELETE restrict;
CREATE INDEX "commission_journal_lines_deal_idx" ON "commission_journal_lines" USING btree ("deal_id");
CREATE INDEX "commission_journal_lines_rep_idx" ON "commission_journal_lines" USING btree ("rep_id");