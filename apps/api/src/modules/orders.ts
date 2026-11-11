import { and, desc, eq, gte, inArray, like, lt, or, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { db, schema } from '../db/client.ts';
import { ORDER_CHANNELS, ORDER_STATUSES, PAYMENT_METHODS } from '../db/schema.ts';
import { audit } from '../lib/audit.ts';
import { authenticate } from '../lib/auth.ts';
import { badRequest, conflict, notFound } from '../lib/errors.ts';
import { newId } from '../lib/ids.ts';
import { can, shopGuard } from '../lib/tenant.ts';
import { findOrCreateCustomer } from '../services/customers.ts';
import { addItems, createOrder, getOrder, transitionOrder } from '../services/orders.ts';

const o = schema.orders;
const items = z.array(z.object({ variantId: z.string().length(26), quantity: z.number().int().min(1).max(1000), unitPriceMga: z.number().int().min(0).optional() })).min(1).max(100);

async function refreshPaid(shopId: string, orderId: string) {
  const [s] = await db.select({ paid: sql<number>`COALESCE(SUM(${schema.payments.amountMga}), 0)` }).from(schema.payments)
    .where(and(eq(schema.payments.shopId, shopId), eq(schema.payments.orderId, orderId), eq(schema.payments.status, 'CONFIRMED')));
  await db.update(o).set({ paidMga: Number(s.paid) }).where(and(eq(o.id, orderId), eq(o.shopId, shopId)));
  return Number(s.paid);
}

export async function orderRoutes(app: FastifyInstance) {
  app.register(async (s) => {
    s.addHook('preHandler', authenticate);
    s.addHook('preHandler', shopGuard);
    const t = s.withTypeProvider<ZodTypeProvider>();

    t.get('/v1/shops/:shopId/orders', {
      schema: { querystring: z.object({
        status: z.string().optional(), // liste séparée par des virgules
        channel: z.enum(ORDER_CHANNELS).optional(),
        customerId: z.string().length(26).optional(),
        liveSessionId: z.string().length(26).optional(),
        unpaid: z.enum(['true', 'false']).optional(),
        q: z.string().max(80).optional(),
        from: z.coerce.date().optional(),
        to: z.coerce.date().optional(),
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(200).default(50),
      }) },
    }, async (req) => {
      can(req, 'orders.read');
      const qy = req.query;
      const statuses = qy.status?.split(',').filter((x): x is (typeof ORDER_STATUSES)[number] => (ORDER_STATUSES as readonly string[]).includes(x));
      const where = and(
        eq(o.shopId, req.shop.id),
        statuses?.length ? inArray(o.status, statuses) : undefined,
        qy.channel ? eq(o.channel, qy.channel) : undefined,
        qy.customerId ? eq(o.customerId, qy.customerId) : undefined,
        qy.liveSessionId ? eq(o.liveSessionId, qy.liveSessionId) : undefined,
        qy.unpaid === 'true' ? sql`${o.paidMga} < ${o.totalMga} AND ${o.status} NOT IN ('CANCELLED','RETURNED')` : undefined,
        qy.from ? gte(o.createdAt, qy.from) : undefined,
        qy.to ? lt(o.createdAt, qy.to) : undefined,
        qy.q ? or(like(o.number, `%${qy.q}%`), like(schema.customers.fullName, `%${qy.q}%`), like(schema.customers.phone, `%${qy.q.replace(/\s/g, '')}%`)) : undefined,
      );
      const rows = await db.select({
        id: o.id, number: o.number, status: o.status, channel: o.channel, totalMga: o.totalMga, paidMga: o.paidMga,
        createdAt: o.createdAt, liveSessionId: o.liveSessionId, deliveryCity: o.deliveryCity,
        customer: { id: schema.customers.id, fullName: schema.customers.fullName, phone: schema.customers.phone },
        itemsCount: sql<number>`(SELECT COALESCE(SUM(quantity),0) FROM order_items oi WHERE oi.order_id = ${o.id})`,
      }).from(o).innerJoin(schema.customers, eq(schema.customers.id, o.customerId)).where(where)
        .orderBy(desc(o.createdAt)).limit(qy.pageSize).offset((qy.page - 1) * qy.pageSize);
      const [{ total }] = await db.select({ total: sql<number>`COUNT(*)` }).from(o).innerJoin(schema.customers, eq(schema.customers.id, o.customerId)).where(where);
      return { total: Number(total), page: qy.page, pageSize: qy.pageSize, items: rows.map((r) => ({ ...r, itemsCount: Number(r.itemsCount) })) };
    });

    t.get('/v1/shops/:shopId/orders/:orderId', async (req) => {
      can(req, 'orders.read');
      return getOrder(req.shop.id, (req.params as { orderId: string }).orderId);
    });

    /** Commande manuelle (hors live) : client existant (customerId) ou nouveau (customer). */
    t.post('/v1/shops/:shopId/orders', {
      schema: { body: z.object({
        customerId: z.string().length(26).optional(),
        customer: z.object({ fullName: z.string().max(120).optional(), phone: z.string().max(30).optional(), city: z.string().max(80).optional(), address: z.string().max(255).optional() }).optional(),
        channel: z.enum(ORDER_CHANNELS).default('MANUAL'),
        liveSessionId: z.string().length(26).optional(),
        items,
        shippingMga: z.number().int().min(0).optional(),
        discountMga: z.number().int().min(0).optional(),
        deliveryAddress: z.string().max(255).optional(),
        deliveryCity: z.string().max(80).optional(),
        notes: z.string().max(2000).optional(),
        confirmed: z.boolean().default(false),
      }) },
    }, async (req, reply) => {
      can(req, 'orders.write');
      const b = req.body;
      if (!b.customerId && !b.customer) throw badRequest('CUSTOMER_REQUIRED', 'Client requis');
      const order = await db.transaction(async (tx) => {
        const customerId = b.customerId ?? (await findOrCreateCustomer(req.shop.id, b.customer!, tx)).id;
        return createOrder(req.shop.id, { ...b, customerId, status: b.confirmed ? 'CONFIRMED' : 'PENDING_CONFIRMATION' }, req.user.sub, tx);
      });
      reply.status(201);
      return order;
    });

    t.post('/v1/shops/:shopId/orders/:orderId/items', { schema: { body: z.object({ items }) } }, async (req) => {
      can(req, 'orders.write');
      return addItems(req.shop.id, (req.params as { orderId: string }).orderId, req.body.items, req.user.sub);
    });

    t.patch('/v1/shops/:shopId/orders/:orderId', {
      schema: { body: z.object({ shippingMga: z.number().int().min(0).optional(), discountMga: z.number().int().min(0).optional(), deliveryAddress: z.string().max(255).nullable().optional(), deliveryCity: z.string().max(80).nullable().optional(), notes: z.string().max(2000).nullable().optional() }) },
    }, async (req) => {
      can(req, 'orders.write');
      const { orderId } = req.params as { orderId: string };
      const ord = await getOrder(req.shop.id, orderId);
      if (['SHIPPED', 'DELIVERED', 'CANCELLED', 'RETURNED'].includes(ord.status) && (req.body.shippingMga !== undefined || req.body.discountMga !== undefined)) {
        throw conflict('ORDER_LOCKED', 'Montants non modifiables après expédition ou annulation');
      }
      await db.update(o).set({
        ...req.body,
        ...(req.body.shippingMga !== undefined || req.body.discountMga !== undefined
          ? { totalMga: sql`GREATEST(${o.subtotalMga} + ${req.body.shippingMga ?? ord.shippingMga} - ${req.body.discountMga ?? ord.discountMga}, 0)` }
          : {}),
      }).where(and(eq(o.id, orderId), eq(o.shopId, req.shop.id)));
      return getOrder(req.shop.id, orderId);
    });

    t.post('/v1/shops/:shopId/orders/:orderId/status', { schema: { body: z.object({ status: z.enum(ORDER_STATUSES), note: z.string().max(255).optional() }) } }, async (req) => {
      can(req, 'orders.write');
      return transitionOrder(req.shop.id, (req.params as { orderId: string }).orderId, req.body.status, req.user.sub, req.body.note);
    });

    // ---------------------------------------------------------------- Paiements
    t.post('/v1/shops/:shopId/orders/:orderId/payments', {
      schema: { body: z.object({ method: z.enum(PAYMENT_METHODS), amountMga: z.number().int().min(1), providerRef: z.string().max(80).optional(), confirmed: z.boolean().default(false) }) },
    }, async (req, reply) => {
      can(req, 'payments.write');
      const { orderId } = req.params as { orderId: string };
      const ord = await getOrder(req.shop.id, orderId);
      if (['CANCELLED', 'RETURNED'].includes(ord.status)) throw conflict('ORDER_CLOSED', 'Commande annulée ou retournée');
      const id = newId();
      await db.insert(schema.payments).values({
        id, shopId: req.shop.id, orderId, method: req.body.method, amountMga: req.body.amountMga, providerRef: req.body.providerRef,
        status: req.body.confirmed ? 'CONFIRMED' : 'PENDING', confirmedByUserId: req.body.confirmed ? req.user.sub : null, confirmedAt: req.body.confirmed ? new Date() : null,
      });
      if (req.body.confirmed) await afterPaymentConfirmed(req.shop.id, orderId, req.user.sub);
      await audit(db, { shopId: req.shop.id, actorUserId: req.user.sub, action: 'payment.recorded', entityType: 'payment', entityId: id, data: { orderId, ...req.body } });
      reply.status(201);
      return getOrder(req.shop.id, orderId);
    });

    t.post('/v1/shops/:shopId/payments/:paymentId/:action', {
      schema: { params: z.object({ shopId: z.string(), paymentId: z.string().length(26), action: z.enum(['confirm', 'fail', 'refund']) }) },
    }, async (req) => {
      can(req, 'payments.write');
      const { paymentId, action } = req.params;
      const [pay] = await db.select().from(schema.payments).where(and(eq(schema.payments.id, paymentId), eq(schema.payments.shopId, req.shop.id)));
      if (!pay) throw notFound('Paiement');
      const status = ({ confirm: 'CONFIRMED', fail: 'FAILED', refund: 'REFUNDED' } as const)[action];
      if (action === 'refund' && pay.status !== 'CONFIRMED') throw conflict('NOT_CONFIRMED', 'Seul un paiement confirmé peut être remboursé');
      await db.update(schema.payments).set({ status, ...(action === 'confirm' ? { confirmedByUserId: req.user.sub, confirmedAt: new Date() } : {}) }).where(eq(schema.payments.id, paymentId));
      if (action === 'confirm') await afterPaymentConfirmed(req.shop.id, pay.orderId, req.user.sub);
      else await refreshPaid(req.shop.id, pay.orderId);
      await audit(db, { shopId: req.shop.id, actorUserId: req.user.sub, action: `payment.${action}`, entityType: 'payment', entityId: paymentId });
      return getOrder(req.shop.id, pay.orderId);
    });

    // ---------------------------------------------------------------- Livraisons
    t.post('/v1/shops/:shopId/orders/:orderId/shipments', {
      schema: { body: z.object({ method: z.enum(['COURIER', 'PICKUP', 'TAXI_BROUSSE', 'POST', 'OTHER']), carrierName: z.string().max(120).optional(), trackingNote: z.string().max(255).optional(), feeMga: z.number().int().min(0).default(0) }) },
    }, async (req, reply) => {
      can(req, 'orders.write');
      const { orderId } = req.params as { orderId: string };
      await getOrder(req.shop.id, orderId);
      await db.insert(schema.shipments).values({ id: newId(), shopId: req.shop.id, orderId, ...req.body });
      reply.status(201);
      return getOrder(req.shop.id, orderId);
    });

    /** Statut de livraison : « en route » expédie la commande, « livrée » la clôture. */
    t.patch('/v1/shops/:shopId/shipments/:shipmentId', {
      schema: { body: z.object({ status: z.enum(['PENDING', 'IN_TRANSIT', 'DELIVERED', 'FAILED', 'RETURNED']).optional(), trackingNote: z.string().max(255).optional(), carrierName: z.string().max(120).optional() }) },
    }, async (req) => {
      can(req, 'orders.write');
      const { shipmentId } = req.params as { shipmentId: string };
      const [sh] = await db.select().from(schema.shipments).where(and(eq(schema.shipments.id, shipmentId), eq(schema.shipments.shopId, req.shop.id)));
      if (!sh) throw notFound('Livraison');
      const st = req.body.status;
      await db.update(schema.shipments).set({
        ...req.body,
        ...(st === 'IN_TRANSIT' && !sh.shippedAt ? { shippedAt: new Date() } : {}),
        ...(st === 'DELIVERED' ? { deliveredAt: new Date(), shippedAt: sh.shippedAt ?? new Date() } : {}),
      }).where(eq(schema.shipments.id, shipmentId));
      const ord = await getOrder(req.shop.id, sh.orderId);
      if (st === 'IN_TRANSIT' && !['SHIPPED', 'DELIVERED'].includes(ord.status)) await transitionOrder(req.shop.id, sh.orderId, 'SHIPPED', req.user.sub);
      if (st === 'DELIVERED') {
        if (!['SHIPPED', 'DELIVERED'].includes(ord.status)) await transitionOrder(req.shop.id, sh.orderId, 'SHIPPED', req.user.sub);
        await transitionOrder(req.shop.id, sh.orderId, 'DELIVERED', req.user.sub);
      }
      return getOrder(req.shop.id, sh.orderId);
    });
  });
}

/** Met à jour le payé ; une commande entièrement payée passe en PAID si elle n'est pas encore expédiée. */
async function afterPaymentConfirmed(shopId: string, orderId: string, actorUserId: string) {
  const paid = await refreshPaid(shopId, orderId);
  const ord = await getOrder(shopId, orderId);
  if (paid >= ord.totalMga && ['PENDING_CONFIRMATION', 'CONFIRMED'].includes(ord.status)) await transitionOrder(shopId, orderId, 'PAID', actorUserId, 'Paiement complet');
}
