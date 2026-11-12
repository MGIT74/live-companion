import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { log } from './bus.ts';
import { config } from './config.ts';
import { currentShopId, persist, state, type Product } from './store.ts';

/**
 * Catalogue géré depuis l'écran (et non plus seulement products.json).
 * Le catalogue vit dans data/state.json (volume persistant) ; l'ordre des produits
 * est l'ordre de passage pendant le live.
 */

export interface ProductInput {
  /** Code d'origine quand on modifie un produit (permet de changer son code). */
  originalCode?: string;
  code: string;
  name: string;
  priceMga: number;
  variants: { label: string; stock: number }[];
}

const CODE_RE = /^[A-Z]{1,4}\d{1,4}$/;

function clean(input: ProductInput) {
  const code = String(input.code ?? '').trim().toUpperCase().replace(/[\s-]/g, '');
  if (!CODE_RE.test(code)) throw new Error('Code au format JP01, RB02, SAC10… (lettres puis chiffres)');
  const name = String(input.name ?? '').trim();
  if (!name) throw new Error('Nom du produit requis');
  const priceMga = Math.round(Number(input.priceMga));
  if (!Number.isFinite(priceMga) || priceMga < 0) throw new Error('Prix invalide');
  const raw = Array.isArray(input.variants) && input.variants.length ? input.variants : [{ label: 'Unique', stock: 0 }];
  const variants = raw
    .map((v) => ({ label: String(v.label ?? '').trim() || 'Unique', stock: Math.max(0, Math.floor(Number(v.stock) || 0)) }));
  const labels = variants.map((v) => v.label.toUpperCase());
  if (new Set(labels).size !== labels.length) throw new Error('Deux tailles ou couleurs ont le même nom');
  if (variants.length > 30) throw new Error('30 tailles ou couleurs maximum');
  return { code, name, priceMga, variants };
}

/** Crée ou modifie un produit. Les quantités réservées sont conservées par taille. */
export function saveProduct(input: ProductInput): Product {
  const p = clean(input);
  const original = input.originalCode ? state.products.find((x) => x.code === input.originalCode) : undefined;
  if (input.originalCode && !original) throw new Error('Produit introuvable');
  const clash = state.products.find((x) => x.code === p.code && x !== original);
  if (clash) throw new Error(`Le code ${p.code} est déjà utilisé`);

  if (original) {
    const used = state.intents.some((i) => i.code === original.code && ['RESERVED', 'CONFIRMED', 'NEEDS_REVIEW', 'WAITLISTED'].includes(i.status));
    if (original.code !== p.code && used) throw new Error('Ce produit a des commandes en cours : son code ne peut pas changer pendant le live');
    const variants = p.variants.map((v) => {
      const prev = original.variants.find((x) => x.label.toUpperCase() === v.label.toUpperCase());
      const reserved = prev?.reserved ?? 0;
      if (v.stock < reserved) throw new Error(`${v.label} : ${reserved} déjà commandé(s), le stock ne peut pas être inférieur`);
      return { label: v.label, stock: v.stock, reserved };
    });
    for (const prev of original.variants) {
      if (prev.reserved > 0 && !variants.some((v) => v.label.toUpperCase() === prev.label.toUpperCase())) {
        throw new Error(`${prev.label} a des commandes en cours : impossible de la supprimer`);
      }
    }
    Object.assign(original, { code: p.code, name: p.name, priceMga: p.priceMga, variants });
    persist();
    log('info', `Produit ${p.code} modifié`);
    return original;
  }

  const product: Product = { ...p, variants: p.variants.map((v) => ({ ...v, reserved: 0 })) };
  state.products.push(product);
  persist();
  log('info', `Produit ${p.code} ajouté au catalogue`);
  return product;
}

export function deleteProduct(code: string) {
  const idx = state.products.findIndex((x) => x.code === code);
  if (idx < 0) throw new Error('Produit introuvable');
  if (state.products[idx].variants.some((v) => v.reserved > 0)) throw new Error('Ce produit a des commandes en cours : rejetez-les ou annulez-les avant de le supprimer');
  removePhotoFile(state.products[idx].photo);
  state.products.splice(idx, 1);
  persist();
  log('info', `Produit ${code} supprimé`);
}

/** Déplace un produit dans l'ordre de passage. */
export function moveProduct(code: string, dir: 'up' | 'down') {
  const i = state.products.findIndex((x) => x.code === code);
  if (i < 0) throw new Error('Produit introuvable');
  const j = dir === 'up' ? i - 1 : i + 1;
  if (j < 0 || j >= state.products.length) return;
  [state.products[i], state.products[j]] = [state.products[j], state.products[i]];
  persist();
}

// ---------------------------------------------------------------- Photos
fs.mkdirSync(config.photosDir, { recursive: true });
const TYPES: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const MAX_BYTES = 4 * 1024 * 1024;

function removePhotoFile(photo?: string) {
  // /photos/<boutique>/<fichier> (ou /photos/<fichier> pour les photos d'avant les comptes)
  const rel = photo?.match(/^\/photos\/((?:[a-f0-9]{24}\/)?[\w-]+\.(?:jpg|png|webp))$/)?.[1];
  if (rel) fs.rm(path.join(config.photosDir, rel), { force: true }, () => {});
}

/** Enregistre la photo d'un produit (data URL envoyée par l'écran, déjà réduite côté navigateur). */
export function setProductPhoto(code: string, dataUrl: string) {
  const p = state.products.find((x) => x.code === code);
  if (!p) throw new Error('Produit introuvable');
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl ?? ''));
  if (!m) throw new Error('Photo invalide (JPEG, PNG ou WebP)');
  const buf = Buffer.from(m[2], 'base64');
  if (!buf.length || buf.length > MAX_BYTES) throw new Error('Photo trop lourde (4 Mo maximum)');
  const shopId = currentShopId()!;
  const name = `${p.code.toLowerCase()}-${crypto.randomBytes(6).toString('hex')}.${TYPES[m[1]]}`;
  fs.mkdirSync(path.join(config.photosDir, shopId), { recursive: true });
  fs.writeFileSync(path.join(config.photosDir, shopId, name), buf);
  removePhotoFile(p.photo);
  p.photo = `/photos/${shopId}/${name}`;
  persist();
  log('info', `Photo du produit ${p.code} enregistrée`);
  return p;
}

export function removeProductPhoto(code: string) {
  const p = state.products.find((x) => x.code === code);
  if (!p) throw new Error('Produit introuvable');
  removePhotoFile(p.photo);
  p.photo = undefined;
  persist();
  return p;
}
