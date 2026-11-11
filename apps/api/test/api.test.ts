import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { pool } from '../src/db/client.ts';

let app: FastifyInstance;

type Session = { token: string; shopId: string };

async function call(s: Session | null, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: unknown) {
  const res = await app.inject({ method, url, payload: payload as object, headers: s ? { authorization: `Bearer ${s.token}` } : {} });
  return { status: res.statusCode, body: res.body ? res.json() : undefined };
}
const shop = (s: Session, path: string) => `/v1/shops/${s.shopId}${path}`;

async function register(email: string, shopName: string): Promise<Session> {
  const r = await call(null, 'POST', '/v1/auth/register', { email, password: 'motdepasse123', fullName: 'Vendeur Test', shopName });
  expect(r.status).toBe(201);
  return { token: r.body.token, shopId: r.body.user.shops[0].id };
}

async function product(s: Session, code: string, variants: { label: string; stock: number }[], priceMga = 35000) {
  const r = await call(s, 'POST', shop(s, '/products'), { code, name: `Produit ${code}`, priceMga, variants });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body as { id: string; variants: { id: string; label: string; available: number }[] };
}

async function variant(s: Session, productId: string, label: string) {
  const r = await call(s, 'GET', shop(s, `/products/${productId}`));
  return r.body.variants.find((v: { label: string }) => v.label === label) as { id: string; stockOnHand: number; reserved: number; available: number };
}

let A: Session;
let B: Session;

beforeAll(async () => {
  app = await buildApp({ logger: !!process.env.LOG });
  A = await register('vendeur.a@test.mg', 'Boutique A');
  B = await register('vendeur.b@test.mg', 'Boutique B');
});
afterAll(async () => { await app.close(); await pool.end(); });

describe('Authentification et boutiques', () => {
  it('refuse un e-mail déjà utilisé et un mauvais mot de passe', async () => {
    expect((await call(null, 'POST', '/v1/auth/register', { email: 'vendeur.a@test.mg', password: 'xxxxxxxx', fullName: 'Xavier', shopName: 'Yoyo' })).status).toBe(409);
    expect((await call(null, 'POST', '/v1/auth/login', { email: 'vendeur.a@test.mg', password: 'mauvais' })).status).toBe(401);
    expect((await call(null, 'POST', '/v1/auth/login', { email: 'vendeur.a@test.mg', password: 'motdepasse123' })).status).toBe(200);
  });

  it('exige une connexion', async () => {
    expect((await call(null, 'GET', shop(A, '/products'))).status).toBe(401);
  });

  it('isole strictement les boutiques entre vendeurs', async () => {
    const pa = await product(A, 'ISO01', [{ label: 'Unique', stock: 5 }]);
    // B ne voit ni la boutique de A, ni ses produits, même avec les bons identifiants.
    expect((await call(B, 'GET', `/v1/shops/${A.shopId}/products`)).status).toBe(404);
    expect((await call(B, 'GET', `/v1/shops/${A.shopId}/products/${pa.id}`)).status).toBe(404);
    expect((await call(B, 'GET', shop(B, `/products/${pa.id}`))).status).toBe(404);
    // B ne peut pas commander une variante de A depuis sa propre boutique.
    const r = await call(B, 'POST', shop(B, '/orders'), { customer: { fullName: 'Client B' }, items: [{ variantId: pa.variants[0].id, quantity: 1 }] });
    expect(r.status).toBe(404);
  });

  it('applique les rôles : un vendeur SALES ne peut pas modifier le catalogue', async () => {
    const m = await call(A, 'POST', shop(A, '/members'), { email: 'sales@test.mg', fullName: 'Commercial', role: 'SALES' });
    expect(m.status).toBe(201);
    expect(m.body.tempPassword).toBeTruthy();
    const login = await call(null, 'POST', '/v1/auth/login', { email: 'sales@test.mg', password: m.body.tempPassword });
    const S: Session = { token: login.body.token, shopId: A.shopId };
    expect((await call(S, 'GET', shop(S, '/products'))).status).toBe(200);
    expect((await call(S, 'POST', shop(S, '/products'), { code: 'NO01', name: 'Interdit', priceMga: 1000 })).status).toBe(403);
    expect((await call(S, 'GET', shop(S, '/stats/overview'))).status).toBe(403);
  });
});

describe('Catalogue et stock', () => {
  it('refuse un code produit en double et trace les mouvements', async () => {
    const p = await product(A, 'CAT01', [{ label: 'S', stock: 2 }, { label: 'M', stock: 3 }]);
    expect((await call(A, 'POST', shop(A, '/products'), { code: 'CAT01', name: 'Doublon', priceMga: 1 })).status).toBe(409);
    const m = p.variants.find((v) => v.label === 'M')!;
    const adj = await call(A, 'POST', shop(A, `/variants/${m.id}/stock`), { delta: 4, note: 'Réassort' });
    expect(adj.body.stockOnHand).toBe(7);
    expect((await call(A, 'POST', shop(A, `/variants/${m.id}/stock`), { delta: -10 })).status).toBe(409);
    const mv = await call(A, 'GET', shop(A, `/inventory/movements?variantId=${m.id}`));
    expect(mv.body.map((x: { type: string }) => x.type)).toEqual(['RESTOCK', 'RESTOCK']);
  });
});

describe('Commandes : réservation, annulation, expédition, retour', () => {
  it('réserve, libère, sort et réintègre le stock selon le statut', async () => {
    const p = await product(A, 'ORD01', [{ label: 'Unique', stock: 5 }], 20000);
    const vid = p.variants[0].id;
    const create = await call(A, 'POST', shop(A, '/orders'), { customer: { fullName: 'Rova', phone: '+261 34 12 345 67', city: 'Tana' }, items: [{ variantId: vid, quantity: 2 }], shippingMga: 3000 });
    expect(create.status).toBe(201);
    expect(create.body.totalMga).toBe(43000);
    expect(create.body.customer.phone).toBe('0341234567');
    let v = await variant(A, p.id, 'Unique');
    expect([v.stockOnHand, v.reserved]).toEqual([5, 2]);

    // Annulation : stock rendu.
    await call(A, 'POST', shop(A, `/orders/${create.body.id}/status`), { status: 'CANCELLED' });
    v = await variant(A, p.id, 'Unique');
    expect([v.stockOnHand, v.reserved]).toEqual([5, 0]);
    expect((await call(A, 'POST', shop(A, `/orders/${create.body.id}/status`), { status: 'CONFIRMED' })).status).toBe(409);

    // Nouveau parcours complet : même client retrouvé par son téléphone.
    const o2 = await call(A, 'POST', shop(A, '/orders'), { customer: { phone: '034 12 345 67' }, items: [{ variantId: vid, quantity: 1 }] });
    expect(o2.body.customerId).toBe(create.body.customerId);
    await call(A, 'POST', shop(A, `/orders/${o2.body.id}/status`), { status: 'CONFIRMED' });
    const pay = await call(A, 'POST', shop(A, `/orders/${o2.body.id}/payments`), { method: 'MVOLA', amountMga: 20000, providerRef: 'MV123', confirmed: true });
    expect(pay.body.status).toBe('PAID');
    expect(pay.body.paidMga).toBe(20000);
    const ship = await call(A, 'POST', shop(A, `/orders/${o2.body.id}/shipments`), { method: 'COURIER', carrierName: 'Livreur Tana', feeMga: 3000 });
    await call(A, 'PATCH', shop(A, `/shipments/${ship.body.shipments[0].id}`), { status: 'DELIVERED' });
    v = await variant(A, p.id, 'Unique');
    expect([v.stockOnHand, v.reserved]).toEqual([4, 0]);
    expect((await call(A, 'GET', shop(A, `/orders/${o2.body.id}`))).body.status).toBe('DELIVERED');

    // Retour : marchandise réintégrée.
    await call(A, 'POST', shop(A, `/orders/${o2.body.id}/status`), { status: 'RETURNED' });
    v = await variant(A, p.id, 'Unique');
    expect([v.stockOnHand, v.reserved]).toEqual([5, 0]);
  });

  it('ne vend jamais deux fois le dernier article, même avec 20 demandes simultanées', async () => {
    const p = await product(A, 'LST01', [{ label: 'Unique', stock: 1 }]);
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) =>
      call(A, 'POST', shop(A, '/orders'), { customer: { fullName: `Acheteur ${i}` }, items: [{ variantId: p.variants[0].id, quantity: 1 }] })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409 && r.body.error === 'OUT_OF_STOCK')).toHaveLength(19);
    const v = await variant(A, p.id, 'Unique');
    expect([v.stockOnHand, v.reserved]).toEqual([1, 1]);
  });
});

describe('Live : commentaires → commandes', () => {
  let live: { id: string; items: { id: string; productId: string }[] };
  let jean: Awaited<ReturnType<typeof product>>;

  beforeAll(async () => {
    jean = await product(B, 'JP01', [{ label: 'S', stock: 3 }, { label: 'M', stock: 5 }, { label: 'L', stock: 1 }]);
    const sac = await product(B, 'SAC10', [{ label: 'Unique', stock: 1 }], 25000);
    const r = await call(B, 'POST', shop(B, '/lives'), { title: 'Live du soir', productIds: [jean.id, sac.id] });
    expect(r.status).toBe(201);
    live = r.body;
    await call(B, 'POST', shop(B, `/lives/${live.id}/start`));
    await call(B, 'PATCH', shop(B, `/lives/${live.id}/items/${live.items[0].id}`), { fbCommentId: 'post_100', publishState: 'PUBLISHED_API', pinned: true });
  });

  const comment = (body: object) => call(B, 'POST', shop(B, `/lives/${live.id}/comments`), body);

  it('crée la commande, regroupe le panier du même client, ignore les doublons', async () => {
    const c1 = await comment({ fbCommentId: 'c1', authorId: 'fb_rova', authorName: 'Rova', message: 'JP01 +1 M', source: 'POLL' });
    expect(c1.body.outcome.status).toBe('ORDERED');
    const c2 = await comment({ fbCommentId: 'c2', authorId: 'fb_rova', authorName: 'Rova', message: 'SAC10 +1', source: 'SSE' });
    expect(c2.body.outcome).toMatchObject({ status: 'ORDERED', merged: true, orderId: c1.body.outcome.orderId });
    const dup = await comment({ fbCommentId: 'c1', authorId: 'fb_rova', authorName: 'Rova', message: 'JP01 +1 M', source: 'SSE' });
    expect(dup.body.duplicate).toBe(true);
    const ord = await call(B, 'GET', shop(B, `/orders/${c1.body.outcome.orderId}`));
    expect(ord.body.items).toHaveLength(2);
    expect(ord.body.totalMga).toBe(35000 + 25000);
    expect(ord.body.channel).toBe('LIVE');
  });

  it('rattache un « +1 » à son commentaire parent, sinon demande une validation', async () => {
    const plus = await comment({ fbCommentId: 'c3', parentId: 'post_100', authorId: 'fb_hery', authorName: 'Hery', message: '+1 L' });
    expect(plus.body.outcome.status).toBe('ORDERED');
    const orphan = await comment({ fbCommentId: 'c4', authorId: 'fb_lala', authorName: 'Lala', message: '+1' });
    expect(orphan.body.outcome.status).toBe('NEEDS_REVIEW');
    const noSize = await comment({ fbCommentId: 'c5', authorId: 'fb_lala', authorName: 'Lala', message: 'JP01 +1' });
    expect(noSize.body.outcome).toMatchObject({ status: 'NEEDS_REVIEW' });
    expect(noSize.body.outcome.reason).toMatch(/variante/);
    const question = await comment({ fbCommentId: 'c6', authorName: 'Nirina', message: 'JP01 prix ?' });
    expect(question.body.outcome.status).toBe('NOT_AN_ORDER');

    // L'assistant valide : Lala veut la taille S.
    const s = jean.variants.find((v) => v.label === 'S')!;
    const res = await call(B, 'POST', shop(B, `/lives/${live.id}/comments/${noSize.body.comment.id}/resolve`), { action: 'accept', variantId: s.id, quantity: 1, customer: { phone: '0331122334' } });
    expect(res.body.status).toBe('ORDERED');
    const review = await call(B, 'GET', shop(B, `/lives/${live.id}/comments?status=NEEDS_REVIEW`));
    expect(review.body).toHaveLength(1); // ne reste que le « +1 » orphelin
  });

  it('met en liste d’attente quand le stock est épuisé', async () => {
    // L : 1 seul, déjà réservé par Hery.
    const w = await comment({ fbCommentId: 'c7', authorId: 'fb_tiana', authorName: 'Tiana', message: 'JP01 1 L' });
    expect(w.body.outcome.status).toBe('WAITLISTED');
  });

  it('saisie rapide de l’assistant avec téléphone', async () => {
    const q = await call(B, 'POST', shop(B, `/lives/${live.id}/quick-order`), { text: 'JP01 2 M', customer: { fullName: 'Fara', phone: '0345556677' } });
    expect(q.body.outcome.status).toBe('ORDERED');
    const ord = await call(B, 'GET', shop(B, `/orders/${q.body.outcome.orderId}`));
    expect(ord.body.customer.phone).toBe('0345556677');
  });

  it('donne le bilan du live et les statistiques de la boutique', async () => {
    const lv = await call(B, 'GET', shop(B, `/lives/${live.id}`));
    expect(lv.body.stats.pending).toBe(4); // Rova, Hery, Lala, Fara
    expect(lv.body.stats.comments).toBe(8); // 7 commentaires + 1 saisie rapide
    expect(lv.body.items[0].commentText).toMatch(/JP01 — PRODUIT JP01/);

    // Rova confirme et paie.
    const list = await call(B, 'GET', shop(B, `/orders?liveSessionId=${live.id}&q=Rova`));
    const rova = list.body.items[0];
    await call(B, 'POST', shop(B, `/orders/${rova.id}/status`), { status: 'CONFIRMED' });
    await call(B, 'POST', shop(B, `/orders/${rova.id}/payments`), { method: 'ORANGE_MONEY', amountMga: 60000, confirmed: true });

    const ov = await call(B, 'GET', shop(B, '/stats/overview'));
    expect(ov.body).toMatchObject({ revenueMga: 60000, paidMga: 60000, orders: 1, pendingOrders: 3, itemsSold: 2 });
    const top = await call(B, 'GET', shop(B, '/stats/top-products'));
    expect(top.body.map((x: { code: string }) => x.code).sort()).toEqual(['JP01', 'SAC10']);
    const lives = await call(B, 'GET', shop(B, '/stats/lives'));
    expect(lives.body[0]).toMatchObject({ title: 'Live du soir', orders: 1, revenueMga: 60000 });
    const pays = await call(B, 'GET', shop(B, '/stats/payments'));
    expect(pays.body[0]).toMatchObject({ method: 'ORANGE_MONEY', amountMga: 60000 });
    const days = await call(B, 'GET', shop(B, '/stats/sales-by-day'));
    expect(days.body[0].revenueMga).toBe(60000);

    // Fiche client : historique et produits préférés.
    const fiche = await call(B, 'GET', shop(B, `/customers/${rova.customer.id}`));
    expect(fiche.body.stats).toMatchObject({ ordersCount: 1, totalSpentMga: 60000, unpaidMga: 0 });
    expect(fiche.body.lives[0].title).toBe('Live du soir');
    expect(fiche.body.favoriteProducts).toHaveLength(2);
    const clients = await call(B, 'GET', shop(B, '/customers?sort=spent'));
    expect(clients.body.items[0]).toMatchObject({ fullName: 'Rova', totalSpentMga: 60000 });
  });
});
