CREATE TABLE whatsapp_baixa.proof_images (
  message_id text PRIMARY KEY,
  file_name text NOT NULL UNIQUE,
  mime_type text NOT NULL,
  size_bytes integer NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 20971520),
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

CREATE INDEX proof_images_expires_idx
  ON whatsapp_baixa.proof_images (expires_at);
