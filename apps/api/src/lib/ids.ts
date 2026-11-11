import { monotonicFactory } from 'ulid';

const next = monotonicFactory();
/** Identifiant ULID (26 caractères, triable par date). */
export const newId = () => next();
