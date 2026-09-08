-- Forgiveness is a lifecycle tombstone: keep recovery foreign keys and let
-- operational/accounting context omit the source for deterministic reversals.
ALTER TABLE "commission_clawbacks"
  ADD COLUMN "forgiven_at" timestamp with time zone;

CREATE INDEX "commission_clawbacks_active_deal_idx"
  ON "commission_clawbacks" ("deal_id")
  WHERE "forgiven_at" IS NULL;