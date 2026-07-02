-- Fresh Cuts Invite — schema for shared-postgres
-- Database: freshcuts, owner: freshcuts_user

CREATE TABLE IF NOT EXISTS settings (
  id INT PRIMARY KEY DEFAULT 1,
  data JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT settings_single CHECK (id = 1)
);

CREATE TABLE IF NOT EXISTS ambassadors (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT,
  phone_norm TEXT,
  password TEXT NOT NULL,
  custom_message TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS ambassadors_phone_norm_unique
  ON ambassadors(phone_norm)
  WHERE phone_norm IS NOT NULL AND phone_norm <> '';

CREATE TABLE IF NOT EXISTS batches (
  id TEXT PRIMARY KEY,
  campaign_name TEXT NOT NULL,
  ambassador_id TEXT REFERENCES ambassadors(id) ON DELETE CASCADE,
  discount_percent INT NOT NULL,
  validity_date DATE NOT NULL,
  code_prefix TEXT,
  offer_description TEXT,
  banner_template_id TEXT,
  custom_text JSONB DEFAULT '{}',
  custom_colors JSONB DEFAULT '{}',
  source TEXT,
  status TEXT,
  promotion_id INT,               -- chosen TabSense offer this batch's codes link to
  tab_sense_uploaded BOOL DEFAULT false,
  exported_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS batches_ambassador_idx ON batches(ambassador_id);

CREATE TABLE IF NOT EXISTS codes (
  code TEXT PRIMARY KEY,
  batch_id TEXT REFERENCES batches(id) ON DELETE CASCADE,
  ambassador_id TEXT REFERENCES ambassadors(id) ON DELETE CASCADE,
  friend_name TEXT NOT NULL DEFAULT '',
  friend_phone TEXT NOT NULL DEFAULT '',
  redeemed BOOL NOT NULL DEFAULT false,
  redeemed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS codes_batch_idx ON codes(batch_id);
CREATE INDEX IF NOT EXISTS codes_ambassador_idx ON codes(ambassador_id);

CREATE TABLE IF NOT EXISTS designs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  image_url TEXT NOT NULL,
  width INT,
  height INT,
  fields JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Bootstrap settings row
INSERT INTO settings (id, data) VALUES (1, '{}') ON CONFLICT (id) DO NOTHING;
