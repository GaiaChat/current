import type { AppContext } from './context.js';

declare module 'fastify' {
  interface FastifyInstance {
    appContext: AppContext;
  }
}
