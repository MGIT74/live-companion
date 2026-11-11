import { and, desc, eq, inArray, like, or, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { db, schema } from '../db/client.ts';
import { audit } from '../lib/audit.ts';
import { authenticate } from '../lib/auth.ts';
import { conflict, isDuplicate, notFound } from '../lib/errors.ts';
import { newId } from '../lib/ids.ts';
import { can, shopGuard } from '../lib/tenant.ts';
import { normalizePhone } from '../services/customers.ts';
import { REVENUE_STATES } from '../services/orders.ts';
import { ordersWithChildren } from '../services/loaders.ts';

const c = schema.customers;
const o = schema.orders;

const customerBody = z.object({
  fullName: z.string().trim().max(120).nullable().optional(),
  phone: z.string().trim().max(30).nullable().optional(),
  email: z.string().trim().toLowerCase().email().nullable().optional(),
  address: z.string().trim().max(255).nullable().optional(),
  city: z.string().trim().max(80).nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(30)).max(20).nullable().optional(),
});

/** Agrégats d'achat par client : commandes, CA, dernier achat, annulations. */
const stats = {
  ordersCount: sql<number>`COUNT(CASE WHEN ${o.status} IN (${sql.join(REVENUE_STATES.map((s) => sql`${s}`), sql`, `)}) THEN 1 END)`,
  totalSpentMga: sql<number>`COALESCE(SUM(CASE WHEN ${o.status} IN (${sql.join(REVENUE_STATES.map((s) => sql`${s}`), sql`, `)}) THEN ${o.totalMga} END), 0)`,
  lastOrderAt: sql<Date | null>`MAX(${o.createdAt})`,
  cancelledCount: sql<number>`COUNT(CASE WHEN ${o.status} = 'CANCELLED' THEN 1 END)`,
};

export async function customerRoutes(app: FastifyInstance) {
  app.register(async (s) => {
    s.addHook('preHandler', authenticate);
    s.addHook('preHandler', shopGuard);
    const t = s.withTypeProvider<ZodTypeProvider>();

    t.get('/v1/shops/:shopId/customers', {
      schema: { querystring: z.object({
        q: z.string().max(80).optional(),
        sort: z.enum(['recent', 'spent', 'orders', 'name']).default('recent'),
        tag: z.string().max(30).optional(),
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(200).default(50),
      }) },
    }, async (req) => {
      can(req, 'customers.read');
      const { q, sort, page, pageSize, tag } = req.query;
      const phone = normalizePhone(q);
      const where = and(
        eq(c.shopId, req.shop.id),
        q ? or(like(c.fullName, `%${q}%`), phone ? like(c.phone, `%${phone}%`) : undefined, like(c.email, `%${q}%`)) : undefined,
        tag ? sql`JSON_CONTAINS(${c.tags}, ${JSON.stringify(tag)})` : undefined,
      );
      const order = { recent: desc(sql`COALESCE(MAX(${o.createdAt}), ${c.createdAt})`), spent: desc(stats.totalSpentMga), orders: desc(stats.ordersCount), name: sql`${c.fullName} ASC` }[sort];
      const rows = await db.select({
        id: c.id, fullName: c.fullName, phone: c.phone, city: c.city, tags: c.tags, isBlocked: c.isBlocked, createdAt: c.createdAt, ...stats,
      }).from(c).leftJoin(o, and(eq(o.customerId, c.id), eq(o.shopId, req.shop.id))).where(where)
        .groupBy(c.id).orderBy(order).limit(pageSize).offset((page - 1) * pageSize);
      const [{ total }] = await db.select({ total: sql<number>`COUNT(*)` }).from(c).where(where);
      return {
        total: Number(total), page, pageSize,
        items: rows.map((r) => ({ ...r, ordersCount: Number(r.ordersCount), totalSpentMga: Number(r.totalSpentMga), cancelledCount: Number(r.cancelledCount) })),
      };
    });

    /** Fiche client : coordonnées, historique complet, statistiques, produits préférés, lives suivis. */
    t.get('/v1/shops/:shopId/customers/:customerId', async (req) => {
      can(req, 'customers.read');
      const { customerId } = req.params as { customerId: string };
      const [cust] = await db.select().from(c).where(and(eq(c.id, customerId), eq(c.shopId, req.shop.id)));
      if (!cust) throw notFound('Client');
      const history = await ordersWithChildren(req.shop.id, eq(o.customerId, customerId));
      const counted = history.filter((h) => (REVENUE_STATES as string[]).includes(h.status));
      const totalSpent = counted.reduce((a, h) => a + h.totalMga, 0);
      const products = new Map<string, { code: string; name: string; quantity: number }>();
      for (const h of counted) for (const it of h.items) {
        const cur = products.get(it.productId) ?? { code: it.codeSnapshot, name: it.nameSnapshot, quantity: 0 };
        cur.quantity += it.quantity;
        products.set(it.productId, cur);
      }
      const liveIds = [...new Set(history.map((h) => h.liveSessionId).filter(Boolean))] as string[];
      const lives = liveIds.length
        ? await db.select({ id: schema.liveSessions.id, title: schema.liveSessions.title, startedAt: schema.liveSessions.startedAt }).from(schema.liveSessions).where(inArray(schema.liveSessions.id, liveIds))
        : [];
      return {
        ...cust,
        stats: {
          ordersCount: counted.length,
          totalSpentMga: totalSpent,
          averageBasketMga: counted.length ? Math.round(totalSpent / counted.length) : 0,
          cancelledCount: history.filter((h) => h.status === 'CANCELLED').length,
          unpaidMga: counted.reduce((a, h) => a + Math.max(h.totalMga - h.paidMga, 0), 0),
          firstOrderAt: history.at(-1)?.createdAt ?? null,
          lastOrderAt: history[0]?.createdAt ?? null,
        },
        favoriteProducts: [...products.values()].sort((a, b) => b.quantity - a.quantity).slice(0, 5),
        lives,
        orders: history,
      };
    });

    t.post('/v1/shops/:shopId/customers', { schema: { body: customerBody } }, async (req, reply) => {
      can(req, 'customers.write');
      const id = newId();
      try {
        await db.insert(c).values({ id, shopId: req.shop.id, ...req.body, phone: normalizePhone(req.body.phone) ?? null });
      } catch (e) {
        if (isDuplicate(e)) throw conflict('PHONE_TAKEN', 'Un client existe déjà avec ce numéro');
        throw e;
      }
      reply.status(201);
      const [row] = await db.select().from(c).where(eq(c.id, id));
      return row;
    });

    t.patch('/v1/shops/:shopId/customers/:customerId', { schema: { body: customerBody.extend({ isBlocked: z.boolean().optional() }) } }, async (req) => {
      can(req, 'customers.write');
      const { customerId } = req.params as { customerId: string };
      const patch = { ...req.body, ...(req.body.phone !== undefined ? { phone: normalizePhone(req.body.phone) ?? null } : {}) };
      try {
        const [res] = await db.update(c).set(patch).where(and(eq(c.id, customerId), eq(c.shopId, req.shop.id)));
        if (res.affectedRows === 0) throw notFound('Client');
      } catch (e) {
        if (isDuplicate(e)) throw conflict('PHONE_TAKEN', 'Un autre client a déjà ce numéro');
        throw e;
      }
      if (req.body.isBlocked !== undefined) await audit(db, { shopId: req.shop.id, actorUserId: req.user.sub, action: req.body.isBlocked ? 'customer.blocked' : 'customer.unblocked', entityType: 'customer', entityId: customerId });
      const [row] = await db.select().from(c).where(eq(c.id, customerId));
      return row;
    });

    /** Fusionne deux fiches (doublon) : commandes et identifiants passent sur la fiche gardée. */
    t.post('/v1/shops/:shopId/customers/:customerId/merge', { schema: { body: z.object({ duplicateId: z.string().length(26) }) } }, async (req) => {
      can(req, 'customers.write');
      const { customerId } = req.params as { customerId: string };
      if (customerId === req.body.duplicateId) throw conflict('SAME_CUSTOMER', 'Impossible de fusionner un client avec lui-même');
      await db.transaction(async (tx) => {
        const rows = await tx.select().from(c).where(and(eq(c.shopId, req.shop.id), inArray(c.id, [customerId, req.body.duplicateId])));
        const keep = rows.find((r) => r.id === customerId);
        const dup = rows.find((r) => r.id === req.body.duplicateId);
        if (!keep || !dup) throw notFound('Client');
        await tx.update(o).set({ customerId }).where(and(eq(o.shopId, req.shop.id), eq(o.customerId, dup.id)));
        await tx.delete(c).where(eq(c.id, dup.id));
        await tx.update(c).set({
          fullName: keep.fullName ?? dup.fullName, phone: keep.phone ?? dup.phone, email: keep.email ?? dup.email,
          address: keep.address ?? dup.address, city: keep.city ?? dup.city, fbUserId: keep.fbUserId ?? dup.fbUserId,
          messengerPsid: keep.messengerPsid ?? dup.messengerPsid, cancelCount: keep.cancelCount + dup.cancelCount,
          notes: [keep.notes, dup.notes].filter(Boolean).join('\n') || null,
        }).where(eq(c.id, keep.id));
        await audit(tx, { shopId: req.shop.id, actorUserId: req.user.sub, action: 'customer.merged', entityType: 'customer', entityId: keep.id, data: { merged: dup.id } });
      });
      return { ok: true };
    });
  });
}
