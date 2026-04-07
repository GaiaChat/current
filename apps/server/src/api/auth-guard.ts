import type { FastifyReply, FastifyRequest } from 'fastify';
import type { CurrentUser } from '@current/types';

declare module 'fastify' {
  interface FastifyRequest {
    currentUser: CurrentUser | null;
  }
}

export async function attachCurrentUser(request: FastifyRequest): Promise<void> {
  const app = request.server;
  const token = request.cookies.current_session;
  request.currentUser = app.appContext.auth.getUserBySession(token);
  if (request.currentUser) {
    app.appContext.members.recordClientIp(request.currentUser.id, request.ip);
  }
}

export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!request.currentUser) {
    reply.code(401).send({
      error: {
        code: 'UNAUTHORIZED',
        message: 'Authentication required.',
      },
    });
    return;
  }
}
