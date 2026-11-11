import cors from '@fastify/cors';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { registerAuth } from './lib/auth.ts';
import { env } from './lib/env.ts';
import { registerErrorHandler } from './lib/errors.ts';
import { authRoutes } from './modules/auth.ts';
import { catalogRoutes } from './modules/catalog.ts';
import { customerRoutes } from './modules/customers.ts';
import { liveRoutes } from './modules/lives.ts';
import { orderRoutes } from './modules/orders.ts';
import { shopRoutes } from './modules/shops.ts';
import { statsRoutes } from './modules/stats.ts';

export async function buildApp(opts: { logger?: boolean } = {}) {
  const app = Fastify({ logger: opts.logger ?? env.NODE_ENV !== 'test', trustProxy: true, bodyLimit: 2 * 1024 * 1024 });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerErrorHandler(app);
  await app.register(cors, { origin: env.CORS_ORIGIN === '*' ? true : env.CORS_ORIGIN.split(',') });
  await registerAuth(app);

  app.get('/health', async () => ({ ok: true }));
  await app.register(authRoutes);
  await app.register(shopRoutes);
  await app.register(catalogRoutes);
  await app.register(customerRoutes);
  await app.register(orderRoutes);
  await app.register(liveRoutes);
  await app.register(statsRoutes);
  return app;
}
