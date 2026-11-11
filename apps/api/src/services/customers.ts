import { and, eq, or } from 'drizzle-orm';
import type { Tx } from '../db/client.ts';
import { db, schema } from '../db/client.ts';
import { newId } from '../lib/ids.ts';

const c = schema.customers;

/** Normalise un numéro malgache : 034 12 345 67 / +261 34 12 345 67 → 0341234567. */
export function normalizePhone(raw?: string | null): string | undefined {
  if (!raw) return undefined;
  let d = raw.replace(/[^\d+]/g, '');
  if (d.startsWith('+261')) d = '0' + d.slice(4);
  else if (d.startsWith('261') && d.length === 12) d = '0' + d.slice(3);
  d = d.replace(/\+/g, '');
  return d.length >= 6 ? d : undefined;
}

export interface CustomerMatch {
  fullName?: string; phone?: string; fbUserId?: string; messengerPsid?: string; city?: string; address?: string;
}

/**
 * Retrouve un client existant (téléphone, puis identifiant Facebook, puis PSID Messenger)
 * ou le crée. Complète les champs manquants sans écraser ceux déjà saisis.
 */
export async function findOrCreateCustomer(shopId: string, m: CustomerMatch, conn?: Tx) {
  const x = conn ?? db;
  const phone = normalizePhone(m.phone);
  const keys = [
    phone ? eq(c.phone, phone) : undefined,
    m.fbUserId ? eq(c.fbUserId, m.fbUserId) : undefined,
    m.messengerPsid ? eq(c.messengerPsid, m.messengerPsid) : undefined,
  ].filter(Boolean);

  if (keys.length) {
    const [found] = await x.select().from(c).where(and(eq(c.shopId, shopId), or(...keys))).limit(1);
    if (found) {
      const patch: Partial<typeof c.$inferInsert> = {};
      if (!found.fullName && m.fullName) patch.fullName = m.fullName;
      if (!found.phone && phone) patch.phone = phone;
      if (!found.fbUserId && m.fbUserId) patch.fbUserId = m.fbUserId;
      if (!found.messengerPsid && m.messengerPsid) patch.messengerPsid = m.messengerPsid;
      if (!found.city && m.city) patch.city = m.city;
      if (!found.address && m.address) patch.address = m.address;
      if (Object.keys(patch).length) await x.update(c).set(patch).where(eq(c.id, found.id));
      return { ...found, ...patch, created: false };
    }
  }
  const row = {
    id: newId(), shopId, fullName: m.fullName, phone, fbUserId: m.fbUserId, messengerPsid: m.messengerPsid, city: m.city, address: m.address,
  };
  await x.insert(c).values(row);
  return { ...row, created: true };
}
