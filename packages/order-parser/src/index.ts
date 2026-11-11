/**
 * Parseur d'intentions d'achat pour les commentaires Facebook Live.
 *
 * Règles de sécurité :
 *  - On ne devine jamais un produit : un "+1" sans commentaire parent fiable
 *    est renvoyé en type "plus" et c'est à l'appelant de vérifier le parent.
 *  - Toute ambiguïté (plusieurs codes, code inconnu, code seul, quantité
 *    excessive, variante inconnue) part en "ambiguous" pour validation humaine.
 *  - Une question ("JP01 prix ?") n'est pas une commande.
 */

export type ParseResult =
  | { type: 'order'; code: string; quantity: number; variant?: string }
  | { type: 'plus'; quantity: number; variant?: string }
  | { type: 'ambiguous'; reason: AmbiguityReason; code?: string; quantity?: number; variant?: string }
  | { type: 'none'; reason?: 'question' | 'no_signal' | 'zero_quantity' };

export type AmbiguityReason =
  | 'multiple_codes'
  | 'unknown_code'
  | 'code_without_quantity'
  | 'quantity_too_high'
  | 'unknown_variant';

export interface ParseOptions {
  /** Codes produits de la session (ex. ["JP01", "RB02"]). Si absent, tout code bien formé est accepté. */
  knownCodes?: string[];
  /** Variantes connues par code (ex. { JP01: ["S", "M", "L"] }). */
  variants?: Record<string, string[]>;
  /** Au-delà, la demande est envoyée en validation. Défaut : 10. */
  maxQuantity?: number;
}

// Nombres écrits en français et en malgache.
const NUMBER_WORDS: Record<string, number> = {
  UN: 1, UNE: 1, DEUX: 2, TROIS: 3, QUATRE: 4, CINQ: 5,
  IRAY: 1, ISA: 1, ROA: 2, TELO: 3, EFATRA: 4, DIMY: 5,
};

// Mots qui signalent une intention d'achat (FR + MG), sans quantité explicite → 1.
const BUY_WORDS = [
  'MAKA', 'HAKA', 'ALAINA', 'TE', 'TIAKO', 'COMMANDE', 'COMMANDER', 'JE PRENDS', 'JE PREND',
  'RESERVE', 'RESERVER', 'RESERVEZ', 'POUR MOI', 'HO AN AHY', 'HOANAHY', 'PRIS', 'PRENDS',
];

// Mots qui signalent une question.
const QUESTION_WORDS = [
  'PRIX', 'COMBIEN', 'OHATRINONA', 'HOATRINONA', 'MBOLA MISY', 'DISPO', 'DISPONIBLE',
  'TAILLE', 'QUELLE', 'QUEL', 'AZO', 'MISY VE', 'VE',
];

const CODE_RE = /\b([A-Z]{1,4})\s?-?(\d{2,3})\b/g;

export function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/['’`]/g, ' ')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function hasWord(text: string, words: string[]): boolean {
  return words.some((w) => new RegExp(`(^|[^A-Z])${w}([^A-Z]|$)`).test(text));
}

function findVariant(rest: string, candidates: string[] | undefined): { variant?: string; unknown?: boolean } {
  const tokens = rest.split(/[\s,;/]+/).filter(Boolean);
  if (candidates && candidates.length) {
    const upper = candidates.map((c) => normalize(c));
    // Variante multi-mots (ex. "BLANC L") en priorité.
    const joined = ` ${tokens.join(' ')} `;
    const multi = upper
      .map((u, i) => ({ u, i }))
      .filter(({ u }) => u.includes(' ') && joined.includes(` ${u} `));
    if (multi.length === 1) return { variant: candidates[multi[0].i] };
    const hits = tokens.map((t) => upper.indexOf(t)).filter((i) => i >= 0);
    const unique = [...new Set(hits)];
    if (unique.length === 1) return { variant: candidates[unique[0]] };
    if (unique.length > 1) return { unknown: true };
  }
  // Taille vêtement plausible mais non déclarée pour ce produit.
  const sizeLike = tokens.find((t) => /^(XXS|XS|S|M|L|XL|XXL|XXXL|\d{2})$/.test(t));
  if (sizeLike && candidates && candidates.length) return { unknown: true };
  if (sizeLike && !candidates) return { variant: sizeLike };
  return {};
}

function findQuantity(rest: string): number | undefined {
  // +2, + 2, x2, X 2, *2
  const explicit = rest.match(/(?:^|\s)[+X*]\s?(\d{1,3})(?=\s|$)/);
  if (explicit) return Number(explicit[1]);
  // "2" isolé (pas une taille à 2 chiffres comme 38)
  const bare = rest.match(/(?:^|\s)(\d)(?=\s|$)/);
  if (bare) return Number(bare[1]);
  for (const [word, n] of Object.entries(NUMBER_WORDS)) {
    if (new RegExp(`(^|\\s)${word}(\\s|$)`).test(rest)) return n;
  }
  if (/(?:^|\s)\+(?=\s|$)/.test(rest)) return 1; // "JP01 +"
  return undefined;
}

export function parseOrder(raw: string, options: ParseOptions = {}): ParseResult {
  const maxQuantity = options.maxQuantity ?? 10;
  const text = normalize(raw);
  if (!text) return { type: 'none', reason: 'no_signal' };

  const known = options.knownCodes?.map((c) => normalize(c).replace(/[\s-]/g, ''));
  const codes = [...text.matchAll(CODE_RE)].map((m) => ({
    code: `${m[1]}${m[2]}`,
    index: m.index ?? 0,
    length: m[0].length,
  }));
  // Si une liste de codes est fournie, un code inconnu n'est retenu que s'il est accompagné
  // d'un signal de commande explicite (+1, x2) : "tel 034 12..." n'est pas une commande.
  const relevant = known ? codes.filter((c) => known.includes(c.code)) : codes;
  const explicitSignal = /(?:^|\s|\d)[+X*]\s?\d{1,3}(?=\s|$)/.test(text);
  const pool = relevant.length ? relevant : explicitSignal ? codes : [];
  const distinct = [...new Set(pool.map((c) => c.code))];

  const isQuestion = text.includes('?') || hasWord(text, QUESTION_WORDS);

  if (distinct.length > 1) return { type: 'ambiguous', reason: 'multiple_codes' };

  if (distinct.length === 1) {
    const code = distinct[0];
    if (known && !known.includes(code)) return { type: 'ambiguous', reason: 'unknown_code', code };
    const hit = pool.find((c) => c.code === code)!;
    const rest = `${text.slice(0, hit.index)} ${text.slice(hit.index + hit.length)}`.replace(/\s+/g, ' ').trim();

    let quantity = findQuantity(rest);
    const buyWord = hasWord(text, BUY_WORDS);
    const variantInfo = findVariant(rest, options.variants?.[code]);

    if (quantity === undefined && isQuestion) return { type: 'none', reason: 'question' };
    if (quantity === undefined && buyWord) quantity = 1;
    if (quantity === undefined && variantInfo.variant) quantity = 1; // "JP01 M"
    if (quantity === undefined) return { type: 'ambiguous', reason: 'code_without_quantity', code };
    if (quantity === 0) return { type: 'none', reason: 'zero_quantity' };
    if (quantity > maxQuantity) return { type: 'ambiguous', reason: 'quantity_too_high', code, quantity };
    if (variantInfo.unknown) return { type: 'ambiguous', reason: 'unknown_variant', code, quantity };
    return variantInfo.variant
      ? { type: 'order', code, quantity, variant: variantInfo.variant }
      : { type: 'order', code, quantity };
  }

  // Pas de code : "+1", "+2 M", "maka", "x2"
  const plus = text.match(/^(?:MAKA |TE |JE PRENDS )?[+X]\s?(\d{1,3})(?:\s+(.*))?$/);
  if (plus) {
    const quantity = Number(plus[1]);
    if (quantity === 0) return { type: 'none', reason: 'zero_quantity' };
    if (quantity > maxQuantity) return { type: 'ambiguous', reason: 'quantity_too_high', quantity };
    const tail = (plus[2] ?? '').trim();
    const variant = tail ? findVariant(tail, undefined).variant : undefined;
    return variant ? { type: 'plus', quantity, variant } : { type: 'plus', quantity };
  }
  if (/^(MAKA|HAKA|TE|JE PRENDS|RESERVE|POUR MOI)!*$/.test(text)) return { type: 'plus', quantity: 1 };

  return { type: 'none', reason: isQuestion ? 'question' : 'no_signal' };
}

export interface MessageTag { offset?: number; length?: number; name?: string }

/**
 * Retire les mentions qu'ajoute Facebook quand on clique sur « Répondre »
 * (« Hands Graphic +1 » → « +1 »).
 *  1. Avec les message_tags de l'API (offset/length en unités UTF-16, comme les chaînes JS).
 *  2. Sinon, retire un nom connu (Page, auteur du commentaire parent) placé en début de message.
 */
export function stripMentions(message: string, tags: MessageTag[] = [], knownNames: string[] = []): string {
  let out = message;
  const spans = tags
    .filter((t) => Number.isInteger(t.offset) && Number.isInteger(t.length) && t.length! > 0)
    .sort((a, b) => b.offset! - a.offset!);
  for (const t of spans) {
    if (t.offset! + t.length! <= out.length) out = out.slice(0, t.offset!) + out.slice(t.offset! + t.length!);
  }
  if (!spans.length) {
    const lower = normalize(out);
    for (const name of knownNames.filter(Boolean).sort((a, b) => b.length - a.length)) {
      const n = normalize(name);
      if (n && lower.startsWith(n) && /^[\s,:@-]*/.test(lower.slice(n.length))) {
        out = out.slice(name.length);
        break;
      }
    }
  }
  return out.replace(/^[\s,:@-]+/, '').replace(/\s+/g, ' ').trim();
}

/** Texte du commentaire produit publié/épinglé pendant le live. */
export function formatProductComment(p: { code: string; name: string; priceMga: number }): string {
  return [
    `📌 ${p.code} — ${p.name.toUpperCase()}`,
    '',
    `💰 Prix : ${formatMga(p.priceMga)}`,
    '',
    '🛍️ Pour commander :',
    `Répondez +1 sous ce commentaire ou écrivez ${p.code} +1 dans le live.`,
  ].join('\n');
}

export function formatMga(amount: number): string {
  return `${String(Math.round(amount)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} Ar`;
}
