import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { configExists, createDefaultConfig, loadConfig, saveConfig } from '@current/config';
import { createDb } from './db/client.js';
import { createAppContext } from './create-context.js';
import { buildApp } from './app.js';

async function main() {
  const configPath = process.env.CURRENT_CONFIG_PATH ?? join(process.cwd(), 'config/current.config.json');

  if (!configExists(configPath)) {
    mkdirSync(dirname(configPath), { recursive: true });
    const defaultConfig = createDefaultConfig({});
    saveConfig(configPath, defaultConfig);
  }

  const config = loadConfig(configPath);
  const db = createDb(config.storage.sqlitePath);
  const context = createAppContext({
    db,
    config,
    configPath,
  });

  const app = buildApp(context);

  const host = config.server.host;
  const port = config.server.port;

  await app.listen({
    host,
    port,
  });

  app.log.info(`Current server running at ${config.server.publicUrl}`);

  const shutdown = async (signal: string) => {
    app.log.info(`Shutting down due to ${signal}`);
    await app.close();
    db.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
