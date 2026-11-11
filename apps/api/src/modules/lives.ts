import { formatProductComment } from '@live-companion/order-parser';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { db, schema } from '../db/client.ts';
import { audit } from '../lib/audit.ts';
import { authenticate } from '../lib/auth.ts';
import { conflict, notFound } from '../lib/errors.ts';
import { newId } from '../lib/ids.ts';
import { can, shopGuard } from '../lib/tenant.ts';
import { REVENUE_STATES } from '../services/orders.ts';
import { ingestLiveComment, resolveComment } from '../services/lives.ts';
import { loadProducts } from './catalog.ts';

const ls = schema.liveSessions;
const li = schema.liveSessionItems;
const o = schema.orders;

async function liveStats(shopId: string, liveIds: string[]) {
  if (!liveIds.length) return new Map<string, { orders: number; revenueMga: number; pending: number; cancelled: number; customers: number; comments: number }>();
  const rows = await db.select({
    liveId: o.liveSessionId,
    orders: sql<number>`COUNT(CASE WHEN ${o.status} IN (${sql.join(REVENUE_STATES.map((s) => sql`${s}`), sql`, `)}) THEN 1 END)`,
    revenue: sql<number>`COALESCE(SUM(CASE WHEN ${o.status} IN (${sql.join(REVENUE_STATES.map((s) => sql`${s}`), sql`, `)}) THEN ${o.totalMga} END), 0)`,
    pending: sql<number>`COUNT(CASE WHEN ${o.status} = 'PENDING_CONFIRMATION' THEN 1 END)`,
    cancelled: sql<number>`COUNT(CASE WHEN ${o.status} = 'CANCELLED' THEN 1 END)`,
    customers: sql<number>`COUNT(DISTINCT ${o.customerId})`,
  }).from(o).where(and(eq(o.shopId, shopId), inArray(o.liveSessionId, liveIds))).groupBy(o.liveSessionId);
  const comments = await db.select({ liveId: schema.liveComments.liveSessionId, n: sql<number>`COUNT(*)` }).from(schema.liveComments)
    .where(and(eq(schema.liveComments.shopId, shopId), inArray(schema.liveComments.liveSessionId, liveIds))).groupBy(schema.liveComments.liveSessionId);
  const cmap = new Map(comments.map((c) => [c.liveId, Number(c.n)]));
  const map = new Map<string, { orders: number; revenueMga: number; pending: number; cancelled: number; customers: number; comments: number }>();
  for (const id of liveIds) map.set(id, { orders: 0, revenueMga: 0, pending: 0, cancelled: 0, customers: 0, comments: cmap.get(id) ?? 0 });
  for (const r of rows) map.set(r.liveId!, { orders: Number(r.orders), revenueMga: Number(r.revenue), pending: Number(r.pending), cancelled: Number(r.cancelled), customers: Number(r.customers), comments: cmap.get(r.liveId!) ?? 0 });
  return map;
}

async function loadLive(shopId: string, liveId: string) {
  const [live] = await db.select().from(ls).where(and(eq(ls.id, liveId), eq(ls.shopId, shopId)));
  if (!live) throw notFound('Live');
  const items = await db.select().from(li).where(and(eq(li.shopId, shopId), eq(li.liveSessionId, liveId))).orderBy(asc(li.position));
  const products = items.length ? await loadProducts(shopId, [...new Set(items.map((i) => i.productId))]) : [];
  const pmap = new Map(products.map((p) => [p.id, p]));
  const stats = (await liveStats(shopId, [liveId])).get(liveId);
  return {
    ...live,
    stats,
    items: items.map((i) => {
      const product = pmap.get(i.productId)!;
      return { ...i, product, commentText: formatProductComment(product) };
    }),
  };
}

export async function liveRoutes(app: FastifyInstance) {
  app.register(async (s) => {
    s.addHook('preHandler', authenticate);
    s.addHook('preHandler', shopGuard);
    const t = s.withTypeProvider<ZodTypeProvider>();

    t.get('/v1/shops/:shopId/lives', { schema: { querystring: z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }) } }, async (req) => {
      can(req, 'lives.read');
      const rows = await db.select().from(ls).where(eq(ls.shopId, req.shop.id)).orderBy(desc(ls.createdAt)).limit(req.query.limit);
      const stats = await liveStats(req.shop.id, rows.map((r) => r.id));
      return rows.map((r) => ({ ...r, stats: stats.get(r.id) }));
    });

    t.post('/v1/shops/:shopId/lives', {
      schema: { body: z.object({ title: z.string().trim().min(1).max(160), productIds: z.array(z.string().length(26)).max(200).default([]), mode: z.enum(['AUTOMATIC', 'SEMI_AUTOMATIC', 'MANUAL_ASSISTED']).default('MANUAL_ASSISTED') }) },
    }, async (req, reply) => {
      can(req, 'lives.write');
      const id = newId();
      await db.transaction(async (tx) => {
        await tx.insert(ls).values({ id, shopId: req.shop.id, title: req.body.title, mode: req.body.mode });
        await setPlaylist(tx, req.shop.id, id, req.body.productIds);
      });
      reply.status(201);
      return loadLive(req.shop.id, id);
    });

    t.get('/v1/shops/:shopId/lives/:liveId', async (req) => {
      can(req, 'lives.read');
      return loadLive(req.shop.id, (req.params as { liveId: string }).liveId);
    });

    t.patch('/v1/shops/:shopId/lives/:liveId', {
      schema: { body: z.object({ title: z.string().trim().min(1).max(160).optional(), fbLiveVideoId: z.string().max(60).nullable().optional(), mode: z.enum(['AUTOMATIC', 'SEMI_AUTOMATIC', 'MANUAL_ASSISTED']).optional() }) },
    }, async (req) => {
      can(req, 'lives.write');
      const { liveId } = req.params as { liveId: string };
      await db.update(ls).set(req.body).where(and(eq(ls.id, liveId), eq(ls.shopId, req.shop.id)));
      return loadLive(req.shop.id, liveId);
    });

    t.post('/v1/shops/:shopId/lives/:liveId/:action', {
      schema: { params: z.object({ shopId: z.string(), liveId: z.string().length(26), action: z.enum(['start', 'end']) }) },
    }, async (req) => {
      can(req, 'lives.write');
      const { liveId, action } = req.params;
      const live = await loadLive(req.shop.id, liveId);
      if (action === 'start' && live.status === 'ENDED') throw conflict('LIVE_ENDED', 'Ce live est terminé : créez-en un nouveau');
      await db.update(ls).set(action === 'start' ? { status: 'LIVE', startedAt: live.startedAt ?? new Date() } : { status: 'ENDED', endedAt: new Date() }).where(eq(ls.id, liveId));
      await audit(db, { shopId: req.shop.id, actorUserId: req.user.sub, action: `live.${action}`, entityType: 'live', entityId: liveId });
      return loadLive(req.shop.id, liveId);
    });

    t.put('/v1/shops/:shopId/lives/:liveId/items', { schema: { body: z.object({ productIds: z.array(z.string().length(26)).max(200) }) } }, async (req) => {
      can(req, 'lives.write');
      const { liveId } = req.params as { liveId: string };
      await loadLive(req.shop.id, liveId);
      await db.transaction((tx) => setPlaylist(tx, req.shop.id, liveId, req.body.productIds));
      return loadLive(req.shop.id, liveId);
    });

    /** Produit présenté maintenant (1 clic). Sans itemId : produit suivant de la playlist. */
    t.post('/v1/shops/:shopId/lives/:liveId/present', { schema: { body: z.object({ itemId: z.string().length(26).optional() }) } }, async (req) => {
      can(req, 'lives.write');
      const { liveId } = req.params as { liveId: string };
      const live = await loadLive(req.shop.id, liveId);
      if (!live.items.length) throw conflict('EMPTY_PLAYLIST', 'Ajoutez des produits au live');
      const idx = live.items.findIndex((i) => i.id === live.currentItemId);
      const target = req.body.itemId ? live.items.find((i) => i.id === req.body.itemId) : live.items[(idx + 1) % live.items.length];
      if (!target) throw notFound('Produit du live');
      await db.update(ls).set({ currentItemId: target.id }).where(eq(ls.id, liveId));
      await db.update(li).set({ presentedAt: new Date() }).where(eq(li.id, target.id));
      return loadLive(req.shop.id, liveId);
    });

    t.patch('/v1/shops/:shopId/lives/:liveId/items/:itemId', {
      schema: { body: z.object({ fbCommentId: z.string().max(80).nullable().optional(), publishState: z.enum(['NOT_PUBLISHED', 'COPIED', 'PUBLISHED_API', 'PUBLISHED_MANUAL']).optional(), pinned: z.boolean().optional() }) },
    }, async (req) => {
      can(req, 'lives.write');
      const { liveId, itemId } = req.params as { liveId: string; itemId: string };
      const [res] = await db.update(li).set(req.body).where(and(eq(li.id, itemId), eq(li.shopId, req.shop.id), eq(li.liveSessionId, liveId)));
      if (res.affectedRows === 0) throw notFound('Produit du live');
      return loadLive(req.shop.id, liveId);
    });

    // ---------------------------------------------------------------- Commentaires → commandes
    t.post('/v1/shops/:shopId/lives/:liveId/comments', {
      schema: { body: z.object({
        fbCommentId: z.string().max(80).optional(), parentId: z.string().max(80).optional(), authorId: z.string().max(40).optional(),
        authorName: z.string().max(160).optional(), message: z.string().min(1).max(8000), createdTime: z.coerce.date().optional(),
        source: z.enum(['SSE', 'POLL', 'WEBHOOK', 'MANUAL']).optional(), fromPage: z.boolean().optional(),
      }) },
    }, async (req) => {
      can(req, 'lives.write');
      return ingestLiveComment(req.shop.id, (req.params as { liveId: string }).liveId, req.body, req.user.sub);
    });

    t.get('/v1/shops/:shopId/lives/:liveId/comments', {
      schema: { querystring: z.object({ status: z.enum(['NOT_AN_ORDER', 'ORDERED', 'NEEDS_REVIEW', 'WAITLISTED', 'REJECTED']).optional(), limit: z.coerce.number().int().min(1).max(1000).default(300) }) },
    }, async (req) => {
      can(req, 'lives.read');
      const { liveId } = req.params as { liveId: string };
      const c = schema.liveComments;
      return db.select().from(c).where(and(eq(c.shopId, req.shop.id), eq(c.liveSessionId, liveId), req.query.status ? eq(c.parseStatus, req.query.status) : undefined))
        .orderBy(desc(c.receivedAt)).limit(req.query.limit);
    });

    t.post('/v1/shops/:shopId/lives/:liveId/comments/:commentId/resolve', {
      schema: { body: z.object({ action: z.enum(['accept', 'reject']), variantId: z.string().length(26).optional(), quantity: z.number().int().min(1).max(100).optional(), customer: z.object({ fullName: z.string().max(120).optional(), phone: z.string().max(30).optional() }).optional() }) },
    }, async (req) => {
      can(req, 'lives.write');
      const { liveId, commentId } = req.params as { liveId: string; commentId: string };
      return resolveComment(req.shop.id, liveId, commentId, req.body, req.user.sub);
    });

    /** Saisie rapide de l'assistant : « JP01 2 M » + nom/téléphone du client. */
    t.post('/v1/shops/:shopId/lives/:liveId/quick-order', {
      schema: { body: z.object({ text: z.string().min(1).max(200), customer: z.object({ fullName: z.string().max(120).optional(), phone: z.string().max(30).optional() }) }) },
    }, async (req) => {
      can(req, 'lives.write');
      const { liveId } = req.params as { liveId: string };
      const { customer, text } = req.body;
      const res = await ingestLiveComment(req.shop.id, liveId, { message: text, authorName: customer.fullName, source: 'MANUAL' }, req.user.sub);
      // Rattache le téléphone saisi à la fiche client de la commande.
      if (res.outcome.status === 'ORDERED' && customer.phone) {
        const [ord] = await db.select({ customerId: o.customerId }).from(o).where(eq(o.id, res.outcome.orderId));
        const { normalizePhone } = await import('../services/customers.ts');
        await db.update(schema.customers).set({ phone: normalizePhone(customer.phone) }).where(and(eq(schema.customers.id, ord.customerId), sql`${schema.customers.phone} IS NULL`)).catch(() => undefined);
      }
      return res;
    });
  });
}

async function setPlaylist(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], shopId: string, liveId: string, productIds: string[]) {
  if (productIds.length) {
    const found = await tx.select({ id: schema.products.id }).from(schema.products).where(and(eq(schema.products.shopId, shopId), inArray(schema.products.id, productIds)));
    if (found.length !== new Set(productIds).size) throw notFound('Produit');
  }
  const existing = await tx.select().from(li).where(and(eq(li.shopId, shopId), eq(li.liveSessionId, liveId)));
  const byProduct = new Map(existing.map((e) => [e.productId, e]));
  const keep = new Set<string>();
  for (const [position, productId] of productIds.entries()) {
    const cur = byProduct.get(productId);
    if (cur) { keep.add(cur.id); await tx.update(li).set({ position }).where(eq(li.id, cur.id)); }
    else await tx.insert(li).values({ id: newId(), shopId, liveSessionId: liveId, productId, position });
  }
  const remove = existing.filter((e) => !keep.has(e.id) && !productIds.includes(e.productId)).map((e) => e.id);
  if (remove.length) await tx.delete(li).where(inArray(li.id, remove));
}
