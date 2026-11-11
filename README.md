# Live Companion Madagascar

Régie de Live Commerce pour les vendeurs qui vendent en direct sur Facebook Live.
L'acheteur commande en commentaire (`JP01 +1`), sans quitter le live. Live Companion détecte la commande, réserve le stock, envoie une réponse privée Messenger et suit la confirmation.

> **Étape actuelle : preuve de concept Meta.** On valide sur une vraie Page Facebook que chaque brique de l'API Meta fonctionne avant de construire la marketplace.

Dossier d'architecture complet : voir le document *Live Companion Madagascar — Dossier d'architecture et PoC Meta*, résumé dans [`docs/architecture.md`](docs/architecture.md).

## Contenu du dépôt

| Dossier | Rôle |
| --- | --- |
| `poc/meta-validation/` | Serveur Node.js + tableau de bord web pour exécuter les 10 tests Meta |
| `packages/order-parser/` | Parseur des commandes (`JP01 +1`, `+1`, `maka JP01`, FR/MG) avec 43 tests |
| `packages/db/` | Schéma MySQL/Prisma cible de la version produit (pas utilisé par la PoC) |
| `docs/` | Architecture et suivi des résultats de tests Meta |

## Démarrage rapide de la PoC

Prérequis : Node.js 20 ou plus, une Page Facebook dont vous êtes administrateur, un compte développeur Meta.

### 1. Installer

```bash
git clone https://github.com/MGIT74/live-companion.git
cd live-companion
npm install
npm test            # 43 tests du parseur
```

### 2. Exposer le serveur en HTTPS

Meta exige une URL HTTPS publique pour le retour OAuth et les webhooks. Le plus simple pour tester :

```bash
# Cloudflare Tunnel (gratuit, sans compte) — https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
cloudflared tunnel --url http://localhost:3000
# → copiez l'URL https://xxxx.trycloudflare.com affichée
```

Alternative : `ngrok http 3000`, ou déployer sur votre VPS XCloud derrière HTTPS.

### 3. Créer l'application Meta

1. https://developers.facebook.com/apps → **Créer une app** → type **Business** (ou « Autre » puis Business).
2. Ajoutez les produits **Facebook Login for Business** (ou Facebook Login), **Messenger** et **Webhooks**.
3. **Paramètres de Facebook Login** → *URI de redirection OAuth valides* : `https://VOTRE-TUNNEL/auth/callback`.
4. **Rôles de l'app** : ajoutez-vous en administrateur et vos testeurs en *Testeur*. Tant que l'app est en mode *Développement*, seuls ces comptes peuvent l'utiliser — c'est suffisant pour la PoC, sans revue d'app.
5. **Webhooks** → objet **Page** → URL de rappel `https://VOTRE-TUNNEL/webhooks/meta`, jeton de vérification = `WEBHOOK_VERIFY_TOKEN` de votre `.env`. Abonnez les champs `feed`, `messages`, `messaging_postbacks`.
6. Notez l'**ID de l'app** et la **clé secrète** (Paramètres → Général).

Si votre app utilise *Facebook Login for Business*, créez une **configuration** avec les permissions ci-dessous et mettez son ID dans `META_LOGIN_CONFIG_ID`.

Permissions demandées : `pages_show_list`, `pages_read_engagement`, `pages_read_user_content`, `pages_manage_engagement`, `pages_manage_metadata`, `pages_messaging`.

### 4. Configurer et lancer

```bash
cd poc/meta-validation
cp .env.example .env
npm run keygen      # copiez la valeur dans ENCRYPTION_KEY
# remplissez META_APP_ID, META_APP_SECRET, BASE_URL (URL du tunnel), WEBHOOK_VERIFY_TOKEN, DASHBOARD_PASSWORD
npm run dev
```

Ouvrez `https://VOTRE-TUNNEL/` (utilisateur `admin`, mot de passe `DASHBOARD_PASSWORD`).

## Déroulé des tests (environ 1 h, 3 à 5 testeurs)

| # | Où | Action |
| --- | --- | --- |
| T1–T2 | En-tête | **Connecter Facebook**, accepter toutes les permissions, choisir la Page. Puis **Abonner la Page aux webhooks**. |
| T3 | Bloc 1 | Lancez un live depuis la Page (visibilité publique ou restreinte), puis **Détecter le live actif** → **Suivre ce live**. |
| T4 | Bloc 2 | **▶ Polling 5 s**. Les testeurs commentent. Tous les commentaires doivent apparaître. |
| T5 | Bloc 2 | **▶ Temps réel SSE**. Comparez le délai ; coupez le Wi-Fi 60 s puis rétablissez : aucun commentaire perdu, aucun doublon. |
| T6 | Bloc 3 | **Publier via l'API** le commentaire JP01. Vérifiez qu'il apparaît dans le live, signé par la Page. Sinon : **Copier le texte**, publiez à la main, puis **J'ai publié à la main** (collez l'id ou le lien du commentaire). |
| T7 | Facebook | **Épinglez** le commentaire JP01 dans le live. Les testeurs **répondent `+1`** dessous. Puis **Analyser les parents (T7)**. |
| T8 | Live | Les testeurs écrivent : `JP01 +1`, `jp01+2`, `JP01 1 M`, `maka JP01`, `+1`, `JP01 prix ?`, « trop beau »… Puis **Analyser le parseur (T8)**. |
| T9 | Réservations | Sur une réservation : **Réponse privée (T9)**. Le testeur doit recevoir le message dans Messenger. Puis **Tester 2e message** : il doit être refusé. |
| T10 | Messenger | Le testeur tape **Confirmer**, puis donne nom, téléphone, adresse, ville, paiement. La commande passe en `CONFIRMED`. |

Après chaque test, choisissez OK / PARTIEL / KO dans le tableau et ajoutez une note. Le lien **Rapport .md** génère le tableau à copier dans [`docs/meta-capabilities.md`](docs/meta-capabilities.md).

Toutes les réponses brutes de Meta sont archivées (jetons masqués) dans `poc/meta-validation/evidence/`. Ce dossier et `data/` ne sont pas versionnés.

## Règles respectées par la PoC

- API officielles Meta uniquement, aucun scraping.
- Un commentaire est traité une seule fois, quel que soit le canal (SSE, polling, webhook).
- Un `+1` n'est associé à un produit que si son commentaire parent est un commentaire produit connu ; sinon il part en validation.
- Jetons Meta chiffrés AES-256-GCM, jamais envoyés au navigateur ; signature des webhooks vérifiée ; `appsecret_proof` sur chaque appel.
- Une seule réponse privée par commentaire (règle Meta : 7 jours max).

## Licence

Propriétaire — tous droits réservés.
