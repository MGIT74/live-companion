# Architecture — résumé

Parcours cœur : **Facebook Live → commentaire produit → commentaire acheteur → détection → réservation → Messenger → confirmation → CRM.**

- **Monolithe modulaire** Node.js/TypeScript : processus `api`, `worker` (BullMQ), `realtime` (Socket.IO + Redis).
- **MySQL 8 + Prisma** (schéma cible : `packages/db/prisma/schema.prisma`), **Redis**, stockage objet S3.
- **Ingestion Meta** : SSE `live_comments` + rattrapage par polling + webhooks `feed`. Déduplication par `(shop_id, fb_comment_id)`.
- **Stock** : `UPDATE … SET reserved = reserved + q WHERE stock_on_hand - reserved >= q` en transaction ; sinon liste d'attente.
- **Messenger** : une réponse privée par commentaire (7 jours), puis conversation dans la fenêtre de 24 h ouverte par l'acheteur.
- **Modes** : automatique, semi-automatique, manuel assisté (socle qui fonctionne sans Meta).
- **Épinglage** : manuel dans le MVP (pas d'API pour épingler un commentaire).

Plan : Phase 0 cadrage Meta → Phase 1 PoC (ce dépôt) → socle → régie manuelle → automatisation Meta → Messenger/CRM → pilote 10 vendeurs → marketplace.
