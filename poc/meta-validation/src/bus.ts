import { EventEmitter } from 'node:events';

/** Bus d'événements interne, relayé au tableau de bord en Server-Sent Events (chaque boutique ne reçoit que les siens). */
export const bus = new EventEmitter();
bus.setMaxListeners(1000);

/** Rempli par store.ts : identifiant de la boutique en cours (évite un import circulaire). */
export const shopContext = { current: (): string | undefined => undefined };

let seq = 0;
export function emit(type: string, data: unknown) {
  bus.emit('event', { seq: ++seq, shopId: shopContext.current(), type, at: new Date().toISOString(), data });
}

export function log(level: 'info' | 'warn' | 'error', message: string, extra?: unknown) {
  const shop = shopContext.current();
  const line = `[${new Date().toISOString()}] ${level.toUpperCase()}${shop ? ` [${shop.slice(0, 6)}]` : ''} ${message}`;
  (level === 'error' ? console.error : console.log)(line, extra ?? '');
  emit('log', { level, message, extra });
}

