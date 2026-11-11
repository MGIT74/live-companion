import { log } from './bus.ts';
import { config } from './config.ts';
import { graph, selectedPage } from './graph.ts';
import { persist, state } from './store.ts';

/**
 * Abonnement de la Page aux webhooks de l'app (messages Messenger, boutons, commentaires).
 * Facebook le garde de son côté : on le fait automatiquement à la connexion et au choix
 * de la Page, puis on vérifie qu'il est toujours actif (démarrage, détection du live, écran).
 */
export const REQUIRED_FIELDS = ['messages', 'messaging_postbacks', 'feed'];

export interface SubscriptionStatus { pageId?: string; active: boolean; missing: string[]; checkedAt: string; error?: string }

function save(s: SubscriptionStatus) {
  state.subscription = s;
  persist();
  return s;
}

/** Interroge Facebook : la Page sélectionnée est-elle abonnée à notre app avec les bons champs ? */
export async function checkSubscription(): Promise<SubscriptionStatus> {
  const checkedAt = new Date().toISOString();
  let page;
  try { page = selectedPage(); } catch { return save({ active: false, missing: REQUIRED_FIELDS, checkedAt, error: 'Aucune Page sélectionnée' }); }
  try {
    const res = await graph<{ data: { id: string; subscribed_fields?: string[] }[] }>('GET', `${page.id}/subscribed_apps`, page.token);
    const mine = res.data.find((a) => a.id === config.appId);
    const fields = mine?.subscribed_fields ?? [];
    const missing = REQUIRED_FIELDS.filter((f) => !fields.includes(f));
    return save({ pageId: page.id, active: !!mine && missing.length === 0, missing, checkedAt });
  } catch (e) {
    return save({ pageId: page.id, active: false, missing: REQUIRED_FIELDS, checkedAt, error: (e as Error).message });
  }
}

/** Abonne la Page si besoin (sans risque : refaire l'abonnement ne change rien s'il existe déjà). */
export async function ensureSubscription(force = false): Promise<SubscriptionStatus> {
  if (!force) {
    const cur = await checkSubscription();
    if (cur.active || cur.error === 'Aucune Page sélectionnée') return cur;
  }
  try {
    const page = selectedPage();
    await graph('POST', `${page.id}/subscribed_apps`, page.token, { subscribed_fields: REQUIRED_FIELDS.join(',') });
    const s = await checkSubscription();
    log(s.active ? 'info' : 'warn', s.active ? `Messenger activé pour la Page ${page.name}` : `Abonnement de la Page incomplet (${s.missing.join(', ')})`);
    return s;
  } catch (e) {
    log('error', `Abonnement de la Page impossible : ${(e as Error).message}`);
    return save({ pageId: state.selectedPageId, active: false, missing: REQUIRED_FIELDS, checkedAt: new Date().toISOString(), error: (e as Error).message });
  }
}
