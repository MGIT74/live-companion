import { parseOrder, type ParseResult } from '@live-companion/order-parser';
import { emit, log } from './bus.ts';
import { newId, persist, state, type Intent, type LiveComment } from './store.ts';

export function parseOptions() {
  return {
    knownCodes: state.products.map((p) => p.code),
    variants: Object.fromEntries(state.products.map((p) => [p.code, p.variants.map((v) => v.label)])),
  };
}

export function findProduct(code: string) {
  return state.products.find((p) => p.code === code);
}

/**
 * Réservation de stock. La PoC tourne dans un seul processus Node : l'opération
 * est atomique (pas d'await entre la lecture et l'écriture). La version produit
 * utilisera un UPDATE conditionnel MySQL dans une transaction.
 */
function tryReserve(code: string, variantLabel: string | undefined, qty: number):
  | { ok: true; variant: string }
  | { ok: false; reason: string; waitlist?: boolean } {
  const product = findProduct(code);
  if (!product) return { ok: false, reason: 'produit inconnu' };
  let variant = variantLabel ? product.variants.find((v) => v.label.toUpperCase() === variantLabel.toUpperCase()) : undefined;
  if (!variant && !variantLabel && product.variants.length === 1) variant = product.variants[0];
  if (!variant) return { ok: false, reason: variantLabel ? `variante ${variantLabel} inconnue` : 'variante non précisée' };
  if (variant.stock - variant.reserved < qty) return { ok: false, reason: 'stock épuisé', waitlist: true };
  variant.reserved += qty;
  return { ok: true, variant: variant.label };
}

export function releaseIntent(intent: Intent) {
  if (intent.status !== 'RESERVED' && intent.status !== 'CONFIRMED') return;
  const v = findProduct(intent.code!)?.variants.find((x) => x.label === intent.variant);
  if (v) v.reserved = Math.max(0, v.reserved - intent.quantity);
}

function stockSnapshot() {
  return state.products.map((p) => ({
    code: p.code,
    variants: p.variants.map((v) => ({ label: v.label, available: v.stock - v.reserved, reserved: v.reserved })),
  }));
}

/** Transforme un résultat de parsing en intention + réservation éventuelle. */
export function handleParsed(comment: LiveComment | undefined, liveVideoId: string, rawText: string, parsed: ParseResult, matchMethod: Intent['matchMethod'] = 'CODE'): Intent | undefined {
  if (parsed.type === 'none') return undefined;

  const base: Intent = {
    id: newId('int'),
    commentId: comment?.id,
    liveVideoId,
    quantity: 'quantity' in parsed && parsed.quantity ? parsed.quantity : 1,
    status: 'NEEDS_REVIEW',
    matchMethod,
    rawText,
    authorName: comment?.fromName,
    createdAt: new Date().toISOString(),
  };

  let code: string | undefined;
  let variant: string | undefined;

  if (parsed.type === 'order') {
    code = parsed.code;
    variant = parsed.variant;
  } else if (parsed.type === 'plus') {
    // Règle : on n'associe un "+1" que si le commentaire parent est un commentaire produit connu.
    const parent = comment?.parentId ? state.productComments.find((pc) => pc.commentId === comment.parentId) : undefined;
    if (!parent) {
      base.reason = comment?.parentId ? 'parent inconnu (pas un commentaire produit)' : 'aucun commentaire parent : produit non deviné';
      return commit(base, comment);
    }
    code = parent.code;
    variant = parsed.variant;
    base.matchMethod = 'PARENT';
  } else {
    base.code = parsed.code;
    base.reason = `ambigu : ${parsed.reason}`;
    return commit(base, comment);
  }

  base.code = code;
  const r = tryReserve(code!, variant, base.quantity);
  if (r.ok) {
    base.status = 'RESERVED';
    base.variant = r.variant;
  } else {
    base.variant = variant;
    base.status = r.waitlist ? 'WAITLISTED' : 'NEEDS_REVIEW';
    base.reason = r.reason;
  }
  return commit(base, comment);
}

function commit(intent: Intent, comment?: LiveComment): Intent {
  state.intents.push(intent);
  if (comment) comment.intentId = intent.id;
  persist();
  emit('intent', intent);
  emit('stock', stockSnapshot());
  log('info', `Intention ${intent.status} ${intent.code ?? '?'} x${intent.quantity}${intent.variant ? ' ' + intent.variant : ''} — « ${intent.rawText} »${intent.reason ? ' (' + intent.reason + ')' : ''}`);
  return intent;
}

/** Validation manuelle par l'assistant d'une intention ambiguë. */
export function resolveIntent(id: string, action: 'accept' | 'reject', patch: { code?: string; variant?: string; quantity?: number }) {
  const intent = state.intents.find((i) => i.id === id);
  if (!intent) throw new Error('Intention introuvable');
  if (action === 'reject') {
    releaseIntent(intent);
    intent.status = 'REJECTED';
  } else {
    if (intent.status === 'RESERVED') return intent;
    const code = patch.code ?? intent.code;
    const qty = patch.quantity ?? intent.quantity;
    if (!code) throw new Error('Code produit requis');
    const r = tryReserve(code, patch.variant ?? intent.variant, qty);
    intent.code = code;
    intent.quantity = qty;
    if (r.ok) { intent.status = 'RESERVED'; intent.variant = r.variant; intent.reason = undefined; }
    else { intent.reason = r.reason; intent.status = r.waitlist ? 'WAITLISTED' : 'NEEDS_REVIEW'; }
  }
  persist();
  emit('intent', intent);
  emit('stock', stockSnapshot());
  return intent;
}

export { stockSnapshot };
