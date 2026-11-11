import type { Tx } from '../db/client.ts';
import { db, schema } from '../db/client.ts';

/** Journal des événements commerciaux (distinct des messages Messenger). */
export async function audit(
  conn: Tx | typeof db,
  e: { shopId?: string; actorUserId?: string; action: string; entityType: string; entityId?: string; data?: unknown },
) {
  await conn.insert(schema.auditLogs).values({
    shopId: e.shopId, actorUserId: e.actorUserId, action: e.action,
    entityType: e.entityType, entityId: e.entityId, data: e.data ?? null,
  });
}
