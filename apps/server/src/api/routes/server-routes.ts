import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth-guard.js';

const RegistrationModeSchema = z.object({
  registrationMode: z.enum(['invite_only', 'open_signup', 'manual_approval']),
});

export async function registerServerRoutes(app: FastifyInstance): Promise<void> {
  app.get('/server', { preHandler: [requireAuth] }, async () => {
    const server = app.appContext.serverConfig.get().server;
    const primary = app.appContext.setup.status();

    return {
      configured: primary.configured,
      server,
      serverId: primary.serverId,
    };
  });

  app.patch('/server/registration-mode', { preHandler: [requireAuth] }, async (request, reply) => {
    const parsed = RegistrationModeSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400).send({ error: parsed.error.flatten() });
      return;
    }

    const primary = app.appContext.setup.status();
    if (!primary.serverId) {
      reply.code(404).send({
        error: {
          code: 'SERVER_NOT_FOUND',
          message: 'Server is not configured yet.',
        },
      });
      return;
    }

    app.appContext.serverConfig.patchRegistrationMode(parsed.data.registrationMode);
    app.appContext.db
      .prepare('UPDATE servers SET registration_mode = ? WHERE id = ?')
      .run(parsed.data.registrationMode, primary.serverId);

    reply.send({
      registrationMode: parsed.data.registrationMode,
    });
  });
}
