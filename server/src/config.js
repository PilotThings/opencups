import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(here, '..', '..');

// Load <root>/.env if present (Node >= 21.7). Real env vars win.
const envFile = path.join(ROOT_DIR, '.env');
if (fs.existsSync(envFile)) {
  for (const [k, v] of Object.entries(parseEnv(fs.readFileSync(envFile, 'utf8')))) {
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

function parseEnv(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

const int = (v, d) => (v === undefined || v === '' ? d : Number.parseInt(v, 10));

export const config = {
  databaseUrl:
    process.env.DATABASE_URL || 'postgres://opencups:opencups@localhost:5434/opencups',
  httpPort: int(process.env.HTTP_PORT, 8080),
  cupsPort: int(process.env.CUPS_PORT, 6040),
  adminToken: process.env.ADMIN_TOKEN || '',
  retentionDays: int(process.env.REQUEST_RETENTION_DAYS, 90),
  webDist: path.join(ROOT_DIR, 'web', 'dist'),
};
