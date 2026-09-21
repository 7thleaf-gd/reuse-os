PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS inventory (
  sku TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'AVAILABLE'
    CHECK (status IN ('AVAILABLE','RESERVED','SOLD')),
  sync_state TEXT,
  category TEXT NOT NULL DEFAULT 'MUSIC',
  product_name TEXT NOT NULL,
  format TEXT,
  media_condition TEXT,
  sleeve_condition TEXT,
  cost_jpy INTEGER NOT NULL DEFAULT 0,
  price_jpy INTEGER,
  location TEXT,
  quantity INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS channel_listings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sku TEXT NOT NULL,
  channel TEXT NOT NULL,
  external_id TEXT NOT NULL,
  listing_status TEXT NOT NULL DEFAULT 'LISTED',
  listing_url TEXT,
  price_jpy INTEGER,
  quantity INTEGER NOT NULL DEFAULT 1,
  last_note TEXT,
  last_synced_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(channel, external_id),
  FOREIGN KEY (sku) REFERENCES inventory(sku) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS sale_events (
  event_id TEXT PRIMARY KEY,
  sku TEXT NOT NULL,
  channel TEXT NOT NULL,
  order_id TEXT,
  sale_price_jpy INTEGER,
  final_state TEXT,
  note TEXT,
  detected_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT,
  FOREIGN KEY (sku) REFERENCES inventory(sku)
);

CREATE TABLE IF NOT EXISTS inventory_media (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sku TEXT NOT NULL,
  r2_key TEXT NOT NULL UNIQUE,
  content_type TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (sku) REFERENCES inventory(sku) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_inventory_status ON inventory(status);
CREATE INDEX IF NOT EXISTS idx_channel_sku ON channel_listings(sku);
CREATE INDEX IF NOT EXISTS idx_channel_status ON channel_listings(channel, listing_status);
CREATE INDEX IF NOT EXISTS idx_sale_events_sku ON sale_events(sku);


-- Connector credentials are encrypted before storage.
-- The encryption key is derived server-side from ADMIN_TOKEN and is never stored in D1.
CREATE TABLE IF NOT EXISTS connector_secrets (
  provider TEXT PRIMARY KEY,
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);


CREATE TABLE IF NOT EXISTS hunter_intake (
  sku TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  source_id TEXT,
  source_url TEXT,
  query_text TEXT,
  barcode TEXT,
  lowest_market_jpy INTEGER,
  captured_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (sku) REFERENCES inventory(sku) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_hunter_source ON hunter_intake(provider, source_id);
