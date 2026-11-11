import { EventEmitter } from 'node:events';

/** Bus d'événements interne, relayé au tableau de bord en Server-Sent Events. */
export const bus = new EventEmitter();
bus.setMaxListeners(100);

let seq = 0;
export function emit(type: string, data: unknown) {
  bus.emit('event', { seq: ++seq, type, at: new Date().toISOString(), data });
}

export function log(level: 'info' | 'warn' | 'error', message: string, extra?: unknown) {
  const line = `[${new Date().toISOString()}] ${level.toUpperCase()} ${message}`;
  (level === 'error' ? console.error : console.log)(line, extra ?? '');
  emit('log', { level, message, extra });
}
