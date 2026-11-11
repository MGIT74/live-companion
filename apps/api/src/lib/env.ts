import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
dotenv.config({ path: [path.join(root, '.env'), path.join(root, '../../.env')], quiet: true } as dotenv.DotenvConfigOptions);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(4000),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL manquant (ex. mysql://user:pass@localhost:3306/live_companion)'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET doit faire au moins 32 caractères'),
  CORS_ORIGIN: z.string().default('*'),
  ALLOW_SIGNUP: z.enum(['true', 'false']).default('true'),
  WEB_DIR: z.string().optional(),
});

export const env = schema.parse(process.env);
