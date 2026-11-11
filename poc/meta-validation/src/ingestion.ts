import { parseOrder, stripMentions, type MessageTag } from '@live-companion/order-parser';
import { streamingBase } from './config.ts';
import { appSecretProof } from './crypto.ts';
import { emit, log } from './bus.ts';
import { saveEvidence } from './evidence.ts';
import { graph, GraphError, selectedPage } from './graph.ts';
import { handleParsed, parseOptions } from './reservations.ts';
import { persist, recordTest, state, type LiveComment, type Source } from './store.ts';
import { sendPrivateReplyForIntent } from './messenger.ts';

const COMMENT_FIELDS = 'id,message,message_tags,created_time,from{id,name},parent{id}';

export interface RawComment {
  id: string;
  message?: string;
  created_time?: string;
  from?: { id?: string; name?: string };
  parent?: { id?: string };
  parent_id?: string;
  message_tags?: MessageTag[];
}

const stats = {
  POLL: { received: 0, new: 0, withFrom: 0, withParent: 0 },
  SSE: { received: 0, new: 0, withFrom: 0, withParent: 0, latencies: [] as number[] },
  WEBHOOK: { received: 0, new: 0, withFrom: 0, withParent: 0 },
};
export function ingestionStats() {
  const lat = [...stats.SSE.latencies].sort((a, b) => a - b);
  const median = lat.length ? lat[Math.floor(lat.length / 2)] : undefined;
  return { ...stats, SSE: { ...stats.SSE, latencies: undefined, medianLatencyMs: median, samples: lat.length }, total: Object.keys(state.comments).length };
}

/**
 * Point d'entrée unique de tous les canaux (SSE, polling, webhook).
 * Idempotent : un commentaire déjà vu n'est traité qu'une fois.
 */
export function ingestComment(raw: RawComment, liveVideoId: string, source: Source): LiveComment | undefined {
  if (!raw?.id) return undefined;
  const s = stats[source];
  s.received++;
  if (raw.from?.id) s.withFrom++;
  const parentId = raw.parent?.id ?? raw.parent_id;
  if (parentId && parentId !== raw.id) s.withParent++;

  const existing = state.comments[raw.id];
  if (existing) {
    if (!existing.sources.includes(source)) existing.sources.push(source);
    // Complète les champs manquants (ex. "from" absent en SSE mais présent en polling).
    existing.fromId ??= raw.from?.id;
    existing.fromName ??= raw.from?.name;
    if (!existing.parentId && parentId && parentId !== raw.id) existing.parentId = parentId;
    persist();
    return undefined;
  }

  s.new++;
  const receivedAt = new Date();
  const latencyMs = raw.created_time ? receivedAt.getTime() - Date.parse(raw.created_time) : undefined;
  if (source === 'SSE' && latencyMs !== undefined && latencyMs >= 0) stats.SSE.latencies.push(latencyMs);

  const comment: LiveComment = {
    id: raw.id,
    liveVideoId,
    message: raw.message ?? '',
    fromId: raw.from?.id,
    fromName: raw.from?.name,
    parentId: parentId && parentId !== raw.id ? parentId : undefined,
    createdTime: raw.created_time,
    firstSource: source,
    sources: [source],
    receivedAt: receivedAt.toISOString(),
    latencyMs,
  };
  state.comments[comment.id] = comment;

  // Les commentaires publiés par la Page elle-même ne sont pas des commandes.
  const isPageComment = comment.fromId && comment.fromId === state.selectedPageId;
  const isProductComment = state.productComments.some((pc) => pc.commentId === comment.id);
  if (!isPageComment && !isProductComment) {
    // « Répondre » sur Facebook ajoute le nom tagué en tête (« Hands Graphic +1 ») : on le retire avant d'analyser.
    const names = [state.pages.find((p) => p.id === state.selectedPageId)?.name ?? '', comment.parentId ? state.comments[comment.parentId]?.fromName ?? '' : ''];
    const clean = stripMentions(comment.message, raw.message_tags, names);
    if (clean !== comment.message) comment.parsedText = clean;
    const intent = handleParsed(comment, liveVideoId, comment.message, parseOrder(clean, parseOptions()));
    if (intent?.status === 'RESERVED' && state.settings.autoPrivateReply) {
      sendPrivateReplyForIntent(intent.id).catch((e) => log('warn', `Réponse privée auto échouée : ${e.message}`));
    }
  }
  persist();
  emit('comment', comment);
  return comment;
}

/** Réanalyse les commentaires restés sans intention (ex. après une amélioration du parseur). */
export function reparseComments() {
  const pageName = state.pages.find((p) => p.id === state.selectedPageId)?.name ?? '';
  let created = 0;
  for (const c of Object.values(state.comments)) {
    if (c.intentId || c.fromId === state.selectedPageId || state.productComments.some((pc) => pc.commentId === c.id)) continue;
    const clean = stripMentions(c.message, [], [pageName, c.parentId ? state.comments[c.parentId]?.fromName ?? '' : '']);
    const parsed = parseOrder(clean, parseOptions());
    if (parsed.type === 'none') continue;
    if (clean !== c.message) c.parsedText = clean;
    if (handleParsed(c, c.liveVideoId, c.message, parsed)) created++;
  }
  persist();
  return { created };
}

// ---------------------------------------------------------------- Polling (T4)

let pollTimer: NodeJS.Timeout | undefined;
let pollTarget: string | undefined;

export async function pollOnce(objectId: string) {
  const page = selectedPage();
  const res = await graph<{ data: RawComment[] }>('GET', `${objectId}/comments`, page.token, {
    filter: 'stream',
    live_filter: 'no_filter',
    order: 'reverse_chronological',
    fields: COMMENT_FIELDS,
    limit: 100,
  });
  const liveId = state.activeLive?.id ?? objectId;
  let fresh = 0;
  for (const c of [...res.data].reverse()) if (ingestComment(c, liveId, 'POLL')) fresh++;
  return { count: res.data.length, fresh, sample: res.data.slice(0, 5) };
}

export async function startPolling(objectId: string, intervalMs = 5000) {
  stopPolling();
  pollTarget = objectId;
  const first = await pollOnce(objectId);
  const file = saveEvidence('T4', `poll_first_${objectId}`, first);
  recordTest('T4', { evidenceFile: file, note: `Polling sur ${objectId} : ${first.count} commentaires lus au 1er appel.` });
  pollTimer = setInterval(() => {
    pollOnce(objectId).catch((e) => log('warn', `Polling : ${e.message}`));
  }, intervalMs);
  emit('ingestion', { polling: true, objectId });
  return first;
}

export function stopPolling() {
  clearInterval(pollTimer);
  pollTimer = undefined;
  if (pollTarget) emit('ingestion', { polling: false, objectId: pollTarget });
  pollTarget = undefined;
}

// ---------------------------------------------------------------- SSE (T5)

let sseAbort: AbortController | undefined;
let sseWanted = false;
let sseRetry = 0;

interface SseVariant { fields: boolean; proof: boolean; label: string }
const SSE_VARIANTS: SseVariant[] = [
  { fields: true, proof: true, label: 'fields + appsecret_proof' },
  { fields: false, proof: true, label: 'sans fields' },
  { fields: false, proof: false, label: 'sans fields ni appsecret_proof' },
];

async function readSse(liveVideoId: string, variant: SseVariant, gen: number): Promise<void> {
  const page = selectedPage();
  const url = new URL(`${streamingBase}/${liveVideoId}/live_comments`);
  url.searchParams.set('access_token', page.token);
  if (variant.proof) url.searchParams.set('appsecret_proof', appSecretProof(page.token));
  url.searchParams.set('comment_rate', 'one_hundred_per_second');
  if (variant.fields) url.searchParams.set('fields', COMMENT_FIELDS);

  sseAbort = new AbortController();
  const res = await fetch(url, { headers: { Accept: 'text/event-stream' }, signal: sseAbort.signal });
  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => '');
    const json = safeJson(body);
    if (!json?.error) json.error = { message: `HTTP ${res.status} : ${body.slice(0, 300) || '(réponse vide)'}` };
    throw new GraphError(res.status, json);
  }
  if (gen !== sseGen) { sseAbort.abort(); return; }
  log('info', `SSE connecté sur ${liveVideoId} (${variant.label})`);
  emit('ingestion', { sse: true, liveVideoId });
  sseRetry = 0;

  const decoder = new TextDecoder();
  let buffer = '';
  let firstSaved = false;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
      if (!data) continue; // ": ping"
      const json = safeJson(data);
      if (!json?.id) continue;
      if (!firstSaved) {
        firstSaved = true;
        const file = saveEvidence('T5', 'sse_first_event', json);
        recordTest('T5', { evidenceFile: file, note: `Premier événement SSE reçu. Champs : ${Object.keys(json).join(', ')}` });
      }
      ingestComment(json, liveVideoId, 'SSE');
    }
  }
}

function safeJson(s: string): any {
  try { return JSON.parse(s); } catch { return { raw: s }; }
}

let sseGen = 0;

export function startSse(liveVideoId: string) {
  stopSse();
  sseWanted = true;
  const gen = ++sseGen; // une seule boucle active à la fois
  let v = 0;
  const failures: unknown[] = [];
  const loop = async () => {
    while (sseWanted && gen === sseGen) {
      try {
        await readSse(liveVideoId, SSE_VARIANTS[v], gen);
        if (gen !== sseGen) return;
        log('warn', 'Flux SSE terminé par le serveur, reconnexion…');
      } catch (e: any) {
        if (!sseWanted || gen !== sseGen) return;
        if (e instanceof GraphError && e.status >= 400 && e.status < 500) {
          failures.push({ variant: SSE_VARIANTS[v].label, status: e.status, body: e.body });
          log('warn', `SSE refusé (${SSE_VARIANTS[v].label}) : ${e.message}`);
          if (++v < SSE_VARIANTS.length) continue;
          // Toutes les variantes refusées : on arrête et on archive la réponse exacte de Meta.
          const file = saveEvidence('T5', 'sse_refused', { liveVideoId, failures });
          recordTest('T5', { status: 'KO', evidenceFile: file, note: `SSE refusé par Meta (${e.message}). Repli : polling.` });
          log('error', 'SSE abandonné : Meta refuse le flux temps réel pour ce live. Le polling reste actif.');
          sseWanted = false;
          emit('ingestion', { sse: false });
          return;
        }
        log('warn', `SSE erreur : ${e.message}`);
      }
      // Rattrapage par polling pour combler le trou pendant la coupure.
      await pollOnce(state.activeLive?.id ?? liveVideoId).catch(() => undefined);
      const wait = Math.min(30000, 1000 * 2 ** sseRetry++);
      emit('ingestion', { sse: false, reconnectInMs: wait });
      await new Promise((r) => setTimeout(r, wait));
    }
  };
  loop();
}

export function stopSse() {
  sseGen++;
  sseWanted = false;
  sseAbort?.abort();
  sseAbort = undefined;
  emit('ingestion', { sse: false });
}

export function ingestionStatus() {
  return { polling: Boolean(pollTimer), pollTarget, sse: sseWanted };
}
