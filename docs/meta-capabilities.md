# Capacités Meta — statut vérifié

Règle : une fonctionnalité n'est « disponible » qu'avec une preuve (réponse brute dans `poc/meta-validation/evidence/`).
Mettre à jour ce tableau après chaque session de test (lien **Rapport .md** du tableau de bord).

| # | Fonctionnalité | Documentation Meta | Permissions | Résultat | Date | Note |
| --- | --- | --- | --- | --- | --- | --- |
| T1 | Connexion OAuth, jeton de Page | Documenté | Facebook Login | À tester | | |
| T2 | Pages et permissions accordées | Documenté | `pages_show_list` | À tester | | |
| T3 | Détection du live actif | Documenté (`/{page-id}/live_videos?broadcast_status=["LIVE"]`) | `pages_read_engagement` | À tester | | |
| T4 | Lecture des commentaires (polling) | Documenté (`/{live-video-id}/comments`, `live_filter=no_filter`) | `pages_read_engagement`, `pages_read_user_content` | À tester | | Noter si `from` est présent |
| T5 | Commentaires temps réel (SSE) | Documenté (`streaming-graph.facebook.com/{id}/live_comments`) | jeton de Page | À tester | | Latence médiane, reprise |
| T6 | Publier un commentaire au nom de la Page | Documenté (`POST /{object-id}/comments`) | `pages_manage_engagement` | À tester | | Sur live_video ou video ? |
| T7 | Parent des réponses `+1` | Champ `parent` documenté ; non confirmé en live | lecture | À tester | | Par canal : SSE / polling / webhook |
| T8 | Reconnaissance des commandes | Interne | — | À tester | | Précision visée ≥ 95 % |
| T9 | Réponse privée Messenger | Documenté (1 message / commentaire, 7 jours) | `pages_messaging` | À tester | | 2e message refusé ? |
| T10 | Parcours de confirmation | Documenté (fenêtre 24 h) | `pages_messaging`, webhooks | À tester | | PSID relié au commentaire |
| — | Épingler un commentaire par API | **Aucune API trouvée** | — | Non disponible | | Manuel dans le MVP |
| — | Live Shopping Tools (épingler produit/lien) | Documenté, accès limité, régions restreintes | `live_shopping_manage_video` | Non demandé | | Contact Meta requis |
