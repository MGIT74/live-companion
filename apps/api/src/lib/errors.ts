import type { FastifyError, FastifyInstance } from 'fastify';
import { ZodError } from 'zod';

export class AppError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}

export const notFound = (what = 'Ressource') => new AppError(404, 'NOT_FOUND', `${what} introuvable`);
export const forbidden = (msg = 'Action non autorisée pour votre rôle') => new AppError(403, 'FORBIDDEN', msg);
export const conflict = (code: string, msg: string, details?: unknown) => new AppError(409, code, msg, details);
export const badRequest = (code: string, msg: string, details?: unknown) => new AppError(400, code, msg, details);

/** MySQL : violation d'index unique. */
export function isDuplicate(e: unknown): boolean {
  const err = e as { code?: string; errno?: number; cause?: { code?: string } };
  return err?.code === 'ER_DUP_ENTRY' || err?.errno === 1062 || err?.cause?.code === 'ER_DUP_ENTRY';
}

export function registerErrorHandler(app: FastifyInstance) {
  app.setErrorHandler((error: FastifyError | AppError | ZodError, req, reply) => {
    if (error instanceof AppError) {
      return reply.status(error.status).send({ error: error.code, message: error.message, details: error.details });
    }
    if (error instanceof ZodError || (error as FastifyError).validation || (error as FastifyError).code === 'FST_ERR_VALIDATION') {
      return reply.status(400).send({ error: 'VALIDATION', message: 'Données invalides', details: (error as ZodError).issues ?? (error as FastifyError).validation });
    }
    if ((error as FastifyError).statusCode && (error as FastifyError).statusCode! < 500) {
      return reply.status((error as FastifyError).statusCode!).send({ error: (error as FastifyError).code ?? 'ERROR', message: error.message });
    }
    if (isDuplicate(error)) return reply.status(409).send({ error: 'DUPLICATE', message: 'Cet élément existe déjà' });
    req.log.error(error);
    return reply.status(500).send({ error: 'INTERNAL', message: 'Erreur interne' });
  });
}
