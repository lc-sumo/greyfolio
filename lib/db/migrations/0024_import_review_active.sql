ALTER TABLE commission_import_reviews
  ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true;