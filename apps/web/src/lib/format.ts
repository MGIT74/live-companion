const nf = new Intl.NumberFormat('fr-FR');
export const mga = (n: number | null | undefined) => `${nf.format(Math.round(n ?? 0))} Ar`;
export const num = (n: number | null | undefined) => nf.format(n ?? 0);
/** « 1 commande », « 3 commandes » (pluriel simple en -s sauf forme donnée). */
export const pl = (n: number | null | undefined, one: string, many = `${one}s`) => `${nf.format(n ?? 0)} ${Math.abs(n ?? 0) > 1 ? many : one}`;

export function date(d: string | Date | null | undefined, withTime = false) {
  if (!d) return '—';
  const x = new Date(d);
  return x.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}) });
}

export function ago(d: string | Date | null | undefined) {
  if (!d) return '—';
  const s = Math.round((Date.now() - new Date(d).getTime()) / 1000);
  if (s < 60) return 'à l’instant';
  if (s < 3600) return `il y a ${Math.floor(s / 60)} min`;
  if (s < 86400) return `il y a ${Math.floor(s / 3600)} h`;
  if (s < 7 * 86400) return `il y a ${Math.floor(s / 86400)} j`;
  return date(d);
}

export type Tone = 'green' | 'orange' | 'red' | 'blue' | 'gray';

export const ORDER_STATUS: Record<string, { label: string; tone: Tone }> = {
  PENDING_CONFIRMATION: { label: 'À confirmer', tone: 'orange' },
  CONFIRMED: { label: 'Confirmée', tone: 'blue' },
  PAID: { label: 'Payée', tone: 'green' },
  PREPARING: { label: 'En préparation', tone: 'blue' },
  SHIPPED: { label: 'En livraison', tone: 'blue' },
  DELIVERED: { label: 'Livrée', tone: 'green' },
  CANCELLED: { label: 'Annulée', tone: 'red' },
  RETURNED: { label: 'Retournée', tone: 'gray' },
};

/** Actions proposées pour faire avancer une commande (libellés courts, verbe d'action). */
export const ORDER_ACTIONS: Record<string, { to: string; label: string; primary?: boolean; danger?: boolean }[]> = {
  PENDING_CONFIRMATION: [{ to: 'CONFIRMED', label: 'Confirmer', primary: true }, { to: 'CANCELLED', label: 'Annuler', danger: true }],
  CONFIRMED: [{ to: 'PREPARING', label: 'Préparer', primary: true }, { to: 'SHIPPED', label: 'Expédier' }, { to: 'CANCELLED', label: 'Annuler', danger: true }],
  PAID: [{ to: 'PREPARING', label: 'Préparer', primary: true }, { to: 'SHIPPED', label: 'Expédier' }, { to: 'CANCELLED', label: 'Annuler', danger: true }],
  PREPARING: [{ to: 'SHIPPED', label: 'Expédier', primary: true }, { to: 'CANCELLED', label: 'Annuler', danger: true }],
  SHIPPED: [{ to: 'DELIVERED', label: 'Marquer livrée', primary: true }, { to: 'RETURNED', label: 'Retour' }],
  DELIVERED: [{ to: 'RETURNED', label: 'Retour' }],
  CANCELLED: [],
  RETURNED: [],
};

export const CHANNEL: Record<string, string> = { LIVE: 'Live', MESSENGER: 'Messenger', MARKETPLACE: 'Marketplace', MANUAL: 'Saisie' };

export const PAYMENT_METHOD: Record<string, string> = {
  MVOLA: 'MVola', ORANGE_MONEY: 'Orange Money', AIRTEL_MONEY: 'Airtel Money', CASH_ON_DELIVERY: 'À la livraison', CASH: 'Espèces', BANK: 'Virement',
};

export const PAYMENT_STATUS: Record<string, { label: string; tone: Tone }> = {
  PENDING: { label: 'À vérifier', tone: 'orange' }, CONFIRMED: { label: 'Reçu', tone: 'green' }, FAILED: { label: 'Échoué', tone: 'red' }, REFUNDED: { label: 'Remboursé', tone: 'gray' },
};

export const LIVE_STATUS: Record<string, { label: string; tone: Tone }> = {
  DRAFT: { label: 'En préparation', tone: 'gray' }, LIVE: { label: 'En direct', tone: 'red' }, ENDED: { label: 'Terminé', tone: 'gray' },
};

export const COMMENT_STATUS: Record<string, { label: string; tone: Tone }> = {
  ORDERED: { label: 'Commande', tone: 'green' }, NEEDS_REVIEW: { label: 'À valider', tone: 'orange' }, WAITLISTED: { label: 'Liste d’attente', tone: 'blue' },
  REJECTED: { label: 'Refusé', tone: 'red' }, NOT_AN_ORDER: { label: 'Commentaire', tone: 'gray' },
};

export const SHIP_METHOD: Record<string, string> = { COURIER: 'Livreur', PICKUP: 'Retrait', TAXI_BROUSSE: 'Taxi-brousse', POST: 'Poste', OTHER: 'Autre' };

export function initials(name?: string | null) {
  if (!name) return '?';
  return name.trim().split(/\s+/).slice(0, 2).map((p) => p[0]?.toUpperCase()).join('');
}
