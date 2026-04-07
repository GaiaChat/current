import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../auth-guard.js';

export async function registerMemberRoutes(app: FastifyInstance): Promise<void> {
  app.get('/members', { preHandler: [requireAuth] }, async () => {
    const status = app.appContext.setup.status();
    return app.appContext.members.listMembers(status.serverId);
  });
}
