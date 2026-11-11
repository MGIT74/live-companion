import type { Request, Response } from 'express';
import { config } from './config.ts';
import { verifyMetaSignature } from './crypto.ts';
import { log } from './bus.ts';
import { saveEvidence } from './evidence.ts';
import { ingestComment } from './ingestion.ts';
import { handleInboundMessage } from './messenger.ts';
import { recordTest, state } from './store.ts';

/** GET /webhooks/meta — vérification de l'abonnement par Meta. */
export function verifyWebhook(req: Request, res: Response) {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  if (mode === 'subscribe' && token === config.webhookVerifyToken) {
    log('info', 'Webhook vérifié par Meta.');
    res.status(200).send(String(req.query['hub.challenge']));
  } else {
    res.sendStatus(403);
  }
}

/** POST /webhooks/meta — répond 200 tout de suite, traite ensuite. */
export function receiveWebhook(req: Request, res: Response) {
  const raw = req.body as Buffer;
  if (!verifyMetaSignature(raw, req.header('x-hub-signature-256'))) {
    log('warn', 'Webhook rejeté : signature invalide.');
    res.sendStatus(401);
    return;
  }
  res.sendStatus(200);

  let body: any;
  try { body = JSON.parse(raw.toString('utf8')); } catch { return; }
  if (body.object !== 'page') return;

  for (const entry of body.entry ?? []) {
    for (const event of entry.messaging ?? []) {
      handleInboundMessage(event).catch((e) => log('error', `Traitement message : ${e.message}`));
    }
    for (const change of entry.changes ?? []) {
      if (change.field !== 'feed') continue;
      const v = change.value ?? {};
      if (v.item !== 'comment' || v.verb !== 'add') continue;
      const file = saveEvidence('T7', 'webhook_feed_comment', change);
      recordTest('T7', { evidenceFile: file });
      const live = state.activeLive;
      if (!live) continue;
      // post_id = "<pageId>_<objectId>". On n'ingère que les commentaires du live suivi.
      const objectId = String(v.post_id ?? '').split('_').pop();
      if (objectId !== live.id && objectId !== live.videoId) continue;
      ingestComment({
        id: v.comment_id,
        message: v.message,
        created_time: v.created_time ? new Date(v.created_time * 1000).toISOString() : undefined,
        from: v.from,
        parent_id: v.parent_id && v.parent_id !== v.post_id ? v.parent_id : undefined,
      }, live.id, 'WEBHOOK');
    }
  }
}
