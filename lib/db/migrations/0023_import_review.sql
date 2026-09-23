CREATE TABLE IF NOT EXISTS commission_import_reviews (
  source_id text PRIMARY KEY,
  source_hash text NOT NULL,
  source jsonb NOT NULL,
  status text NOT NULL DEFAULT 'not_reviewed',
  review jsonb NOT NULL DEFAULT '{}'::jsonb,
  revision integer NOT NULL DEFAULT 1,
  updated_by text REFERENCES commission_reps(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);