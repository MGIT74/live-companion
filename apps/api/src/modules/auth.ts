import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { db, schema } from '../db/client.ts';
import { authenticate } from '../lib/auth.ts';
import { env } from '../lib/env.ts';
import { AppError, isDuplicate } from '../lib/errors.ts';
import { newId } from '../lib/ids.ts';
import { createShopForUser } from './shops.ts';

const email = z.string().trim().toLowerCase().email();
const password = z.string().min(8, 'Mot de passe : 8 caractères minimum').max(200);

export async function authRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  /** Inscription d'un vendeur : crée son compte et sa première boutique (il en est OWNER). */
  r.post('/v1/auth/register', {
    schema: { body: z.object({ email, password, fullName: z.string().trim().min(2).max(120), shopName: z.string().trim().min(2).max(120), city: z.string().max(80).optional(), phone: z.string().max(20).optional() }) },
  }, async (req, reply) => {
    if (env.ALLOW_SIGNUP !== 'true') throw new AppError(403, 'SIGNUP_CLOSED', 'Inscriptions fermées');
    const b = req.body;
    const userId = newId();
    try {
      await db.transaction(async (tx) => {
        await tx.insert(schema.users).values({ id: userId, email: b.email, phone: b.phone, fullName: b.fullName, passwordHash: await bcrypt.hash(b.password, 10) });
        await createShopForUser(tx, userId, { name: b.shopName, city: b.city, phone: b.phone });
      });
    } catch (e) {
      if (isDuplicate(e)) throw new AppError(409, 'EMAIL_TAKEN', 'Un compte existe déjà avec cet e-mail');
      throw e;
    }
    reply.status(201);
    return { token: app.jwt.sign({ sub: userId }), user: await me(userId) };
  });

  r.post('/v1/auth/login', { schema: { body: z.object({ email, password: z.string().min(1) }) } }, async (req) => {
    const [u] = await db.select().from(schema.users).where(eq(schema.users.email, req.body.email)).limit(1);
    if (!u || !(await bcrypt.compare(req.body.password, u.passwordHash))) throw new AppError(401, 'BAD_CREDENTIALS', 'E-mail ou mot de passe incorrect');
    return { token: app.jwt.sign({ sub: u.id, adm: u.isPlatformAdmin || undefined }), user: await me(u.id) };
  });

  r.get('/v1/me', { preHandler: authenticate }, async (req) => me(req.user.sub));

  r.post('/v1/me/password', { preHandler: authenticate, schema: { body: z.object({ current: z.string(), next: password }) } }, async (req) => {
    const [u] = await db.select().from(schema.users).where(eq(schema.users.id, req.user.sub));
    if (!u || !(await bcrypt.compare(req.body.current, u.passwordHash))) throw new AppError(400, 'BAD_PASSWORD', 'Mot de passe actuel incorrect');
    await db.update(schema.users).set({ passwordHash: await bcrypt.hash(req.body.next, 10) }).where(eq(schema.users.id, u.id));
    return { ok: true };
  });
}

export async function me(userId: string) {
  const [u] = await db.select({ id: schema.users.id, email: schema.users.email, fullName: schema.users.fullName, phone: schema.users.phone, locale: schema.users.locale, isPlatformAdmin: schema.users.isPlatformAdmin })
    .from(schema.users).where(eq(schema.users.id, userId));
  if (!u) throw new AppError(401, 'UNAUTHENTICATED', 'Compte introuvable');
  const shops = await db.select({ id: schema.shops.id, name: schema.shops.name, slug: schema.shops.slug, city: schema.shops.city, status: schema.shops.status, role: schema.shopMembers.role })
    .from(schema.shopMembers).innerJoin(schema.shops, eq(schema.shops.id, schema.shopMembers.shopId))
    .where(eq(schema.shopMembers.userId, userId));
  return { ...u, shops };
}
