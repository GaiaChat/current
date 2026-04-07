import type { FastifyInstance } from 'fastify';

export async function registerMetricsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async () => ({ status: 'ok' }));

  app.get('/ready', async () => {
    const status = app.appContext.setup.status();
    return {
      status: status.configured ? 'ready' : 'setup_required',
      setup: status,
    };
  });

  app.get('/admin/metrics', async () => {
    return app.appContext.metrics.snapshot();
  });
}
