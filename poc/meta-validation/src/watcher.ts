import { emit, log } from './bus.ts';
import { graph, selectedPage } from './graph.ts';
import { ingestionStatus, pollOnce, startPolling, startSse, stopPolling, stopSse } from './ingestion.ts';
import { allShopIds, persist, runInShop, state, type Followed } from './store.ts';

/**
 * Surveillance automatique, boutique par boutique, toutes les minutes :
 *  1. fin du live suivi sur Facebook → marqué « terminé », le temps réel s'arrête ;
 *  2. nouveau live sur la Page → suivi automatiquement (lecture des commentaires lancée) ;
 *  3. rediffusions et publications récentes : leurs commentaires continuent d'être lus
 *     pendant 7 jours, tant qu'il reste du stock.
 */
export const REPLAY_DAYS = 7;
const TICK_MS = Number(process.env.WATCH_TICK_MS) || 60_000;
const ENDED = new Set(['LIVE_STOPPED', 'VOD', 'PROCESSING', 'UNPUBLISHED']);

export interface WatchedSale { id: string; targets: string[]; followed?: Followed; active: boolean }

/** Ventes dont on lit encore les commentaires : la vente en cours + celles des 7 derniers jours. */
export function watchedSales(): WatchedSale[] {
  const out: WatchedSale[] = [];
  const a = state.activeLive;
  if (a && !state.followed?.[a.id]?.closedAt) out.push({ id: a.id, targets: [a.id, a.videoId ?? state.followed?.[a.id]?.videoId].filter(Boolean) as string[], followed: state.followed?.[a.id], active: true });
  const limit = Date.now() - REPLAY_DAYS * 86_400_000;
  for (const f of Object.values(state.followed ?? {})) {
    if (f.id === a?.id || f.closedAt || !f.endedAt || new Date(f.endedAt).getTime() < limit) continue;
    out.push({ id: f.id, targets: [f.id, f.videoId].filter(Boolean) as string[], followed: f, active: false });
  }
  return out;
}

/** Délai entre deux lectures d'une rediffusion : rapproché juste après le live, plus espacé ensuite. */
function replayEveryMs(endedAt: string) {
  if (process.env.WATCH_TICK_MS) return Number(process.env.WATCH_TICK_MS); // tests
  const age = Date.now() - new Date(endedAt).getTime();
  if (age < 3 * 3600_000) return 60_000;          // 3 premières heures : chaque minute
  if (age < 2 * 86_400_000) return 5 * 60_000;    // 2 premiers jours : toutes les 5 min
  return 15 * 60_000;                             // ensuite : toutes les 15 min
}
const lastRead = new Map<string, number>(); // `${shop}:${saleId}` → dernière lecture

async function tickShop(shopId: string) {
  if (!state.userTokenEnc || !state.selectedPageId) return;
  const page = selectedPage();

  // 1. Le live suivi est-il terminé ?
  const a = state.activeLive;
  const f = a ? state.followed?.[a.id] : undefined;
  if (a && f?.kind === 'live' && !f.endedAt) {
    const r = await graph<{ status?: string; video?: { id: string } }>('GET', a.id, page.token, { fields: 'status,video{id}' }).catch(() => undefined);
    if (r?.video?.id && !f.videoId) f.videoId = r.video.id;
    if (r?.status && ENDED.has(r.status)) {
      f.endedAt = new Date().toISOString();
      stopSse(); stopPolling(); // la rediffusion est lue par la boucle ci-dessous
      persist();
      log('info', `Live « ${f.title} » terminé sur Facebook. Les commentaires de la rediffusion continuent d'être lus pendant ${REPLAY_DAYS} jours.`);
      emit('ingestion', { liveEnded: a.id });
    }
  }

  // 2. Un nouveau live a-t-il démarré sur la Page ?
  const lives = await graph<{ data: { id: string; title?: string; video?: { id: string }; permalink_url?: string; creation_time?: string }[] }>(
    'GET', `${page.id}/live_videos`, page.token, { broadcast_status: '["LIVE"]', fields: 'id,title,video{id},permalink_url,creation_time' },
  ).catch(() => undefined);
  const live = lives?.data?.[0];
  if (live && live.id !== state.activeLive?.id && !state.followed?.[live.id]?.endedAt && !state.followed?.[live.id]?.closedAt) {
    // L'ancienne vente (publication ou live terminé) reste lue en rediffusion.
    const prev = state.activeLive;
    if (prev) {
      state.followed ??= {};
      const pf = state.followed[prev.id] ?? { id: prev.id, kind: /^Publication/.test(prev.title ?? '') ? 'post' : 'live', title: prev.title || 'Vente sans titre', followedAt: new Date().toISOString() } as Followed;
      pf.endedAt ??= new Date().toISOString();
      pf.videoId ??= prev.videoId;
      state.followed[prev.id] = pf;
    }
    const title = live.title || `Live du ${new Date().toLocaleDateString('fr-FR', { timeZone: 'Indian/Antananarivo' })}`;
    state.activeLive = { id: live.id, videoId: live.video?.id, title };
    state.followed ??= {};
    state.followed[live.id] = {
      id: live.id, kind: 'live', title, videoId: live.video?.id,
      permalink: live.permalink_url ? `https://www.facebook.com${live.permalink_url}` : undefined,
      createdTime: live.creation_time, followedAt: new Date().toISOString(),
    };
    persist();
    log('info', `Nouveau live détecté : « ${title} ». Suivi automatiquement.`);
    await startPolling(live.id).catch((e) => log('warn', `Lecture du nouveau live : ${e.message}`));
    startSse(live.id);
    emit('ingestion', { liveStarted: live.id });
  }

  // 3. Rediffusions et publications récentes (hors objet déjà lu en continu).
  const running = ingestionStatus();
  for (const w of watchedSales()) {
    if (w.active && (running.polling || running.sse) && !w.followed?.endedAt) continue; // déjà lu en direct
    if (w.active && !w.followed?.endedAt) continue; // vente en cours non lancée : l'assistant choisit quand lire
    const key = `${shopId}:${w.id}`;
    const every = replayEveryMs(w.followed!.endedAt!);
    if (Date.now() - (lastRead.get(key) ?? 0) < every) continue;
    lastRead.set(key, Date.now());
    // Les commentaires de la rediffusion peuvent arriver sur le live ou sur sa vidéo : on lit les deux
    // (un commentaire déjà vu n'est jamais compté deux fois).
    for (const target of w.targets) await pollOnce(target, w.id).catch(() => undefined);
  }
}

let started = false;
export function startWatcher() {
  if (started) return;
  started = true;
  setInterval(() => {
    for (const id of allShopIds()) {
      runInShop(id, () => tickShop(id).catch((e) => log('warn', `Surveillance des lives : ${e.message}`)));
    }
  }, TICK_MS).unref();
}
