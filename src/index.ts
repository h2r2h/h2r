import { config } from './config.js';
import { rabbitmq } from './rabbitmq.js';
import { startAdminServer } from './metrics.js';
import { startServer } from './server.js';
import { logger } from './logger.js';
import { loadPlugin } from './plugin.js';
import type { FastifyInstance } from 'fastify';

let server: FastifyInstance | null = null;
let adminServer: FastifyInstance | null = null;
let shuttingDown = false;

async function main(): Promise<void> {
  logger.info({
    version: process.env.VERSION || 'v0.0.0',
    commit_hash: process.env.COMMIT_HASH || '00000000-dirty',
    build_timestamp: process.env.BUILD_TIMESTAMP || '1970-01-01T00:00:00+00:00',
  }, 'startup');

  logger.info({
    exchange: config.RABBITMQ_EXCHANGE || '(default)',
    routing_key: config.RABBITMQ_ROUTING_KEY || '(none)',
    channel_pool_size: config.CHANNEL_POOL_SIZE,
    plugin_path: config.PLUGIN_PATH || '(none)',
  }, 'config_loaded');

  await loadPlugin();
  await rabbitmq.connect();

  adminServer = await startAdminServer();

  server = await startServer();

  setupShutdownHandlers();

  logger.info('service_ready');
}

function setupShutdownHandlers(): void {
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info({ signal }, 'shutdown_started');

    if (server) {
      await server.close();
      logger.info('http_server_closed');
    }

    if (adminServer) {
      await adminServer.close();
      logger.info('admin_server_closed');
    }

    await rabbitmq.waitForInflight();
    await rabbitmq.close();
    logger.info('rabbitmq_connection_closed');

    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  logger.error({ err }, 'fatal_error');
  process.exit(1);
});
