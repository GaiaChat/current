import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import type { AppContext } from './types/context.js';
import { attachCurrentUser } from './api/auth-guard.js';
import { registerSetupRoutes } from './api/routes/setup-routes.js';
import { registerAuthRoutes } from './api/routes/auth-routes.js';
import { registerServerRoutes } from './api/routes/server-routes.js';
import { registerMemberRoutes } from './api/routes/member-routes.js';
import { registerChatRoutes } from './api/routes/chat-routes.js';
import { registerModerationRoutes } from './api/routes/moderation-routes.js';
import { registerVoiceRoutes } from './api/routes/voice-routes.js';
import { registerMetricsRoutes } from './api/routes/metrics-routes.js';
import { registerAdminRoutes } from './api/routes/admin-routes.js';

export function buildApp(context: AppContext) {
  const app = Fastify({
    logger: {
      level: context.config.observability.logLevel,
    },
  });

  app.decorate('appContext', context);

  app.register(cors, {
    origin: true,
    credentials: true,
  });

  app.register(cookie, {
    secret: context.config.auth.cookieSecret,
    hook: 'onRequest',
  });

  app.register(multipart, {
    limits: {
      fileSize: context.config.media.maxAttachmentBytes,
    },
  });

  app.addHook('onRequest', attachCurrentUser);

  app.addHook('onResponse', async (_request, reply) => {
    context.metrics.recordRequest(reply.statusCode);
  });

  app.register(async (api) => {
    await registerMetricsRoutes(api);
    await registerSetupRoutes(api);
    await registerAuthRoutes(api);
    await registerServerRoutes(api);
    await registerMemberRoutes(api);
    await registerChatRoutes(api);
    await registerModerationRoutes(api);
    await registerVoiceRoutes(api);
    await registerAdminRoutes(api);
  }, { prefix: '/api/v1' });

  app.get('/', async () => {
    return {
      name: 'Current API',
      version: '0.1.0',
      docs: '/api/v1/health',
    };
  });

  context.gateway.attach(app.server);

  return app;
}
