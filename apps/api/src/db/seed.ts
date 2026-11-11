/**
 * Données de démonstration : un compte, une boutique, un catalogue, des clients, des lives et
 * des commandes réparties sur deux semaines. Passe par l'API (mêmes règles de stock que la prod).
 *
 *   npm run db:seed -w apps/api            → demo@livecompanion.mg / demo1234
 *   SEED_EMAIL=… SEED_PASSWORD=… npm run db:seed -w apps/api
 */
import { eq, sql } from 'drizzle-orm';
import { buildApp } from '../app.ts';
import { db, pool, schema } from './client.ts';
import { runMigrations } from './migrate.ts';

const EMAIL = process.env.SEED_EMAIL ?? 'demo@livecompanion.mg';
const PASSWORD = process.env.SEED_PASSWORD ?? 'demo1234';

await runMigrations();
const [exists] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, EMAIL));
if (exists) {
  console.log(`Le compte ${EMAIL} existe déjà : rien à faire.`);
  await pool.end();
  process.exit(0);
}

const app = await buildApp({ logger: false });
let token = '';
async function call<T = any>(method: string, url: string, payload?: unknown): Promise<T> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const r = await app.inject({ method: method as 'GET', url, payload: payload as object, headers: token ? { authorization: `Bearer ${token}` } : {} });
  if (r.statusCode >= 400) throw new Error(`${method} ${url} → ${r.statusCode} ${r.body}`);
  return r.json();
}

const reg = await call('POST', '/v1/auth/register', { email: EMAIL, password: PASSWORD, fullName: 'Hanta Rasoa', shopName: 'Boutique démo', city: 'Antananarivo', phone: '0340000000' });
token = reg.token;
const shop = reg.user.shops[0].id as string;
const S = (p: string) => `/v1/shops/${shop}${p}`;

const catalog = [
  { code: 'JP01', name: 'Jean blanc slim', priceMga: 35000, variants: [{ label: 'S', stock: 8 }, { label: 'M', stock: 12 }, { label: 'L', stock: 6 }, { label: 'XL', stock: 2 }] },
  { code: 'RB02', name: 'Robe fleurie', priceMga: 45000, variants: [{ label: 'Rouge', stock: 6 }, { label: 'Bleu', stock: 9 }] },
  { code: 'SAC10', name: 'Sac à main cuir', priceMga: 25000, variants: [{ label: 'Unique', stock: 20 }] },
  { code: 'TS05', name: 'T-shirt coton', priceMga: 15000, variants: [{ label: 'M', stock: 3 }, { label: 'L', stock: 3 }] },
  { code: 'CH07', name: 'Chemise lin', priceMga: 30000, variants: [{ label: 'M', stock: 7 }, { label: 'L', stock: 5 }] },
  { code: 'SD03', name: 'Sandales tressées', priceMga: 22000, variants: [{ label: '38', stock: 4 }, { label: '39', stock: 5 }, { label: '40', stock: 3 }] },
];
const products: any[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
for (const p of catalog) products.push(await call('POST', S('/products'), p));

const people = [
  ['Rova Andriamanana', '0341234567', 'Antananarivo'], ['Fara Rabe', '0345556677', 'Antananarivo'], ['Hery Rakoto', '0331122334', 'Toamasina'],
  ['Lala Razafy', '0329988776', 'Mahajanga'], ['Soa Randria', '0324011122', 'Fianarantsoa'], ['Nirina Rasolo', '0346677889', 'Antsirabe'],
  ['Tiana Ravelo', '0337788990', 'Antananarivo'], ['Mamy Andria', '0341239876', 'Toliara'], ['Voahangy Rabary', '0345678123', 'Antananarivo'],
];
const customers: any[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
for (const [fullName, phone, city] of people) customers.push(await call('POST', S('/customers'), { fullName, phone, city }));

const variant = (code: string, label: string) => products.find((p) => p.code === code).variants.find((v: { label: string }) => v.label === label).id as string;
const day = (n: number) => new Date(Date.now() - n * 86_400_000);
let k = 0;
async function order(daysAgo: number, cust: number, items: [string, string, number][], flow: string[], liveId?: string) {
  const o = await call('POST', S('/orders'), {
    customerId: customers[cust].id, channel: liveId ? 'LIVE' : 'MESSENGER', liveSessionId: liveId,
    items: items.map(([c, l, q]) => ({ variantId: variant(c, l), quantity: q })), deliveryCity: people[cust][2],
  });
  for (const st of flow) {
    if (st === 'PAY') await call('POST', S(`/orders/${o.id}/payments`), { method: k++ % 3 ? 'MVOLA' : 'ORANGE_MONEY', amountMga: o.totalMga, providerRef: `MV${100000 + k}`, confirmed: true });
    else if (st === 'SHIP') await call('POST', S(`/orders/${o.id}/shipments`), { method: 'COURIER', carrierName: 'Livreur Tana' });
    else await call('POST', S(`/orders/${o.id}/status`), { status: st });
  }
  const at = new Date(day(daysAgo).getTime() - (k % 5) * 3_600_000);
  await db.update(schema.orders).set({ createdAt: at, ...(flow.includes('CONFIRMED') ? { confirmedAt: at } : {}) }).where(eq(schema.orders.id, o.id));
  return o;
}

const done = ['CONFIRMED', 'PAY', 'SHIP', 'SHIPPED', 'DELIVERED'];
const live1 = await call('POST', S('/lives'), { title: 'Live du samedi — nouveautés', productIds: products.slice(0, 4).map((p) => p.id) });
await call('POST', S(`/lives/${live1.id}/start`), {});
await order(12, 0, [['RB02', 'Rouge', 1], ['SAC10', 'Unique', 1]], done, live1.id);
await order(12, 1, [['JP01', 'M', 1]], done, live1.id);
await order(12, 2, [['JP01', 'L', 1], ['SAC10', 'Unique', 1]], done, live1.id);
await order(12, 3, [['TS05', 'M', 2]], ['CANCELLED'], live1.id);
await call('POST', S(`/lives/${live1.id}/end`), {});
await db.update(schema.liveSessions).set({ createdAt: day(12), startedAt: day(12), endedAt: new Date(day(12).getTime() + 5_400_000) }).where(eq(schema.liveSessions.id, live1.id));

await order(10, 4, [['CH07', 'M', 1]], done);
await order(9, 5, [['SD03', '39', 1]], ['CONFIRMED', 'PAY', 'SHIP', 'SHIPPED', 'DELIVERED']);
await order(8, 6, [['JP01', 'S', 2]], done);

const live2 = await call('POST', S('/lives'), { title: 'Live du mercredi — robes et sacs', productIds: [products[1].id, products[2].id, products[0].id, products[5].id] });
await call('POST', S(`/lives/${live2.id}/start`), {});
await order(5, 0, [['JP01', 'S', 1]], done, live2.id);
await order(5, 7, [['RB02', 'Bleu', 1]], ['CONFIRMED', 'PAY', 'PREPARING'], live2.id);
await order(5, 8, [['SAC10', 'Unique', 2]], ['CONFIRMED', 'PAY', 'SHIP', 'SHIPPED'], live2.id);
await order(5, 6, [['SD03', '38', 1]], ['CONFIRMED'], live2.id);
await call('POST', S(`/lives/${live2.id}/end`), {});
await db.update(schema.liveSessions).set({ createdAt: day(5), startedAt: day(5), endedAt: new Date(day(5).getTime() + 4_800_000) }).where(eq(schema.liveSessions.id, live2.id));

await order(3, 2, [['CH07', 'L', 1]], ['CONFIRMED', 'PAY']);
await order(2, 0, [['RB02', 'Bleu', 1]], ['CONFIRMED', 'PAY', 'SHIP', 'SHIPPED', 'DELIVERED']);

// Live en préparation, avec des commandes encore à confirmer.
const live3 = await call('POST', S('/lives'), { title: 'Live de ce soir', productIds: [products[0].id, products[1].id, products[4].id, products[3].id] });
await call('POST', S(`/lives/${live3.id}/start`), {});
await call('POST', S(`/lives/${live3.id}/present`), {});
await call('POST', S(`/lives/${live3.id}/quick-order`), { text: 'JP01 M 2', customer: { fullName: 'Fara Rabe' } });
await call('POST', S(`/lives/${live3.id}/quick-order`), { text: 'JP01 L', customer: { fullName: 'Hery Rakoto' } });
await call('POST', S(`/lives/${live3.id}/comments`), { message: 'JP01 +1', authorName: 'Lala Razafy', authorId: 'demo-lala', source: 'MANUAL' });
await call('POST', S(`/lives/${live3.id}/comments`), { message: 'Trop beau 😍', authorName: 'Tiana Ravelo', source: 'MANUAL' });

await db.execute(sql`SELECT 1`);
await app.close();
await pool.end();
console.log(`Démo prête : ${EMAIL} / ${PASSWORD}`);
