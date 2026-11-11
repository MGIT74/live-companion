import { parseOrder, stripMentions, type MessageTag, type ParseResult } from '@live-companion/order-parser';
import { and, eq, isNull } from 'drizzle-orm';
import { db, schema } from '../db/client.ts';
import { AppError, isDuplicate, notFound } from '../lib/errors.ts';
import { newId } from '../lib/ids.ts';
import { findOrCreateCustomer } from './customers.ts';
import { addItems, createOrder } from './orders.ts';
import { activeProducts } from './loaders.ts';

const lc = schema.liveComments;

export interface CommentInput {
  fbCommentId?: string;
  parentId?: string;
  authorId?: string;
  authorName?: string;
  message: string;
  createdTime?: Date;
  source?: 'SSE' | 'POLL' | 'WEBHOOK' | 'MANUAL';
  /** Commentaire écrit par la Page elle-même : jamais une commande. */
  fromPage?: boolean;
  /** message_tags de l'API Meta : mentions ajoutées par « Répondre » (« Hands Graphic +1 »). */
  messageTags?: MessageTag[];
  /** Noms à retirer en tête de message si les message_tags manquent (nom de la Page…). */
  mentionNames?: string[];
}

type Outcome =
  | { status: 'NOT_AN_ORDER' }
  | { status: 'ORDERED'; orderId: string; merged: boolean }
  | { status: 'NEEDS_REVIEW' | 'WAITLISTED'; reason: string };

/** Catalogue actif de la boutique, pour le parseur et la résolution des codes. */
async function catalog(shopId: string) {
  const rows = await activeProducts(shopId);
  return {
    byCode: new Map(rows.map((p) => [p.code, p])),
    options: { knownCodes: rows.map((p) => p.code), variants: Object.fromEntries(rows.map((p) => [p.code, p.variants.map((v) => v.label)])) },
  };
}

/** Résout un résultat de parsing en (variante, quantité) ou en motif de validation manuelle. */
async function resolveTarget(shopId: string, liveId: string, parsed: ParseResult, parentId: string | undefined, cat: Awaited<ReturnType<typeof catalog>>) {
  let code: string | undefined;
  let variantLabel: string | undefined;
  let quantity = 1;
  if (parsed.type === 'order') { code = parsed.code; variantLabel = parsed.variant; quantity = parsed.quantity; }
  else if (parsed.type === 'plus') {
    // Règle : un « +1 » n'est rattaché à un produit que via un commentaire produit connu de CE live.
    const [item] = parentId
      ? await db.select({ code: schema.products.code }).from(schema.liveSessionItems)
        .innerJoin(schema.products, eq(schema.products.id, schema.liveSessionItems.productId))
        .where(and(eq(schema.liveSessionItems.shopId, shopId), eq(schema.liveSessionItems.liveSessionId, liveId), eq(schema.liveSessionItems.fbCommentId, parentId))).limit(1)
      : [];
    if (!item) return { reason: parentId ? 'réponse à un commentaire qui n’est pas un produit' : '« +1 » sans commentaire parent : produit non deviné' };
    code = item.code; variantLabel = parsed.variant; quantity = parsed.quantity;
  } else if (parsed.type === 'ambiguous') {
    return { reason: `ambigu : ${parsed.reason}`, code: parsed.code };
  }
  const product = code ? cat.byCode.get(code) : undefined;
  if (!product) return { reason: `produit ${code ?? '?'} inconnu`, code };
  const variant = variantLabel
    ? product.variants.find((v) => v.label.toLowerCase() === variantLabel!.toLowerCase())
    : product.variants.length === 1 ? product.variants[0] : undefined;
  if (!variant) return { reason: variantLabel ? `variante ${variantLabel} inconnue` : 'variante (taille, couleur) non précisée', code };
  return { variantId: variant.id, quantity, code };
}

/**
 * Transforme une demande en commande : un seul panier ouvert par client et par live
 * (les +1 successifs s'ajoutent à la même commande).
 */
async function placeLiveOrder(shopId: string, liveId: string, customerId: string, variantId: string, quantity: number, sourceCommentId: string | undefined, actorUserId?: string) {
  return db.transaction(async (tx) => {
    const [open] = await tx.select({ id: schema.orders.id }).from(schema.orders)
      .where(and(eq(schema.orders.shopId, shopId), eq(schema.orders.liveSessionId, liveId), eq(schema.orders.customerId, customerId), eq(schema.orders.status, 'PENDING_CONFIRMATION')))
      .limit(1).for('update');
    if (open) {
      await addItems(shopId, open.id, [{ variantId, quantity }], actorUserId, tx);
      return { orderId: open.id, merged: true };
    }
    const ord = await createOrder(shopId, { customerId, channel: 'LIVE', liveSessionId: liveId, sourceCommentId, items: [{ variantId, quantity }] }, actorUserId, tx);
    return { orderId: ord.id, merged: false };
  });
}

/** Point d'entrée unique des commentaires de live (API Meta ou saisie). Idempotent par fbCommentId. */
export async function ingestLiveComment(shopId: string, liveId: string, input: CommentInput, actorUserId?: string) {
  const [live] = await db.select({ id: schema.liveSessions.id }).from(schema.liveSessions).where(and(eq(schema.liveSessions.id, liveId), eq(schema.liveSessions.shopId, shopId)));
  if (!live) throw notFound('Live');
  const id = newId();
  const fbCommentId = input.fbCommentId ?? `manual:${id}`;
  try {
    await db.insert(lc).values({
      id, shopId, liveSessionId: liveId, fbCommentId, fbParentId: input.parentId, fbAuthorId: input.authorId, authorName: input.authorName,
      message: input.message, createdTime: input.createdTime, source: input.source ?? 'MANUAL',
    });
  } catch (e) {
    if (isDuplicate(e)) {
      const [existing] = await db.select().from(lc).where(and(eq(lc.shopId, shopId), eq(lc.fbCommentId, fbCommentId)));
      return { comment: existing, outcome: { status: existing.parseStatus } as Outcome, duplicate: true };
    }
    throw e;
  }

  let outcome: Outcome = { status: 'NOT_AN_ORDER' };
  const cat = await catalog(shopId);
  // Nom de la boutique et auteur du commentaire parent : mentions probables en tête de réponse.
  const [shop] = await db.select({ name: schema.shops.name }).from(schema.shops).where(eq(schema.shops.id, shopId));
  const [parent] = input.parentId ? await db.select({ author: lc.authorName }).from(lc).where(and(eq(lc.shopId, shopId), eq(lc.fbCommentId, input.parentId))) : [];
  const text = stripMentions(input.message, input.messageTags, [...(input.mentionNames ?? []), shop?.name ?? '', parent?.author ?? '']);
  const parsed = parseOrder(text, cat.options);
  if (!input.fromPage && parsed.type !== 'none') {
    const target = await resolveTarget(shopId, liveId, parsed, input.parentId, cat);
    if ('reason' in target && target.reason) {
      outcome = { status: 'NEEDS_REVIEW', reason: target.reason };
    } else if ('variantId' in target && target.variantId) {
      const customer = await findOrCreateCustomer(shopId, { fullName: input.authorName, fbUserId: input.authorId });
      try {
        const r = await placeLiveOrder(shopId, liveId, customer.id, target.variantId, target.quantity, fbCommentId, actorUserId);
        outcome = { status: 'ORDERED', ...r };
      } catch (e) {
        if (e instanceof AppError && e.code === 'OUT_OF_STOCK') outcome = { status: 'WAITLISTED', reason: e.message };
        else if (e instanceof AppError && e.code === 'CUSTOMER_BLOCKED') outcome = { status: 'NEEDS_REVIEW', reason: 'client bloqué' };
        else throw e;
      }
    }
  }
  await db.update(lc).set({
    parseStatus: outcome.status, parsed, reason: 'reason' in outcome ? outcome.reason.slice(0, 160) : null,
    orderId: outcome.status === 'ORDERED' ? outcome.orderId : null,
  }).where(eq(lc.id, id));
  const [comment] = await db.select().from(lc).where(eq(lc.id, id));
  return { comment, outcome, duplicate: false };
}

/** Validation manuelle d'un commentaire en attente (ou d'une liste d'attente). */
export async function resolveComment(
  shopId: string, liveId: string, commentId: string,
  r: { action: 'accept' | 'reject'; variantId?: string; quantity?: number; customer?: { fullName?: string; phone?: string } },
  actorUserId?: string,
) {
  const [cm] = await db.select().from(lc).where(and(eq(lc.id, commentId), eq(lc.shopId, shopId), eq(lc.liveSessionId, liveId)));
  if (!cm) throw notFound('Commentaire');
  if (r.action === 'reject') {
    await db.update(lc).set({ parseStatus: 'REJECTED' }).where(eq(lc.id, commentId));
    return { status: 'REJECTED' as const };
  }
  if (!r.variantId) throw new AppError(400, 'VARIANT_REQUIRED', 'Choisissez le produit et la variante');
  const customer = await findOrCreateCustomer(shopId, { fullName: r.customer?.fullName ?? cm.authorName ?? undefined, phone: r.customer?.phone, fbUserId: cm.fbAuthorId ?? undefined });
  const res = await placeLiveOrder(shopId, liveId, customer.id, r.variantId, r.quantity ?? 1, cm.fbCommentId, actorUserId);
  await db.update(lc).set({ parseStatus: 'ORDERED', orderId: res.orderId, reason: null }).where(eq(lc.id, commentId));
  return { status: 'ORDERED' as const, ...res };
}
