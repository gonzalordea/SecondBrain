import type { FastifyRequest } from 'fastify';
import type { z } from 'zod';

export type Role = 'user' | 'admin';
export interface SessionUser { id: string; email: string; displayName: string; role: Role }

declare module 'fastify' {
  interface FastifyRequest {
    user: SessionUser | null;
    csrfToken: string | null;
  }
}

export class HttpError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// 404 (not 403) for resources owned by someone else, so ids can't be probed for existence.
export const notFound = (what = 'Recurso') => new HttpError(404, 'not_found', `${what} no encontrado`);

export function parse<S extends z.ZodType>(schema: S, data: unknown): z.infer<S> {
  return schema.parse(data); // ZodError is mapped to 400 by the global error handler
}

export function requireUser(req: FastifyRequest): SessionUser {
  if (!req.user) throw new HttpError(401, 'unauthenticated', 'Inicia sesión para continuar');
  return req.user;
}

export function requireAdmin(req: FastifyRequest): SessionUser {
  const user = requireUser(req);
  if (user.role !== 'admin') throw new HttpError(403, 'forbidden', 'Solo administradores');
  return user;
}
