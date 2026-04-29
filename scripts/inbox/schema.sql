-- Team OS — shared inbox
-- Jedna tabela, 2 indeksy. Offline-friendly, polling co 1 min.
-- Uruchomienie: psql "$INBOX_DB_URL" -f scripts/inbox/schema.sql

CREATE TABLE IF NOT EXISTS inbox (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id  uuid,
  from_user  text NOT NULL,
  to_user    text NOT NULL,
  type       text NOT NULL CHECK (type IN ('task', 'query', 'reply', 'close')),
  title      text NOT NULL,
  content    text,
  payload    jsonb,
  status     text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'read', 'done')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_inbox_to_status ON inbox(to_user, status);
CREATE INDEX IF NOT EXISTS idx_inbox_thread    ON inbox(thread_id);

-- Auto-update updated_at przy UPDATE
CREATE OR REPLACE FUNCTION inbox_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_inbox_touch ON inbox;
CREATE TRIGGER trg_inbox_touch
BEFORE UPDATE ON inbox
FOR EACH ROW EXECUTE FUNCTION inbox_touch_updated_at();

-- Migracja Fazy 2 — rozszerzenie CHECK constraint o 'query' (idempotentne)
ALTER TABLE inbox DROP CONSTRAINT IF EXISTS inbox_type_check;
ALTER TABLE inbox ADD CONSTRAINT inbox_type_check
  CHECK (type IN ('task', 'query', 'reply', 'close'));
