import pg from 'pg';
import { config } from './config.js';

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });

export const query = (text, params) => pool.query(text, params);

const MIGRATIONS = [
  // 1 — initial schema
  `
  CREATE TABLE settings (
    key        text PRIMARY KEY,
    value      jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE gateways (
    id                    serial PRIMARY KEY,
    eui                   char(16) NOT NULL UNIQUE,      -- 16 upper-case hex digits
    name                  text NOT NULL DEFAULT '',
    description           text NOT NULL DEFAULT '',
    cups_uri              text,                          -- per-gateway override (redirect)
    tc_uri                text,                          -- per-gateway LNS override
    cups_cert_pem         text,
    cups_key_pem          text,
    cups_cert_fingerprint text,                          -- sha256, colon separated
    cups_cert_not_after   timestamptz,
    cups_cert_generated   boolean NOT NULL DEFAULT false,
    tc_trust_pem          text,
    tc_cert_pem           text,
    tc_key_pem            text,
    tc_token              text,
    tc_cert_not_after     timestamptz,
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now(),
    last_seen_at          timestamptz,
    last_remote_addr      text,
    last_package          text,
    last_model            text,
    last_station          text,
    last_valid            boolean,
    last_reason           text
  );

  CREATE TABLE cups_requests (
    id          bigserial PRIMARY KEY,
    ts          timestamptz NOT NULL DEFAULT now(),
    gateway_eui char(16),
    router_raw  text,
    remote_addr text,
    valid       boolean NOT NULL,
    status_code int NOT NULL,
    reason      text,
    updates     text[] NOT NULL DEFAULT '{}',
    request     jsonb
  );
  CREATE INDEX cups_requests_ts_idx  ON cups_requests (ts);
  CREATE INDEX cups_requests_gw_idx  ON cups_requests (gateway_eui, ts DESC);
  `,
  // 2 — certificate rotation: keep accepting the previous CUPS client cert until
  //     the gateway reports the CRC of the new credential set.
  `
  ALTER TABLE gateways ADD COLUMN cups_prev_cert_fingerprint text;
  `,
  // 3 — bootstrap credentials (Station cups-boot.*): immutable on the device,
  //     always accepted so a gateway can recover when regular and backup creds fail.
  `
  ALTER TABLE gateways
    ADD COLUMN cups_boot_cert_pem text,
    ADD COLUMN cups_boot_key_pem text,
    ADD COLUMN cups_boot_cert_fingerprint text,
    ADD COLUMN cups_boot_cert_not_after timestamptz;
  ALTER TABLE cups_requests ADD COLUMN cred_set text;  -- regular | previous | bootstrap
  `,
];

export async function migrate() {
  const client = await pool.connect();
  try {
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (version int PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const { rows } = await client.query('SELECT coalesce(max(version), 0) AS v FROM schema_migrations');
    for (let v = rows[0].v + 1; v <= MIGRATIONS.length; v++) {
      await client.query('BEGIN');
      try {
        await client.query(MIGRATIONS[v - 1]);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [v]);
        await client.query('COMMIT');
        console.log(`[db] applied migration ${v}`);
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      }
    }
  } finally {
    client.release();
  }
}

// ---- settings -------------------------------------------------------------

export async function getSetting(key, fallback = null) {
  const { rows } = await query('SELECT value FROM settings WHERE key = $1', [key]);
  return rows.length ? rows[0].value : fallback;
}

export async function setSetting(key, value) {
  await query(
    `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, JSON.stringify(value)],
  );
}
