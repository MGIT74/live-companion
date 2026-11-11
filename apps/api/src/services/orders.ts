import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Tx } from '../db/client.ts';
import { db, schema } from '../db/client.ts';
import type { OrderStatus } from '../db/schema.ts';
import { audit } from '../lib/audit.ts';
import { badRequest, conflict, notFound } from '../lib/errors.ts';
import { newId } from '../lib/ids.ts';
import { commitSale, release, reserve, restockReturn } from './stock.ts';
import { ordersWithChildren } from './loaders.ts';

const o = schema.orders;

export interface ItemInput { variantId: string; quantity: number; unitPriceMga?: number }

/** Statuts pour lesquels la marchandise est sortie du stock. */
const SHIPPED_STATES: OrderStatus[] = ['SHIPPED', 'DELIVERED', 'RETURNED'];
/** Statuts comptés dans le chiffre d'affaires. */
export const REVENUE_STATES: OrderStatus[] = ['CONFIRMED', 'PAID', 'PREPARING', 'SHIPPED', 'DELIVERED'];

export const TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  PENDING_CONFIRMATION: ['CONFIRMED', 'PAID', 'CANCELLED'],
  CONFIRMED: ['PAID', 'PREPARING', 'SHIPPED', 'CANCELLED'],
  PAID: ['PREPARING', 'SHIPPED', 'CANCELLED'],
  PREPARING: ['SHIPPED', 'CANCELLED'],
  SHIPPED: ['DELIVERED', 'RETURNED'],
  DELIVERED: ['RETURNED'],
  CANCELLED: [],
  RETURNED: [],
};

async function nextOrderNumber(tx: Tx, shopId: string): Promise<string> {
  await tx.insert(schema.shopCounters).values({ shopId, name: 'order', value: 1 })
    .onDuplicateKeyUpdate({ set: { value: sql`${schema.shopCounters.value} + 1` } });
  const [c] = await tx.select({ value: schema.shopCounters.value }).from(schema.shopCounters)
    .where(and(eq(schema.shopCounters.shopId, shopId), eq(schema.shopCounters.name, 'order')));
  const ym = new Date().toISOString().slice(2, 7).replace('-', '');
  return `C${ym}-${String(c.value).padStart(5, '0')}`;
}

/** Charge les variantes demandées (de CETTE boutique) avec leur produit. */
async function loadVariants(tx: Tx, shopId: string, ids: string[]) {
  const rows = await tx.select({
    variantId: schema.productVariants.id, label: schema.productVariants.label, variantPrice: schema.productVariants.priceMga,
    productId: schema.products.id, code: schema.products.code, name: schema.products.name, price: schema.products.priceMga,
  }).from(schema.productVariants)
    .innerJoin(schema.products, eq(schema.products.id, schema.productVariants.productId))
    .where(and(eq(schema.productVariants.shopId, shopId), inArray(schema.productVariants.id, ids)));
  const map = new Map(rows.map((r) => [r.variantId, r]));
  for (const id of ids) if (!map.has(id)) throw notFound(`Variante ${id}`);
  return map;
}

async function insertItems(tx: Tx, shopId: string, orderId: string, items: ItemInput[], actorUserId?: string) {
  const variants = await loadVariants(tx, shopId, [...new Set(items.map((i) => i.variantId))]);
  let subtotal = 0;
  for (const it of items) {
    if (it.quantity < 1) throw badRequest('INVALID_QUANTITY', 'Quantité invalide');
    const vr = variants.get(it.variantId)!;
    const unit = it.unitPriceMga ?? vr.variantPrice ?? vr.price;
    await reserve(tx, shopId, it.variantId, it.quantity, { refType: 'order', refId: orderId, actorUserId });
    await tx.insert(schema.orderItems).values({
      id: newId(), shopId, orderId, productId: vr.productId, variantId: it.variantId,
      nameSnapshot: vr.name, codeSnapshot: vr.code, variantSnapshot: vr.label, quantity: it.quantity, unitPriceMga: unit,
    });
    subtotal += unit * it.quantity;
  }
  return subtotal;
}

async function recomputeTotals(tx: Tx, shopId: string, orderId: string) {
  const [s] = await tx.select({ sub: sql<number>`COALESCE(SUM(${schema.orderItems.quantity} * ${schema.orderItems.unitPriceMga}), 0)` })
    .from(schema.orderItems).where(and(eq(schema.orderItems.shopId, shopId), eq(schema.orderItems.orderId, orderId)));
  await tx.update(o).set({
    subtotalMga: sql`${Number(s.sub)}`,
    totalMga: sql`GREATEST(${Number(s.sub)} + ${o.shippingMga} - ${o.discountMga}, 0)`,
  }).where(and(eq(o.id, orderId), eq(o.shopId, shopId)));
}

export interface CreateOrderInput {
  customerId: string;
  channel: (typeof schema.ORDER_CHANNELS)[number];
  items: ItemInput[];
  liveSessionId?: string;
  sourceCommentId?: string;
  shippingMga?: number;
  discountMga?: number;
  deliveryAddress?: string;
  deliveryCity?: string;
  notes?: string;
  status?: 'PENDING_CONFIRMATION' | 'CONFIRMED';
}

/** Crée une commande et réserve le stock, le tout dans une transaction. */
export async function createOrder(shopId: string, input: CreateOrderInput, actorUserId?: string, conn?: Tx) {
  const run = async (tx: Tx) => {
    const [cust] = await tx.select({ id: schema.customers.id, isBlocked: schema.customers.isBlocked, address: schema.customers.address, city: schema.customers.city })
      .from(schema.customers).where(and(eq(schema.customers.id, input.customerId), eq(schema.customers.shopId, shopId)));
    if (!cust) throw notFound('Client');
    if (cust.isBlocked) throw conflict('CUSTOMER_BLOCKED', 'Ce client est bloqué');
    if (!input.items.length) throw badRequest('EMPTY_ORDER', 'La commande ne contient aucun article');

    const id = newId();
    const [shop] = await tx.select({ ttl: schema.shops.reservationTtlMinutes }).from(schema.shops).where(eq(schema.shops.id, shopId));
    const status = input.status ?? 'PENDING_CONFIRMATION';
    await tx.insert(o).values({
      id, shopId, number: await nextOrderNumber(tx, shopId), customerId: input.customerId, channel: input.channel,
      liveSessionId: input.liveSessionId, sourceCommentId: input.sourceCommentId, status,
      subtotalMga: 0, shippingMga: input.shippingMga ?? 0, discountMga: input.discountMga ?? 0, totalMga: 0,
      deliveryAddress: input.deliveryAddress ?? cust.address, deliveryCity: input.deliveryCity ?? cust.city, notes: input.notes,
      expiresAt: status === 'PENDING_CONFIRMATION' ? new Date(Date.now() + (shop?.ttl ?? 1440) * 60_000) : null,
      confirmedAt: status === 'CONFIRMED' ? new Date() : null,
    });
    await insertItems(tx, shopId, id, input.items, actorUserId);
    await recomputeTotals(tx, shopId, id);
    await audit(tx, { shopId, actorUserId, action: 'order.created', entityType: 'order', entityId: id, data: { channel: input.channel, items: input.items } });
    return id;
  };
  const id = conn ? await run(conn) : await db.transaction(run);
  return getOrder(shopId, id, conn);
}

/** Ajoute des articles à une commande encore en attente (panier du live). */
export async function addItems(shopId: string, orderId: string, items: ItemInput[], actorUserId?: string, conn?: Tx) {
  const run = async (tx: Tx) => {
    const [ord] = await tx.select({ status: o.status }).from(o).where(and(eq(o.id, orderId), eq(o.shopId, shopId))).for('update');
    if (!ord) throw notFound('Commande');
    if (!['PENDING_CONFIRMATION', 'CONFIRMED'].includes(ord.status)) throw conflict('ORDER_LOCKED', 'Commande déjà payée ou expédiée');
    await insertItems(tx, shopId, orderId, items, actorUserId);
    await recomputeTotals(tx, shopId, orderId);
  };
  if (conn) await run(conn); else await db.transaction(run);
  return getOrder(shopId, orderId, conn);
}

/** Change le statut d'une commande et applique l'effet sur le stock. */
export async function transitionOrder(shopId: string, orderId: string, to: OrderStatus, actorUserId?: string, note?: string) {
  await db.transaction(async (tx) => {
    const [ord] = await tx.select().from(o).where(and(eq(o.id, orderId), eq(o.shopId, shopId))).for('update');
    if (!ord) throw notFound('Commande');
    if (ord.status === to) return;
    if (!TRANSITIONS[ord.status].includes(to)) throw conflict('INVALID_TRANSITION', `Passage ${ord.status} → ${to} impossible`);

    const items = await tx.select().from(schema.orderItems).where(and(eq(schema.orderItems.shopId, shopId), eq(schema.orderItems.orderId, orderId)));
    const ref = { refType: 'order', refId: orderId, actorUserId };
    const wasShipped = SHIPPED_STATES.includes(ord.status);

    if (to === 'CANCELLED') {
      for (const it of items) await release(tx, shopId, it.variantId, it.quantity, ref);
      await tx.update(schema.customers).set({ cancelCount: sql`${schema.customers.cancelCount} + 1` }).where(eq(schema.customers.id, ord.customerId));
    } else if (SHIPPED_STATES.includes(to) && !wasShipped) {
      for (const it of items) await commitSale(tx, shopId, it.variantId, it.quantity, ref);
    }
    if (to === 'RETURNED') {
      for (const it of items) await restockReturn(tx, shopId, it.variantId, it.quantity, ref);
    }

    await tx.update(o).set({
      status: to,
      confirmedAt: ord.confirmedAt ?? (to !== 'CANCELLED' ? new Date() : null),
      cancelledAt: to === 'CANCELLED' ? new Date() : ord.cancelledAt,
      expiresAt: to === 'PENDING_CONFIRMATION' ? ord.expiresAt : null,
    }).where(eq(o.id, orderId));
    await audit(tx, { shopId, actorUserId, action: 'order.status_changed', entityType: 'order', entityId: orderId, data: { from: ord.status, to, note } });
  });
  return getOrder(shopId, orderId);
}

export async function getOrder(shopId: string, orderId: string, conn?: Tx) {
  const [ord] = await ordersWithChildren(shopId, eq(o.id, orderId), conn ?? db);
  if (!ord) throw notFound('Commande');
  return ord;
}

/** Annule les commandes en attente dont la réservation a expiré (à lancer périodiquement). */
export async function expirePendingOrders(now = new Date()) {
  const expired = await db.select({ id: o.id, shopId: o.shopId }).from(o)
    .where(and(eq(o.status, 'PENDING_CONFIRMATION'), sql`${o.expiresAt} IS NOT NULL AND ${o.expiresAt} < ${now}`)).limit(200);
  for (const e of expired) await transitionOrder(e.shopId, e.id, 'CANCELLED', undefined, 'Réservation expirée');
  return expired.length;
}
