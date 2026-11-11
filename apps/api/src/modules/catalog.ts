import { and, asc, desc, eq, inArray, isNull, like, or, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { db, schema } from '../db/client.ts';
import { audit } from '../lib/audit.ts';
import { authenticate } from '../lib/auth.ts';
import { conflict, isDuplicate, notFound } from '../lib/errors.ts';
import { newId } from '../lib/ids.ts';
import { can, shopGuard } from '../lib/tenant.ts';
import { adjust } from '../services/stock.ts';
import { productsWithChildren } from '../services/loaders.ts';

const p = schema.products;
const v = schema.productVariants;

const code = z.string().trim().toUpperCase().regex(/^[A-Z]{1,4}-?\d{2,4}$/, 'Code au format JP01, RB02, SAC10…').transform((s) => s.replace('-', ''));
const variantIn = z.object({ label: z.string().trim().min(1).max(60), priceMga: z.number().int().min(0).nullable().optional(), stock: z.number().int().min(0).default(0) });

/** Produits avec variantes, disponible (stock - réservé) et quantités vendues. */
export async function loadProducts(shopId: string, ids?: string[]) {
  const rows = await productsWithChildren(shopId, ids ? inArray(p.id, ids) : undefined);
  const sold = await db.select({ productId: schema.orderItems.productId, qty: sql<number>`SUM(${schema.orderItems.quantity})` })
    .from(schema.orderItems).innerJoin(schema.orders, eq(schema.orders.id, schema.orderItems.orderId))
    .where(and(eq(schema.orderItems.shopId, shopId), inArray(schema.orders.status, ['SHIPPED', 'DELIVERED'])))
    .groupBy(schema.orderItems.productId);
  const soldMap = new Map(sold.map((s) => [s.productId, Number(s.qty)]));
  return rows.map((r) => ({
    ...r,
    variants: r.variants.map((x) => ({ ...x, available: x.stockOnHand - x.reserved })),
    totalAvailable: r.variants.reduce((a, x) => a + x.stockOnHand - x.reserved, 0),
    soldQuantity: soldMap.get(r.id) ?? 0,
  }));
}

export async function catalogRoutes(app: FastifyInstance) {
  app.register(async (s) => {
    s.addHook('preHandler', authenticate);
    s.addHook('preHandler', shopGuard);
    const t = s.withTypeProvider<ZodTypeProvider>();

    t.get('/v1/shops/:shopId/products', {
      schema: { querystring: z.object({ q: z.string().max(80).optional(), archived: z.enum(['true', 'false']).default('false') }) },
    }, async (req) => {
      can(req, 'catalog.read');
      const q = req.query.q?.trim();
      const ids = await db.select({ id: p.id }).from(p).where(and(
        eq(p.shopId, req.shop.id),
        req.query.archived === 'true' ? undefined : isNull(p.archivedAt),
        q ? or(like(p.code, `%${q}%`), like(p.name, `%${q}%`)) : undefined,
      ));
      return ids.length ? loadProducts(req.shop.id, ids.map((x) => x.id)) : [];
    });

    t.get('/v1/shops/:shopId/products/:productId', async (req) => {
      can(req, 'catalog.read');
      const [prod] = await loadProducts(req.shop.id, [(req.params as { productId: string }).productId]);
      if (!prod) throw notFound('Produit');
      return prod;
    });

    t.post('/v1/shops/:shopId/products', {
      schema: { body: z.object({
        code, name: z.string().trim().min(1).max(160), description: z.string().max(5000).optional(), priceMga: z.number().int().min(0),
        variants: z.array(variantIn).min(1).max(50).default([{ label: 'Unique', stock: 0 }]),
        images: z.array(z.string().url().max(500)).max(10).default([]),
      }) },
    }, async (req, reply) => {
      can(req, 'catalog.write');
      const b = req.body;
      const id = newId();
      try {
        await db.transaction(async (tx) => {
          await tx.insert(p).values({ id, shopId: req.shop.id, code: b.code, name: b.name, description: b.description, priceMga: b.priceMga });
          for (const vr of b.variants) {
            const vid = newId();
            await tx.insert(v).values({ id: vid, shopId: req.shop.id, productId: id, label: vr.label, priceMga: vr.priceMga ?? null, stockOnHand: 0 });
            if (vr.stock > 0) await adjust(tx, req.shop.id, vid, vr.stock, { refType: 'product', refId: id, actorUserId: req.user.sub, note: 'Stock initial' });
          }
          for (const [i, url] of b.images.entries()) await tx.insert(schema.productImages).values({ id: newId(), shopId: req.shop.id, productId: id, url, position: i });
          await audit(tx, { shopId: req.shop.id, actorUserId: req.user.sub, action: 'product.created', entityType: 'product', entityId: id, data: { code: b.code } });
        });
      } catch (e) {
        if (isDuplicate(e)) throw conflict('CODE_TAKEN', `Le code ${b.code} est déjà utilisé (ou deux variantes ont le même nom)`);
        throw e;
      }
      reply.status(201);
      return (await loadProducts(req.shop.id, [id]))[0];
    });

    t.patch('/v1/shops/:shopId/products/:productId', {
      schema: { body: z.object({ code: code.optional(), name: z.string().trim().min(1).max(160).optional(), description: z.string().max(5000).nullable().optional(), priceMga: z.number().int().min(0).optional(), isPublished: z.boolean().optional(), archived: z.boolean().optional() }) },
    }, async (req) => {
      can(req, 'catalog.write');
      const { productId } = req.params as { productId: string };
      const { archived, ...rest } = req.body;
      try {
        const [res] = await db.update(p).set({ ...rest, ...(archived === undefined ? {} : { archivedAt: archived ? new Date() : null }) })
          .where(and(eq(p.id, productId), eq(p.shopId, req.shop.id)));
        if (res.affectedRows === 0) throw notFound('Produit');
      } catch (e) {
        if (isDuplicate(e)) throw conflict('CODE_TAKEN', 'Ce code est déjà utilisé');
        throw e;
      }
      return (await loadProducts(req.shop.id, [productId]))[0];
    });

    t.post('/v1/shops/:shopId/products/:productId/variants', { schema: { body: variantIn } }, async (req, reply) => {
      can(req, 'catalog.write');
      const { productId } = req.params as { productId: string };
      const [prod] = await db.select({ id: p.id }).from(p).where(and(eq(p.id, productId), eq(p.shopId, req.shop.id)));
      if (!prod) throw notFound('Produit');
      const vid = newId();
      try {
        await db.transaction(async (tx) => {
          await tx.insert(v).values({ id: vid, shopId: req.shop.id, productId, label: req.body.label, priceMga: req.body.priceMga ?? null });
          if (req.body.stock > 0) await adjust(tx, req.shop.id, vid, req.body.stock, { refType: 'product', refId: productId, actorUserId: req.user.sub, note: 'Stock initial' });
        });
      } catch (e) {
        if (isDuplicate(e)) throw conflict('VARIANT_EXISTS', 'Cette variante existe déjà');
        throw e;
      }
      reply.status(201);
      return (await loadProducts(req.shop.id, [productId]))[0];
    });

    t.patch('/v1/shops/:shopId/variants/:variantId', { schema: { body: z.object({ label: z.string().trim().min(1).max(60).optional(), priceMga: z.number().int().min(0).nullable().optional() }) } }, async (req) => {
      can(req, 'catalog.write');
      const { variantId } = req.params as { variantId: string };
      const [res] = await db.update(v).set(req.body).where(and(eq(v.id, variantId), eq(v.shopId, req.shop.id)));
      if (res.affectedRows === 0) throw notFound('Variante');
      return { ok: true };
    });

    /** Réassort (+) ou correction (−) du stock, tracé dans les mouvements. */
    t.post('/v1/shops/:shopId/variants/:variantId/stock', {
      schema: { body: z.object({ delta: z.number().int().refine((n) => n !== 0, 'delta ≠ 0'), note: z.string().max(255).optional() }) },
    }, async (req) => {
      can(req, 'stock.write');
      const { variantId } = req.params as { variantId: string };
      await db.transaction((tx) => adjust(tx, req.shop.id, variantId, req.body.delta, { refType: 'manual', actorUserId: req.user.sub, note: req.body.note }));
      const [row] = await db.select().from(v).where(and(eq(v.id, variantId), eq(v.shopId, req.shop.id)));
      if (!row) throw notFound('Variante');
      return { ...row, available: row.stockOnHand - row.reserved };
    });

    t.get('/v1/shops/:shopId/inventory/movements', {
      schema: { querystring: z.object({ variantId: z.string().length(26).optional(), limit: z.coerce.number().int().min(1).max(500).default(100) }) },
    }, async (req) => {
      can(req, 'catalog.read');
      const m = schema.inventoryMovements;
      return db.select({ id: m.id, type: m.type, quantity: m.quantity, refType: m.refType, refId: m.refId, note: m.note, createdAt: m.createdAt, variantId: m.variantId, label: v.label, code: p.code, name: p.name })
        .from(m).innerJoin(v, eq(v.id, m.variantId)).innerJoin(p, eq(p.id, v.productId))
        .where(and(eq(m.shopId, req.shop.id), req.query.variantId ? eq(m.variantId, req.query.variantId) : undefined))
        .orderBy(desc(m.id)).limit(req.query.limit);
    });
  });
}
