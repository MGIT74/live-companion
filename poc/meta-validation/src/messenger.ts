import { formatMga } from '@live-companion/order-parser';
import { emit, log } from './bus.ts';
import { saveEvidence } from './evidence.ts';
import { graph, GraphError, selectedPage } from './graph.ts';
import { findProduct, releaseIntent } from './reservations.ts';
import { persist, recordTest, state, type Conversation, type Intent } from './store.ts';

/** Envoi via la Send API de la Page. */
async function send(recipient: Record<string, string>, message: Record<string, unknown>, messagingType = 'RESPONSE') {
  const page = selectedPage();
  return graph<{ recipient_id?: string; message_id?: string }>('POST', `${page.id}/messages`, page.token, {}, {
    recipient,
    messaging_type: messagingType,
    message,
  });
}

function summary(intent: Intent) {
  const p = findProduct(intent.code!);
  const unit = p?.priceMga ?? 0;
  return [
    `${p?.name ?? intent.code} — ${intent.code}${intent.variant && intent.variant !== 'Unique' ? ` (${intent.variant})` : ''}`,
    `Quantité : ${intent.quantity}`,
    `Prix : ${formatMga(unit * intent.quantity)}`,
  ].join('\n');
}

const quick = (items: Array<[string, string]>) => items.map(([title, payload]) => ({ content_type: 'text', title, payload }));

/**
 * T9 — Réponse privée à un commentaire.
 * Règle Meta : un seul message par commentaire, dans les 7 jours.
 */
export async function sendPrivateReplyForIntent(intentId: string) {
  const intent = state.intents.find((i) => i.id === intentId);
  if (!intent?.commentId) throw new Error('Intention sans commentaire Facebook : réponse privée impossible.');
  if (!intent.code) throw new Error('Produit non identifié : validez d’abord l’intention.');
  const message = {
    text: `Bonjour 👋\n\nVous avez demandé :\n\n${summary(intent)}\n\nSouhaitez-vous confirmer votre commande ?`,
    quick_replies: quick([['✅ Confirmer', `CONFIRM:${intent.id}`], ['❌ Annuler', `CANCEL:${intent.id}`]]),
  };
  const attempts: unknown[] = [];
  try {
    // Les commentaires lus sur un live_video ont un id court ("1573…") alors que la Send API
    // attend parfois la forme "<objet>_<commentaire>". On essaie les formes possibles, dans l'ordre.
    let res: { recipient_id?: string; message_id?: string } | undefined;
    let usedId = intent.commentId;
    for (const candidate of commentIdCandidates(intent.commentId)) {
      try {
        res = await send({ comment_id: candidate }, message);
        usedId = candidate;
        break;
      } catch (e) {
        const err = e as GraphError;
        attempts.push({ comment_id: candidate, error: err.body ?? err.message });
        if (err.subcode !== 1893060) throw e; // autre erreur que "ID de commentaire invalide"
      }
    }
    if (!res) throw Object.assign(new Error('Aucune forme d’identifiant de commentaire acceptée par Meta.'), { body: { attempts } });
    const file = saveEvidence('T9', `private_reply_${intent.commentId}`, { usedId, attempts, res });
    intent.privateReply = { status: 'SENT', psid: res.recipient_id, messageId: res.message_id, at: new Date().toISOString() };
    if (res.recipient_id) linkPsid(res.recipient_id, intent.id);
    recordTest('T9', { evidenceFile: file, note: `Réponse privée envoyée avec comment_id « ${usedId === intent.commentId ? 'court' : 'préfixé'} » (recipient_id ${res.recipient_id ? 'reçu' : 'absent'}). Vérifier la réception.` });
    log('info', `Réponse privée envoyée pour ${intent.code} (commentaire ${intent.commentId})`);
    return res;
  } catch (e) {
    const err = e as GraphError;
    intent.privateReply = { status: 'FAILED', error: err.message, at: new Date().toISOString() };
    const file = saveEvidence('T9', `private_reply_error_${intent.commentId}`, { attempts, error: err.body ?? err.message });
    recordTest('T9', { evidenceFile: file });
    throw e;
  } finally {
    persist();
    emit('intent', intent);
  }
}

/** Formes possibles d'un id de commentaire : tel quel, puis préfixé par l'objet vidéo, le live, la Page. */
function commentIdCandidates(id: string): string[] {
  if (id.includes('_')) return [id];
  const prefixes = [state.activeLive?.videoId, state.activeLive?.id, state.selectedPageId];
  // Préfixe déjà observé sur le commentaire produit publié par la Page (ex. "<videoId>_<commentId>").
  for (const pc of state.productComments) if (pc.commentId.includes('_')) prefixes.unshift(pc.commentId.split('_')[0]);
  return [...new Set([id, ...prefixes.filter(Boolean).map((p) => `${p}_${id}`)])];
}

/** Test de la règle "un seul message par commentaire" : renvoie un 2e message sur le même commentaire. */
export async function sendSecondPrivateReply(commentId: string) {
  try {
    let res: unknown;
    for (const candidate of commentIdCandidates(commentId)) {
      try { res = await send({ comment_id: candidate }, { text: 'Test : second message privé sur le même commentaire.' }); break; }
      catch (e) { if ((e as GraphError).subcode !== 1893060 || candidate === commentIdCandidates(commentId).at(-1)) throw e; }
    }
    const file = saveEvidence('T9', `second_reply_ACCEPTED_${commentId}`, res);
    recordTest('T9', { evidenceFile: file, note: 'ATTENTION : un 2e message privé sur le même commentaire a été accepté.' });
    return { accepted: true, res };
  } catch (e) {
    const err = e as GraphError;
    const file = saveEvidence('T9', `second_reply_refused_${commentId}`, err.body ?? { message: err.message });
    recordTest('T9', { evidenceFile: file, note: `2e message privé refusé comme attendu : ${err.message}` });
    return { accepted: false, error: err.body ?? err.message };
  }
}

function linkPsid(psid: string, intentId: string) {
  const conv: Conversation = state.conversations[psid] ?? {
    psid, step: 'AWAIT_CONFIRM', intentIds: [], customer: {}, updatedAt: new Date().toISOString(),
  };
  if (!conv.intentIds.includes(intentId)) conv.intentIds.push(intentId);
  if (conv.step === 'DONE' || conv.step === 'CANCELLED') conv.step = 'AWAIT_CONFIRM';
  conv.updatedAt = new Date().toISOString();
  state.conversations[psid] = conv;
  persist();
  emit('conversation', conv);
}

/**
 * T10 — Message entrant (webhook "messages" / "messaging_postbacks").
 * Petit automate : confirmation → nom → téléphone → adresse → ville → paiement.
 */
export async function handleInboundMessage(event: any) {
  const psid: string | undefined = event.sender?.id;
  if (!psid || psid === state.selectedPageId) return;
  const text: string = event.message?.text ?? event.postback?.title ?? '';
  const payload: string | undefined = event.message?.quick_reply?.payload ?? event.postback?.payload;
  if (event.message?.is_echo) return;

  let conv = state.conversations[psid];
  const file = saveEvidence('T10', `inbound_${psid.slice(-6)}`, event);
  if (!conv) {
    recordTest('T10', { evidenceFile: file, note: `Message reçu d'un PSID non lié à un commentaire (${text.slice(0, 40)}).` });
    emit('message', { psid, text, linked: false });
    return;
  }
  conv.lastInboundAt = new Date().toISOString();
  emit('message', { psid, text, payload, linked: true });

  const intents = conv.intentIds.map((id) => state.intents.find((i) => i.id === id)).filter(Boolean) as Intent[];
  const reply = (message: Record<string, unknown>) => send({ id: psid }, message).catch((e) => log('warn', `Envoi Messenger : ${e.message}`));

  if (payload?.startsWith('CANCEL:') || /^annul/i.test(text)) {
    for (const i of intents) { releaseIntent(i); i.status = 'CANCELLED'; emit('intent', i); }
    conv.step = 'CANCELLED';
    await reply({ text: 'Votre demande est annulée. À bientôt sur nos lives !' });
  } else if (conv.step === 'AWAIT_CONFIRM') {
    if (payload?.startsWith('CONFIRM:') || /^(oui|ok|confirm|eny|ekena)/i.test(text)) {
      recordTest('T10', { evidenceFile: file, note: 'Confirmation reçue par webhook et reliée au commentaire d’origine via le PSID.' });
      conv.step = 'ASK_NAME';
      await reply({ text: 'Merci ! Pour la livraison, quel est votre nom complet ?' });
    } else {
      await reply({ text: 'Souhaitez-vous confirmer votre commande ?', quick_replies: quick([['✅ Confirmer', `CONFIRM:${conv.intentIds.at(-1)}`], ['❌ Annuler', `CANCEL:${conv.intentIds.at(-1)}`]]) });
    }
  } else if (conv.step === 'ASK_NAME') {
    conv.customer.name = text.trim();
    conv.step = 'ASK_PHONE';
    await reply({ text: 'Votre numéro de téléphone ?' });
  } else if (conv.step === 'ASK_PHONE') {
    conv.customer.phone = text.replace(/[^\d+]/g, '');
    conv.step = 'ASK_ADDRESS';
    await reply({ text: 'Votre adresse de livraison (quartier, repère) ?' });
  } else if (conv.step === 'ASK_ADDRESS') {
    conv.customer.address = text.trim();
    conv.step = 'ASK_CITY';
    await reply({ text: 'Votre ville ?' });
  } else if (conv.step === 'ASK_CITY') {
    conv.customer.city = text.trim();
    conv.step = 'ASK_PAYMENT';
    await reply({
      text: 'Mode de paiement ?',
      quick_replies: quick([['MVola', 'PAY:MVOLA'], ['Orange Money', 'PAY:ORANGE_MONEY'], ['Airtel Money', 'PAY:AIRTEL_MONEY'], ['À la livraison', 'PAY:COD'], ['Retrait boutique', 'PAY:PICKUP']]),
    });
  } else if (conv.step === 'ASK_PAYMENT') {
    conv.customer.payment = payload?.startsWith('PAY:') ? payload.slice(4) : text.trim();
    conv.step = 'DONE';
    for (const i of intents) if (i.status === 'RESERVED') { i.status = 'CONFIRMED'; emit('intent', i); }
    const total = intents.filter((i) => i.status === 'CONFIRMED').reduce((s, i) => s + (findProduct(i.code!)?.priceMga ?? 0) * i.quantity, 0);
    recordTest('T10', { status: 'OK', evidenceFile: file, note: `Parcours complet : commande confirmée pour ${conv.customer.name}, total ${formatMga(total)}.` });
    await reply({ text: `✅ Commande confirmée !\n\n${intents.map(summary).join('\n\n')}\n\nTotal : ${formatMga(total)}\nLivraison : ${conv.customer.address}, ${conv.customer.city}\nPaiement : ${conv.customer.payment}\n\nNous vous recontactons pour la livraison. Misaotra !` });
  }
  conv.updatedAt = new Date().toISOString();
  persist();
  emit('conversation', conv);
}

/** Envoi libre depuis le tableau de bord (dans la fenêtre de 24 h). */
export async function sendManualMessage(psid: string, text: string) {
  return send({ id: psid }, { text });
}
