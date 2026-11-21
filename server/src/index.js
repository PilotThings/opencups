import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { config } from './config.js';
import { migrate, pool, query } from './db.js';
import { api } from './api/router.js';
import { startCupsServer, stopCupsServer } from './cups/server.js';

async function main() {
  await migrate();

  const app = express();
  app.disable('x-powered-by');
  app.use('/api', api);

  // Serve the built UI (web/dist) when present; in development use `npm run dev` in web/.
  if (fs.existsSync(config.webDist)) {
    app.use(express.static(config.webDist));
    app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(config.webDist, 'index.html')));
  }

  const http = app.listen(config.httpPort, () =>
    console.log(`[http] admin UI + REST API on http://localhost:${config.httpPort}`));

  await startCupsServer(config.cupsPort);

  // Request history retention.
  const prune = () => query(`DELETE FROM cups_requests WHERE ts < now() - make_interval(days => $1)`, [config.retentionDays])
    .catch((e) => console.error('[db] prune failed', e.message));
  prune();
  const pruneTimer = setInterval(prune, 6 * 3600_000).unref();

  const shutdown = async () => {
    clearInterval(pruneTimer);
    http.close();
    await stopCupsServer();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
