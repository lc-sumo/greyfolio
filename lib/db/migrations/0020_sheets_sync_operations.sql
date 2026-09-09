CREATE TABLE IF NOT EXISTS commission_sheets_sync_operations (
  operation text NOT NULL,
  key text NOT NULL,
  payload_hash text NOT NULL,
  state text NOT NULL DEFAULT 'processing',
  status integer,
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT commission_sheets_sync_operations_key PRIMARY KEY (operation, key)
);