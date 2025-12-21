import { Counter, Gauge, Histogram, Registry } from 'prom-client';
import Fastify, { type FastifyRequest, type FastifyReply } from 'fastify';
import { config } from './config.js';
import { logger, shouldLogRequest } from './logger.js';
import { getHealthCheck } from './health.js';
import { getClientIp } from './utils.js';

export const register = new Registry();

export const messagesPublished = new Counter({
  name: 'h2r_messages_published_total',
  help: 'Total messages published',
  registers: [register],
});

export const messagesFailed = new Counter({
  name: 'h2r_messages_failed_total',
  help: 'Total failed publishes',
  registers: [register],
});

export const publishDuration = new Histogram({
  name: 'h2r_publish_duration_seconds',
  help: 'Publish latency histogram',
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
  registers: [register],
});

export const rabbitmqConnected = new Gauge({
  name: 'h2r_rabbitmq_connected',
  help: 'RabbitMQ connection state (1=connected)',
  registers: [register],
});

export const inflightMessages = new Gauge({
  name: 'h2r_inflight_messages',
  help: 'Current in-flight publishes',
  registers: [register],
});

export async function startAdminServer(): Promise<ReturnType<typeof Fastify>> {
  const server = Fastify({
    logger: false,
    disableRequestLogging: true,
  });

  server.addHook('onResponse', (request: FastifyRequest, reply: FastifyReply, done) => {
    const path = request.url.split('?')[0];
    if (!shouldLogRequest(path, reply.statusCode)) {
      done();
      return;
    }

    const processTimeMs = reply.elapsedTime;
    logger.info({
      status_code: reply.statusCode,
      process_time_ms: Math.round(processTimeMs * 1000) / 1000,
      method: request.method,
      path: request.url,
      client_ip: getClientIp(request),
      user_agent: request.headers['user-agent'],
    }, 'access');
    done();
  });

  server.get('/healthz', async (_req, reply) => {
    const health = getHealthCheck();
    reply.status(health.connected ? 200 : 503);
    return health.status;
  });

  server.get('/metrics', async (_req, reply) => {
    reply.header('Content-Type', register.contentType);
    return register.metrics();
  });

  await server.listen({ port: config.ADMIN_PORT, host: config.HOST });
  logger.info({ host: config.HOST, port: config.ADMIN_PORT }, 'admin_server_started');
  return server;
}
