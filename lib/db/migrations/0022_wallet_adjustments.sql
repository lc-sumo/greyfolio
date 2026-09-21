CREATE TABLE IF NOT EXISTS commission_wallet_adjustments (
  id text PRIMARY KEY,
  idempotency_key text NOT NULL UNIQUE,
  deal_id text NOT NULL REFERENCES commission_deals(id),
  rep_id text NOT NULL REFERENCES commission_reps(id),
  amount numeric(12,2) NOT NULL,
  reason text NOT NULL,
  effective_date date NOT NULL,
  actor_rep_id text NOT NULL REFERENCES commission_reps(id),
  reversal_of text REFERENCES commission_wallet_adjustments(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'commission_wallet_adjustments'::regclass
      AND conname = 'commission_wallet_adjustments_reversal_of_fkey'
  ) THEN
    ALTER TABLE commission_wallet_adjustments
      ADD CONSTRAINT commission_wallet_adjustments_reversal_of_fkey
      FOREIGN KEY (reversal_of) REFERENCES commission_wallet_adjustments(id) ON DELETE RESTRICT;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS commission_wallet_adjustments_deal_idx ON commission_wallet_adjustments(deal_id);
CREATE INDEX IF NOT EXISTS commission_wallet_adjustments_rep_idx ON commission_wallet_adjustments(rep_id);
CREATE UNIQUE INDEX IF NOT EXISTS commission_wallet_adjustments_reversal_idx ON commission_wallet_adjustments(reversal_of) WHERE reversal_of IS NOT NULL;
INSERT INTO commission_accounts ("code","name","type","purpose")
VALUES ('5020','Wallet adjustment expense/clearing','expense','wallet_adjustment')
ON CONFLICT ("code") DO NOTHING;