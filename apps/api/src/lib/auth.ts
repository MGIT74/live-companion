import fjwt from '@fastify/jwt';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { env } from './env.ts';
import { AppError } from './errors.ts';

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { sub: string; adm?: boolean };
    user: { sub: string; adm?: boolean };
  }
}

export async function registerAuth(app: FastifyInstance) {
  await app.register(fjwt, { secret: env.JWT_SECRET, sign: { expiresIn: '30d' } });
}

export async function authenticate(req: FastifyRequest, _reply: FastifyReply) {
  try {
    await req.jwtVerify();
  } catch {
    throw new AppError(401, 'UNAUTHENTICATED', 'Connexion requise');
  }
}
