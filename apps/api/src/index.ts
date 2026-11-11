import { buildApp } from './app.ts';
import { runMigrations } from './db/migrate.ts';
import { env } from './lib/env.ts';
import { expirePendingOrders } from './services/orders.ts';

await runMigrations();
const app = await buildApp();
await app.listen({ port: env.PORT, host: '0.0.0.0' });

// Annule les réservations expirées toutes les 5 minutes (stock rendu disponible).
setInterval(() => {
  expirePendingOrders().then((n) => n && app.log.info(`${n} réservation(s) expirée(s) annulée(s)`)).catch((e) => app.log.error(e));
}, 5 * 60_000).unref();
