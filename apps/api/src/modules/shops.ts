import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Tx } from '../db/client.ts';
import { db, schema } from '../db/client.ts';
import { SHOP_ROLES } from '../db/schema.ts';
import { audit } from '../lib/audit.ts';
import { authenticate } from '../lib/auth.ts';
import { conflict, notFound } from '../lib/errors.ts';
import { newId } from '../lib/ids.ts';
import { can, shopGuard } from '../lib/tenant.ts';

export function slugify(name: string) {
  return name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'boutique';
}

export async function createShopForUser(tx: Tx, userId: string, s: { name: string; city?: string; phone?: string }) {
  const id = newId();
  const slug = `${slugify(s.name)}-${id.slice(-5).toLowerCase()}`;
  await tx.insert(schema.shops).values({ id, slug, name: s.name, city: s.city, phone: s.phone });
  await tx.insert(schema.shopMembers).values({ id: newId(), shopId: id, userId, role: 'OWNER' });
  return id;
}

export async function shopRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.post('/v1/shops', { preHandler: authenticate, schema: { body: z.object({ name: z.string().trim().min(2).max(120), city: z.string().max(80).optional(), phone: z.string().max(20).optional() }) } }, async (req, reply) => {
    const id = await db.transaction((tx) => createShopForUser(tx, req.user.sub, req.body));
    reply.status(201);
    const [shop] = await db.select().from(schema.shops).where(eq(schema.shops.id, id));
    return shop;
  });

  // Toutes les routes ci-dessous passent par la garde de boutique.
  app.register(async (s) => {
    s.addHook('preHandler', authenticate);
    s.addHook('preHandler', shopGuard);
    const t = s.withTypeProvider<ZodTypeProvider>();

    t.get('/v1/shops/:shopId', async (req) => {
      const [shop] = await db.select().from(schema.shops).where(eq(schema.shops.id, req.shop.id));
      return { ...shop, myRole: req.shop.role };
    });

    t.patch('/v1/shops/:shopId', {
      schema: { body: z.object({ name: z.string().trim().min(2).max(120).optional(), city: z.string().max(80).nullable().optional(), phone: z.string().max(20).nullable().optional(), reservationTtlMinutes: z.number().int().min(10).max(14 * 1440).optional() }) },
    }, async (req) => {
      can(req, 'shop.manage');
      await db.update(schema.shops).set(req.body).where(eq(schema.shops.id, req.shop.id));
      const [shop] = await db.select().from(schema.shops).where(eq(schema.shops.id, req.shop.id));
      return shop;
    });

    t.get('/v1/shops/:shopId/members', async (req) => {
      return db.select({ id: schema.shopMembers.id, role: schema.shopMembers.role, userId: schema.users.id, fullName: schema.users.fullName, email: schema.users.email, phone: schema.users.phone })
        .from(schema.shopMembers).innerJoin(schema.users, eq(schema.users.id, schema.shopMembers.userId))
        .where(eq(schema.shopMembers.shopId, req.shop.id));
    });

    /**
     * Ajoute un membre. S'il n'a pas de compte, on le crée avec un mot de passe
     * temporaire renvoyé UNE fois (à transmettre au membre, qui le changera).
     */
    t.post('/v1/shops/:shopId/members', {
      schema: { body: z.object({ email: z.string().trim().toLowerCase().email(), fullName: z.string().trim().min(2).max(120), role: z.enum(SHOP_ROLES).exclude(['OWNER']) }) },
    }, async (req, reply) => {
      can(req, 'members.manage');
      const b = req.body;
      let tempPassword: string | undefined;
      const result = await db.transaction(async (tx) => {
        let [u] = await tx.select().from(schema.users).where(eq(schema.users.email, b.email));
        if (!u) {
          tempPassword = crypto.randomBytes(9).toString('base64url');
          const id = newId();
          await tx.insert(schema.users).values({ id, email: b.email, fullName: b.fullName, passwordHash: await bcrypt.hash(tempPassword, 10) });
          [u] = await tx.select().from(schema.users).where(eq(schema.users.id, id));
        }
        const [exists] = await tx.select().from(schema.shopMembers).where(and(eq(schema.shopMembers.shopId, req.shop.id), eq(schema.shopMembers.userId, u.id)));
        if (exists) throw conflict('ALREADY_MEMBER', 'Cette personne est déjà membre de la boutique');
        const memberId = newId();
        await tx.insert(schema.shopMembers).values({ id: memberId, shopId: req.shop.id, userId: u.id, role: b.role });
        await audit(tx, { shopId: req.shop.id, actorUserId: req.user.sub, action: 'member.added', entityType: 'member', entityId: memberId, data: { email: b.email, role: b.role } });
        return { memberId, userId: u.id };
      });
      reply.status(201);
      return { ...result, email: b.email, role: b.role, tempPassword };
    });

    t.patch('/v1/shops/:shopId/members/:memberId', { schema: { body: z.object({ role: z.enum(SHOP_ROLES).exclude(['OWNER']) }) } }, async (req) => {
      can(req, 'members.manage');
      const { memberId } = req.params as { memberId: string };
      const [m] = await db.select().from(schema.shopMembers).where(and(eq(schema.shopMembers.id, memberId), eq(schema.shopMembers.shopId, req.shop.id)));
      if (!m) throw notFound('Membre');
      if (m.role === 'OWNER') throw conflict('OWNER_LOCKED', 'Le rôle du propriétaire ne peut pas être modifié');
      await db.update(schema.shopMembers).set({ role: req.body.role }).where(eq(schema.shopMembers.id, memberId));
      return { ok: true };
    });

    t.delete('/v1/shops/:shopId/members/:memberId', async (req) => {
      can(req, 'members.manage');
      const { memberId } = req.params as { memberId: string };
      const [m] = await db.select().from(schema.shopMembers).where(and(eq(schema.shopMembers.id, memberId), eq(schema.shopMembers.shopId, req.shop.id)));
      if (!m) throw notFound('Membre');
      if (m.role === 'OWNER') throw conflict('OWNER_LOCKED', 'Le propriétaire ne peut pas être retiré');
      await db.delete(schema.shopMembers).where(eq(schema.shopMembers.id, memberId));
      return { ok: true };
    });

    t.get('/v1/shops/:shopId/activity', { schema: { querystring: z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }) } }, async (req) => {
      can(req, 'stats.read');
      return db.select().from(schema.auditLogs).where(eq(schema.auditLogs.shopId, req.shop.id)).orderBy(desc(schema.auditLogs.id)).limit(req.query.limit);
    });
  });
}
