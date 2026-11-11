/**
 * Chargements « parent + enfants » en requêtes simples (compatibles MySQL 8 et MariaDB,
 * sans jointure LATERAL) : une requête par table, regroupement en mémoire.
 */
import { and, asc, desc, eq, inArray, isNull, type SQL } from 'drizzle-orm';
import type { Tx } from '../db/client.ts';
import { db, schema } from '../db/client.ts';

type Conn = Tx | typeof db;

function group<T, K extends keyof T>(rows: T[], key: K) {
  const m = new Map<T[K], T[]>();
  for (const r of rows) { const k = r[key]; const arr = m.get(k); if (arr) arr.push(r); else m.set(k, [r]); }
  return m;
}

export async function productsWithChildren(shopId: string, where?: SQL, conn: Conn = db) {
  const p = schema.products;
  const prods = await conn.select().from(p).where(and(eq(p.shopId, shopId), where)).orderBy(asc(p.code));
  if (!prods.length) return [];
  const ids = prods.map((x) => x.id);
  const variants = await conn.select().from(schema.productVariants)
    .where(and(eq(schema.productVariants.shopId, shopId), inArray(schema.productVariants.productId, ids))).orderBy(asc(schema.productVariants.createdAt), asc(schema.productVariants.id));
  const images = await conn.select().from(schema.productImages)
    .where(and(eq(schema.productImages.shopId, shopId), inArray(schema.productImages.productId, ids))).orderBy(asc(schema.productImages.position));
  const vg = group(variants, 'productId');
  const ig = group(images, 'productId');
  return prods.map((x) => ({ ...x, variants: vg.get(x.id) ?? [], images: ig.get(x.id) ?? [] }));
}

export async function activeProducts(shopId: string) {
  return productsWithChildren(shopId, isNull(schema.products.archivedAt));
}

export async function ordersWithChildren(shopId: string, where: SQL | undefined, conn: Conn = db) {
  const o = schema.orders;
  const ords = await conn.select().from(o).where(and(eq(o.shopId, shopId), where)).orderBy(desc(o.createdAt), desc(o.id));
  if (!ords.length) return [];
  const ids = ords.map((x) => x.id);
  const [items, payments, shipments, customers] = await Promise.all([
    conn.select().from(schema.orderItems).where(and(eq(schema.orderItems.shopId, shopId), inArray(schema.orderItems.orderId, ids))).orderBy(asc(schema.orderItems.id)),
    conn.select().from(schema.payments).where(and(eq(schema.payments.shopId, shopId), inArray(schema.payments.orderId, ids))).orderBy(asc(schema.payments.id)),
    conn.select().from(schema.shipments).where(and(eq(schema.shipments.shopId, shopId), inArray(schema.shipments.orderId, ids))).orderBy(asc(schema.shipments.id)),
    conn.select().from(schema.customers).where(and(eq(schema.customers.shopId, shopId), inArray(schema.customers.id, [...new Set(ords.map((x) => x.customerId))]))),
  ]);
  const ig = group(items, 'orderId');
  const pg = group(payments, 'orderId');
  const sg = group(shipments, 'orderId');
  const cm = new Map(customers.map((c) => [c.id, c]));
  return ords.map((x) => ({ ...x, customer: cm.get(x.customerId)!, items: ig.get(x.id) ?? [], payments: pg.get(x.id) ?? [], shipments: sg.get(x.id) ?? [] }));
}
