CREATE TABLE whatsapp_baixa.webhook_inbox (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_key text NOT NULL UNIQUE,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'done', 'dead')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  processed_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX webhook_inbox_pending_idx
  ON whatsapp_baixa.webhook_inbox (available_at, id)
  WHERE status = 'pending';

CREATE INDEX webhook_inbox_processing_idx
  ON whatsapp_baixa.webhook_inbox (locked_at, id)
  WHERE status = 'processing';

CREATE TABLE whatsapp_baixa.state_kv (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX state_kv_expires_idx
  ON whatsapp_baixa.state_kv (expires_at);
