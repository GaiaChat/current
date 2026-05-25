import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

const ClientPingSchema = z.object({
  clientId: z
    .string()
    .trim()
    .min(12)
    .max(128)
    .regex(/^[A-Za-z0-9._:-]+$/),
});

export async function registerClientRoutes(app: FastifyInstance): Promise<void> {
  app.post('/client/ping', async (request, reply) => {
    const parsed = ClientPingSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400).send({
        error: {
          code: 'INVALID_CLIENT_PING',
          message: 'Client ping requires a valid client id.',
        },
      });
      return;
    }

    return app.appContext.clientPresence.recordPing({
      clientId: parsed.data.clientId,
      userId: request.currentUser?.id,
    });
  });

  app.get('/client/usage', async () => app.appContext.clientPresence.snapshot());
}
