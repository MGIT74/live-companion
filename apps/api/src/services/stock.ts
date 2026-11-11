import { and, eq, sql } from 'drizzle-orm';
import type { Tx } from '../db/client.ts';
import { schema } from '../db/client.ts';
import { conflict } from '../lib/errors.ts';
import { newId } from '../lib/ids.ts';

const v = schema.productVariants;

type Ref = { refType?: string; refId?: string; actorUserId?: string; note?: string };

async function move(tx: Tx, shopId: string, variantId: string, type: typeof schema.inventoryMovements.$inferInsert.type, quantity: number, ref: Ref) {
  await tx.insert(schema.inventoryMovements).values({ id: newId(), shopId, variantId, type, quantity, ...ref });
}

/**
 * Réserve du stock de façon atomique : l'UPDATE ne passe que si le disponible
 * (stock_on_hand - reserved) couvre la quantité. Deux acheteurs ne peuvent donc
 * jamais obtenir le même dernier article, même en simultané.
 */
export async function reserve(tx: Tx, shopId: string, variantId: string, qty: number, ref: Ref) {
  const [res] = await tx.update(v)
    .set({ reserved: sql`${v.reserved} + ${qty}` })
    .where(and(eq(v.id, variantId), eq(v.shopId, shopId), sql`${v.stockOnHand} - ${v.reserved} >= ${qty}`));
  if (res.affectedRows !== 1) {
    const [row] = await tx.select({ stock: v.stockOnHand, reserved: v.reserved, label: v.label }).from(v).where(and(eq(v.id, variantId), eq(v.shopId, shopId)));
    throw conflict('OUT_OF_STOCK', `Stock insuffisant${row ? ` (${row.label} : ${row.stock - row.reserved} disponible)` : ''}`, { variantId, available: row ? row.stock - row.reserved : 0, requested: qty });
  }
  await move(tx, shopId, variantId, 'RESERVE', -qty, ref);
}

/** Libère une réservation (commande annulée). */
export async function release(tx: Tx, shopId: string, variantId: string, qty: number, ref: Ref) {
  await tx.update(v).set({ reserved: sql`GREATEST(${v.reserved} - ${qty}, 0)` }).where(and(eq(v.id, variantId), eq(v.shopId, shopId)));
  await move(tx, shopId, variantId, 'RELEASE', qty, ref);
}

/** La marchandise part : la réservation devient une sortie de stock. */
export async function commitSale(tx: Tx, shopId: string, variantId: string, qty: number, ref: Ref) {
  await tx.update(v).set({ reserved: sql`${v.reserved} - ${qty}`, stockOnHand: sql`${v.stockOnHand} - ${qty}` }).where(and(eq(v.id, variantId), eq(v.shopId, shopId)));
  await move(tx, shopId, variantId, 'SALE', -qty, ref);
}

/** Retour client : la marchandise revient en stock. */
export async function restockReturn(tx: Tx, shopId: string, variantId: string, qty: number, ref: Ref) {
  await tx.update(v).set({ stockOnHand: sql`${v.stockOnHand} + ${qty}` }).where(and(eq(v.id, variantId), eq(v.shopId, shopId)));
  await move(tx, shopId, variantId, 'RETURN', qty, ref);
}

/** Ajustement manuel (réassort +, casse/perte -). Refusé s'il passerait sous les réservations. */
export async function adjust(tx: Tx, shopId: string, variantId: string, delta: number, ref: Ref) {
  const [res] = await tx.update(v)
    .set({ stockOnHand: sql`${v.stockOnHand} + ${delta}` })
    .where(and(eq(v.id, variantId), eq(v.shopId, shopId), sql`${v.stockOnHand} + ${delta} >= ${v.reserved}`));
  if (res.affectedRows !== 1) throw conflict('STOCK_BELOW_RESERVED', 'Le stock ne peut pas descendre sous les quantités réservées');
  await move(tx, shopId, variantId, delta >= 0 ? 'RESTOCK' : 'ADJUST', delta, ref);
}
