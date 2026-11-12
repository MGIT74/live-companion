/**
 * Nettoie un nom saisi par le client sur Messenger :
 * « mon nom c'est Eric malalaharijaona » → « Eric Malalaharijaona ».
 */
const PREFIXES = [
  /^(bonjour|salut|bonsoir|salama|manao ahoana)[,!. ]+/i,
  /^(mon nom (complet )?(c['’]est|est)|je m['’]appelle|je suis|moi c['’]est|c['’]est|nom( complet)?\s*[:=-]?|my name is|izaho dia|ny anarako dia|ny anarako|anarako)\s*[:,-]?\s*/i,
];

export function cleanName(raw: string | undefined | null): string {
  let s = String(raw ?? '').replace(/\s+/g, ' ').trim();
  for (let k = 0; k < 2; k++) for (const re of PREFIXES) s = s.replace(re, '').trim();
  s = s.replace(/[.!]+$/, '').trim();
  if (!s) return String(raw ?? '').trim();
  // Majuscule à chaque mot (garde les particules courtes en minuscule sauf en tête).
  return s.split(' ').map((w, i) => (i > 0 && /^(de|du|des|la|le|d['’])$/i.test(w) ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())).join(' ').slice(0, 80);
}
