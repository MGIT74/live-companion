# API Live Companion

Serveur REST multi-boutiques : comptes vendeurs, catalogue et stock, clients (CRM), commandes, paiements, livraisons, lives et statistiques.

Node.js 22 · TypeScript · Fastify · Drizzle ORM · MySQL 8 (ou MariaDB 10.6+).

## Lancer

```bash
cp apps/api/.env.example apps/api/.env   # renseigner DATABASE_URL et JWT_SECRET
npm install
npm run dev -w apps/api                  # applique les migrations puis écoute sur :4000
npm test -w apps/api                     # tests d'intégration (base lc_test recréée)
```

Variable `TEST_DATABASE_URL` pour pointer les tests vers une autre base (défaut `mysql://lc:lc@localhost:3306/lc_test`).

## Principes

- **Isolation des boutiques** : toute route métier est sous `/v1/shops/:shopId/…`. Une garde vérifie que l'utilisateur est membre de la boutique, et chaque requête filtre par `shop_id`. Un non-membre reçoit 404 (l'existence de la boutique n'est pas révélée).
- **Rôles** : `OWNER`, `MANAGER`, `LIVE_ASSISTANT`, `SALES` (voir `src/lib/tenant.ts`).
- **Stock sans survente** : la réservation est un `UPDATE … WHERE stock_on_hand - reserved >= q` dans une transaction, et des contraintes `CHECK` empêchent tout stock négatif. Testé avec 20 commandes simultanées sur le dernier article.
- **Cycle de commande** : `PENDING_CONFIRMATION → CONFIRMED → PAID → PREPARING → SHIPPED → DELIVERED`, plus `CANCELLED` (stock libéré) et `RETURNED` (stock réintégré). Les réservations non confirmées expirent (durée réglable par boutique).
- **Lives** : un commentaire (`JP01 +1 M`, `+1` en réponse au commentaire produit) devient une commande ; les +1 successifs d'un même client s'ajoutent à son panier du live. Cas ambigus → file de validation. Stock épuisé → liste d'attente. Doublons ignorés.
- **CRM** : client retrouvé par téléphone (normalisé +261/0), identifiant Facebook ou PSID Messenger ; fiche avec historique, total dépensé, panier moyen, impayés, produits préférés, lives suivis ; fusion de doublons ; blocage.
- **Montants** en ariary, entiers.

## Principales routes

| Domaine | Routes |
| --- | --- |
| Compte | `POST /v1/auth/register`, `POST /v1/auth/login`, `GET /v1/me`, `POST /v1/me/password` |
| Boutique | `POST /v1/shops`, `GET/PATCH /v1/shops/:shopId`, `GET/POST /members`, `PATCH/DELETE /members/:id`, `GET /activity` |
| Catalogue | `GET/POST /products`, `GET/PATCH /products/:id`, `POST /products/:id/variants`, `PATCH /variants/:id`, `POST /variants/:id/stock`, `GET /inventory/movements` |
| Clients | `GET/POST /customers`, `GET/PATCH /customers/:id`, `POST /customers/:id/merge` |
| Commandes | `GET/POST /orders`, `GET/PATCH /orders/:id`, `POST /orders/:id/items`, `POST /orders/:id/status` |
| Paiements | `POST /orders/:id/payments`, `POST /payments/:id/confirm\|fail\|refund` |
| Livraisons | `POST /orders/:id/shipments`, `PATCH /shipments/:id` |
| Lives | `GET/POST /lives`, `GET/PATCH /lives/:id`, `POST /lives/:id/start\|end`, `PUT /lives/:id/items`, `POST /lives/:id/present`, `PATCH /lives/:id/items/:itemId`, `POST/GET /lives/:id/comments`, `POST /lives/:id/comments/:cid/resolve`, `POST /lives/:id/quick-order` |
| Statistiques | `GET /stats/overview`, `/stats/sales-by-day`, `/stats/top-products`, `/stats/top-customers`, `/stats/lives`, `/stats/payments`, `/stats/channels` (paramètres `from`, `to`, `tz`, défaut 30 jours, fuseau +03:00) |

Toutes les routes « Boutique » et suivantes sont préfixées par `/v1/shops/:shopId`.
