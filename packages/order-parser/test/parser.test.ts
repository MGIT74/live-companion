import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOrder, formatMga, formatProductComment, type ParseOptions } from '../src/index.ts';

const opts: ParseOptions = {
  knownCodes: ['JP01', 'RB02', 'SAC10'],
  variants: { JP01: ['S', 'M', 'L', 'XL'], RB02: ['Rouge', 'Noir'] },
};

const cases: Array<[string, unknown]> = [
  // Commandes avec code
  ['JP01 +1', { type: 'order', code: 'JP01', quantity: 1 }],
  ['JP01 +2', { type: 'order', code: 'JP01', quantity: 2 }],
  ['jp01+2', { type: 'order', code: 'JP01', quantity: 2 }],
  ['JP01 1 M', { type: 'order', code: 'JP01', quantity: 1, variant: 'M' }],
  ['JP01 M', { type: 'order', code: 'JP01', quantity: 1, variant: 'M' }],
  ['jp 01 x3 L', { type: 'order', code: 'JP01', quantity: 3, variant: 'L' }],
  ['JP-01 +1 xl', { type: 'order', code: 'JP01', quantity: 1, variant: 'XL' }],
  ['maka JP01', { type: 'order', code: 'JP01', quantity: 1 }],
  ['Te hividy JP01 roa', { type: 'order', code: 'JP01', quantity: 2 }],
  ['je prends JP01 deux', { type: 'order', code: 'JP01', quantity: 2 }],
  ['RB02 +1 rouge', { type: 'order', code: 'RB02', quantity: 1, variant: 'Rouge' }],
  ['RB02 noir', { type: 'order', code: 'RB02', quantity: 1, variant: 'Noir' }],
  ['SAC10 +1', { type: 'order', code: 'SAC10', quantity: 1 }],
  ['  JP01   +1  ', { type: 'order', code: 'JP01', quantity: 1 }],
  ['JP01 +1 svp 🙏', { type: 'order', code: 'JP01', quantity: 1 }],
  ['Réservez JP01 pour moi', { type: 'order', code: 'JP01', quantity: 1 }],

  // "+1" sans code : dépend du commentaire parent
  ['+1', { type: 'plus', quantity: 1 }],
  ['+ 2', { type: 'plus', quantity: 2 }],
  ['+1 M', { type: 'plus', quantity: 1, variant: 'M' }],
  ['x2', { type: 'plus', quantity: 2 }],
  ['maka', { type: 'plus', quantity: 1 }],

  // Ambigus → validation par l'assistant
  ['JP01', { type: 'ambiguous', reason: 'code_without_quantity', code: 'JP01' }],
  ['JP01 +1 RB02 +1', { type: 'ambiguous', reason: 'multiple_codes' }],
  ['ZZ99 +1', { type: 'ambiguous', reason: 'unknown_code', code: 'ZZ99' }],
  ['JP01 +50', { type: 'ambiguous', reason: 'quantity_too_high', code: 'JP01', quantity: 50 }],
  ['JP01 +1 XXL', { type: 'ambiguous', reason: 'unknown_variant', code: 'JP01', quantity: 1 }],
  ['+40', { type: 'ambiguous', reason: 'quantity_too_high', quantity: 40 }],

  // Pas des commandes
  ['JP01 prix ?', { type: 'none', reason: 'question' }],
  ['Ohatrinona ny JP01', { type: 'none', reason: 'question' }],
  ['JP01 mbola misy ve?', { type: 'none', reason: 'question' }],
  ['Trop beau !', { type: 'none', reason: 'no_signal' }],
  ['❤️❤️❤️', { type: 'none', reason: 'no_signal' }],
  ['Bonjour de Toamasina', { type: 'none', reason: 'no_signal' }],
  ['Combien la livraison ?', { type: 'none', reason: 'question' }],
  ['JP01 +0', { type: 'none', reason: 'zero_quantity' }],
  ['', { type: 'none', reason: 'no_signal' }],
  ['Merci 1000 fois', { type: 'none', reason: 'no_signal' }],
  ['J’adore', { type: 'none', reason: 'no_signal' }],
  ['Live 2026 super', { type: 'none', reason: 'no_signal' }],
  ['tel 034 12 345 67', { type: 'none', reason: 'no_signal' }],
];

for (const [input, expected] of cases) {
  test(`parseOrder(${JSON.stringify(input)})`, () => {
    assert.deepEqual(parseOrder(input, opts), expected);
  });
}

test('sans liste de codes, un code bien formé est accepté', () => {
  assert.deepEqual(parseOrder('AB12 +1'), { type: 'order', code: 'AB12', quantity: 1 });
});

test('formatMga', () => {
  assert.equal(formatMga(35000), '35 000 Ar');
  assert.equal(formatMga(1250000), '1 250 000 Ar');
});

test('formatProductComment', () => {
  const text = formatProductComment({ code: 'JP01', name: 'Jean blanc', priceMga: 35000 });
  assert.match(text, /JP01 — JEAN BLANC/);
  assert.match(text, /Répondez \+1 sous ce commentaire ou écrivez JP01 \+1/);
});
