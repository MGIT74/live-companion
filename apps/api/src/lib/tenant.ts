import { and, eq } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { db, schema } from '../db/client.ts';
import type { ShopRole } from '../db/schema.ts';
import { forbidden, notFound } from './errors.ts';

/** Capacités par rôle. OWNER a tout. */
const CAPS: Record<ShopRole, ReadonlySet<Capability>> = {
  OWNER: new Set<Capability>(['shop.manage', 'members.manage', 'catalog.write', 'catalog.read', 'stock.write', 'customers.write', 'customers.read', 'orders.write', 'orders.read', 'payments.write', 'lives.write', 'lives.read', 'stats.read']),
  MANAGER: new Set<Capability>(['catalog.write', 'catalog.read', 'stock.write', 'customers.write', 'customers.read', 'orders.write', 'orders.read', 'payments.write', 'lives.write', 'lives.read', 'stats.read']),
  LIVE_ASSISTANT: new Set<Capability>(['catalog.read', 'customers.write', 'customers.read', 'orders.write', 'orders.read', 'lives.write', 'lives.read']),
  SALES: new Set<Capability>(['catalog.read', 'customers.write', 'customers.read', 'orders.write', 'orders.read', 'payments.write', 'lives.read']),
};

export type Capability =
  | 'shop.manage' | 'members.manage' | 'catalog.write' | 'catalog.read' | 'stock.write'
  | 'customers.write' | 'customers.read' | 'orders.write' | 'orders.read' | 'payments.write'
  | 'lives.write' | 'lives.read' | 'stats.read';

declare module 'fastify' {
  interface FastifyRequest {
    shop: { id: string; role: ShopRole };
  }
}

/**
 * preHandler des routes /v1/shops/:shopId/... : vérifie que l'utilisateur
 * connecté est membre de la boutique et charge son rôle.
 * Toutes les requêtes métier filtrent ensuite par req.shop.id.
 */
export async function shopGuard(req: FastifyRequest, _reply: FastifyReply) {
  const { shopId } = req.params as { shopId?: string };
  if (!shopId) throw notFound('Boutique');
  const [m] = await db
    .select({ role: schema.shopMembers.role, status: schema.shops.status })
    .from(schema.shopMembers)
    .innerJoin(schema.shops, eq(schema.shops.id, schema.shopMembers.shopId))
    .where(and(eq(schema.shopMembers.shopId, shopId), eq(schema.shopMembers.userId, req.user.sub)))
    .limit(1);
  // 404 plutôt que 403 : on ne révèle pas l'existence d'une boutique à un non-membre.
  if (!m) throw notFound('Boutique');
  if (m.status !== 'ACTIVE') throw forbidden('Boutique suspendue');
  req.shop = { id: shopId, role: m.role };
}

export function can(req: FastifyRequest, cap: Capability) {
  if (!CAPS[req.shop.role].has(cap)) throw forbidden();
}
