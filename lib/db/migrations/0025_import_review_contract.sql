-- Historical review payloads are intentionally JSON: adding fields to a
-- decision never requires rewriting staged source rows.  This migration only
-- adds the index used by the locked review/commit lookup and is safe on a
-- partially upgraded production database.
CREATE INDEX IF NOT EXISTS commission_import_reviews_active_source_idx
  ON commission_import_reviews (source_id)
  WHERE active;