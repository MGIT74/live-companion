import { and, desc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { db, schema } from '../db/client.ts';
import { authenticate } from '../lib/auth.ts';
import { can, shopGuard } from '../lib/tenant.ts';
import { REVENUE_STATES } from '../services/orders.ts';

const o = schema.orders;
const oi = schema.orderItems;
const inRevenue = inArray(o.status, REVENUE_STATES);

/** Période par défaut : les 30 derniers jours. Fuseau d'affichage : Madagascar (UTC+3). */
const range = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  tz: z.string().regex(/^[+-]\d{2}:\d{2}$/).default('+03:00'),
});
function period(q: { from?: Date; to?: Date }) {
  const to = q.to ?? new Date();
  const from = q.from ?? new Date(to.getTime() - 30 * 86_400_000);
  return { from, to };
}

export async function statsRoutes(app: FastifyInstance) {
  app.register(async (s) => {
    s.addHook('preHandler', authenticate);
    s.addHook('preHandler', shopGuard);
    const t = s.withTypeProvider<ZodTypeProvider>();

    /** Chiffres clés de la période. */
    t.get('/v1/shops/:shopId/stats/overview', { schema: { querystring: range } }, async (req) => {
      can(req, 'stats.read');
      const { from, to } = period(req.query);
      const inPeriod = and(eq(o.shopId, req.shop.id), gte(o.createdAt, from), lt(o.createdAt, to));
      const [a] = await db.select({
        orders: sql<number>`COUNT(CASE WHEN ${inRevenue} THEN 1 END)`,
        revenue: sql<number>`COALESCE(SUM(CASE WHEN ${inRevenue} THEN ${o.totalMga} END), 0)`,
        paid: sql<number>`COALESCE(SUM(CASE WHEN ${inRevenue} THEN ${o.paidMga} END), 0)`,
        pending: sql<number>`COUNT(CASE WHEN ${o.status} = 'PENDING_CONFIRMATION' THEN 1 END)`,
        pendingAmount: sql<number>`COALESCE(SUM(CASE WHEN ${o.status} = 'PENDING_CONFIRMATION' THEN ${o.totalMga} END), 0)`,
        cancelled: sql<number>`COUNT(CASE WHEN ${o.status} = 'CANCELLED' THEN 1 END)`,
        delivered: sql<number>`COUNT(CASE WHEN ${o.status} = 'DELIVERED' THEN 1 END)`,
        customers: sql<number>`COUNT(DISTINCT CASE WHEN ${inRevenue} THEN ${o.customerId} END)`,
        all: sql<number>`COUNT(*)`,
      }).from(o).where(inPeriod);
      const [items] = await db.select({ qty: sql<number>`COALESCE(SUM(${oi.quantity}), 0)` }).from(oi)
        .innerJoin(o, eq(o.id, oi.orderId)).where(and(inPeriod, inRevenue));
      const [newCustomers] = await db.select({ n: sql<number>`COUNT(*)` }).from(schema.customers)
        .where(and(eq(schema.customers.shopId, req.shop.id), gte(schema.customers.createdAt, from), lt(schema.customers.createdAt, to)));
      // Clients revenus : ont commandé dans la période ET avaient déjà commandé avant.
      const [returning] = await db.select({ n: sql<number>`COUNT(DISTINCT ${o.customerId})` }).from(o)
        .where(and(inPeriod, inRevenue, sql`EXISTS (SELECT 1 FROM orders p WHERE p.shop_id = ${o.shopId} AND p.customer_id = ${o.customerId} AND p.created_at < ${from} AND p.status IN (${sql.join(REVENUE_STATES.map((x) => sql`${x}`), sql`, `)}))`));
      const n = (x: unknown) => Number(x ?? 0);
      const decided = n(a.orders) + n(a.cancelled);
      return {
        from, to,
        revenueMga: n(a.revenue),
        paidMga: n(a.paid),
        unpaidMga: n(a.revenue) - n(a.paid),
        orders: n(a.orders),
        averageBasketMga: n(a.orders) ? Math.round(n(a.revenue) / n(a.orders)) : 0,
        itemsSold: n(items.qty),
        pendingOrders: n(a.pending),
        pendingAmountMga: n(a.pendingAmount),
        cancelledOrders: n(a.cancelled),
        deliveredOrders: n(a.delivered),
        confirmationRate: decided ? Math.round((n(a.orders) / decided) * 1000) / 10 : null, // en %
        buyingCustomers: n(a.customers),
        newCustomers: n(newCustomers.n),
        returningCustomers: n(returning.n),
      };
    });

    /** Ventes jour par jour (fuseau de la boutique). */
    t.get('/v1/shops/:shopId/stats/sales-by-day', { schema: { querystring: range } }, async (req) => {
      can(req, 'stats.read');
      const { from, to } = period(req.query);
      const day = sql<string>`DATE_FORMAT(CONVERT_TZ(${o.createdAt}, '+00:00', ${req.query.tz}), '%Y-%m-%d')`;
      const rows = await db.select({ day, orders: sql<number>`COUNT(*)`, revenue: sql<number>`SUM(${o.totalMga})` }).from(o)
        .where(and(eq(o.shopId, req.shop.id), inRevenue, gte(o.createdAt, from), lt(o.createdAt, to)))
        .groupBy(day).orderBy(day);
      return rows.map((r) => ({ day: r.day, orders: Number(r.orders), revenueMga: Number(r.revenue) }));
    });

    t.get('/v1/shops/:shopId/stats/top-products', { schema: { querystring: range.extend({ limit: z.coerce.number().int().min(1).max(100).default(10) }) } }, async (req) => {
      can(req, 'stats.read');
      const { from, to } = period(req.query);
      const rows = await db.select({
        productId: oi.productId, code: sql<string>`MAX(${oi.codeSnapshot})`, name: sql<string>`MAX(${oi.nameSnapshot})`,
        quantity: sql<number>`SUM(${oi.quantity})`, revenue: sql<number>`SUM(${oi.quantity} * ${oi.unitPriceMga})`, orders: sql<number>`COUNT(DISTINCT ${oi.orderId})`,
      }).from(oi).innerJoin(o, eq(o.id, oi.orderId))
        .where(and(eq(oi.shopId, req.shop.id), inRevenue, gte(o.createdAt, from), lt(o.createdAt, to)))
        .groupBy(oi.productId).orderBy(desc(sql`SUM(${oi.quantity} * ${oi.unitPriceMga})`)).limit(req.query.limit);
      return rows.map((r) => ({ ...r, quantity: Number(r.quantity), revenueMga: Number(r.revenue), orders: Number(r.orders), revenue: undefined }));
    });

    t.get('/v1/shops/:shopId/stats/top-customers', { schema: { querystring: range.extend({ limit: z.coerce.number().int().min(1).max(100).default(10) }) } }, async (req) => {
      can(req, 'stats.read');
      const { from, to } = period(req.query);
      const rows = await db.select({
        customerId: o.customerId, fullName: schema.customers.fullName, phone: schema.customers.phone,
        orders: sql<number>`COUNT(*)`, revenue: sql<number>`SUM(${o.totalMga})`, lastOrderAt: sql<Date>`MAX(${o.createdAt})`,
      }).from(o).innerJoin(schema.customers, eq(schema.customers.id, o.customerId))
        .where(and(eq(o.shopId, req.shop.id), inRevenue, gte(o.createdAt, from), lt(o.createdAt, to)))
        .groupBy(o.customerId, schema.customers.fullName, schema.customers.phone)
        .orderBy(desc(sql`SUM(${o.totalMga})`)).limit(req.query.limit);
      return rows.map((r) => ({ ...r, orders: Number(r.orders), revenueMga: Number(r.revenue), revenue: undefined }));
    });

    /** Performance de chaque live : commandes, CA, taux de confirmation, clients. */
    t.get('/v1/shops/:shopId/stats/lives', { schema: { querystring: range } }, async (req) => {
      can(req, 'stats.read');
      const { from, to } = period(req.query);
      const ls = schema.liveSessions;
      const rows = await db.select({
        id: ls.id, title: ls.title, status: ls.status, startedAt: ls.startedAt, endedAt: ls.endedAt, createdAt: ls.createdAt,
        orders: sql<number>`COUNT(CASE WHEN ${inRevenue} THEN 1 END)`,
        revenue: sql<number>`COALESCE(SUM(CASE WHEN ${inRevenue} THEN ${o.totalMga} END), 0)`,
        cancelled: sql<number>`COUNT(CASE WHEN ${o.status} = 'CANCELLED' THEN 1 END)`,
        pending: sql<number>`COUNT(CASE WHEN ${o.status} = 'PENDING_CONFIRMATION' THEN 1 END)`,
        customers: sql<number>`COUNT(DISTINCT ${o.customerId})`,
      }).from(ls).leftJoin(o, and(eq(o.liveSessionId, ls.id), eq(o.shopId, ls.shopId)))
        .where(and(eq(ls.shopId, req.shop.id), gte(ls.createdAt, from), lt(ls.createdAt, to)))
        .groupBy(ls.id).orderBy(desc(ls.createdAt));
      return rows.map((r) => {
        const orders = Number(r.orders); const cancelled = Number(r.cancelled);
        return { ...r, orders, revenueMga: Number(r.revenue), cancelled, pending: Number(r.pending), customers: Number(r.customers), confirmationRate: orders + cancelled ? Math.round((orders / (orders + cancelled)) * 1000) / 10 : null, revenue: undefined };
      });
    });

    t.get('/v1/shops/:shopId/stats/payments', { schema: { querystring: range } }, async (req) => {
      can(req, 'stats.read');
      const { from, to } = period(req.query);
      const p = schema.payments;
      const rows = await db.select({ method: p.method, count: sql<number>`COUNT(*)`, amount: sql<number>`SUM(${p.amountMga})` }).from(p)
        .where(and(eq(p.shopId, req.shop.id), eq(p.status, 'CONFIRMED'), gte(p.createdAt, from), lt(p.createdAt, to)))
        .groupBy(p.method).orderBy(desc(sql`SUM(${p.amountMga})`));
      return rows.map((r) => ({ method: r.method, count: Number(r.count), amountMga: Number(r.amount) }));
    });

    t.get('/v1/shops/:shopId/stats/channels', { schema: { querystring: range } }, async (req) => {
      can(req, 'stats.read');
      const { from, to } = period(req.query);
      const rows = await db.select({ channel: o.channel, orders: sql<number>`COUNT(*)`, revenue: sql<number>`SUM(${o.totalMga})` }).from(o)
        .where(and(eq(o.shopId, req.shop.id), inRevenue, gte(o.createdAt, from), lt(o.createdAt, to))).groupBy(o.channel);
      return rows.map((r) => ({ channel: r.channel, orders: Number(r.orders), revenueMga: Number(r.revenue) }));
    });
  });
}
