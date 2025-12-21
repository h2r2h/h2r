import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyReply } from 'fastify';
import { config } from './config.js';
import { rabbitmq } from './rabbitmq.js';
import { logger, shouldLogRequest } from './logger.js';
import { applyPlugin } from './plugin.js';
import { getClientIp } from './utils.js';

export interface HttpMessage {
  method: string;
  url: string;
  headers: Record<string, string[]>;
  body: string;
  bodyEncoding?: 'utf8' | 'base64';
}

export interface Metadata {
  metadata_version: 'v1';
  created_at: string;
  traceparent?: string;
  message_type: 'h2r';
  message_version: 'v1';
}

export interface Envelope {
  metadata: Metadata;
  content: HttpMessage;
}

export function buildServer(): FastifyInstance {
  const server = Fastify({
    logger: false,
    disableRequestLogging: true,
    bodyLimit: config.MAX_BODY_SIZE,
  });

  server.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => {
    done(null, body);
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

  server.all('/*', async (request, reply) => {
    if (!rabbitmq.isConnected()) {
      return reply.status(503).send({ error: 'RabbitMQ unavailable' });
    }

    const { body, encoding } = encodeBody(request.body);
    const headers = normalizeHeaders(request.headers);
    const traceparent = headers['traceparent']?.[0];

    let pluginResult;
    try {
      pluginResult = await applyPlugin({
        method: request.method,
        url: request.url,
        headers,
        body,
        bodyEncoding: encoding,
      });
    } catch (err) {
      logger.error({ err, method: request.method, path: request.url }, 'plugin_error');
      return reply.status(500).send({ error: 'Plugin error' });
    }

    if (!pluginResult.publish) {
      logger.info({ reason: pluginResult.reason, method: request.method, path: request.url }, 'request_filtered');
      return reply.status(pluginResult.statusCode ?? 200).send(pluginResult.response ?? { status: 'filtered' });
    }

    const envelope: Envelope = {
      metadata: {
        metadata_version: 'v1',
        created_at: new Date().toISOString(),
        ...(traceparent && { traceparent }),
        message_type: 'h2r',
        message_version: 'v1',
      },
      content: {
        method: request.method,
        url: request.url,
        headers,
        body,
        bodyEncoding: encoding,
      },
    };

    let buffer: Buffer;
    try {
      buffer = Buffer.from(JSON.stringify(envelope));
    } catch (err) {
      logger.error({ err, method: request.method, path: request.url }, 'envelope_serialization_failed');
      return reply.status(500).send({ error: 'Serialization failed' });
    }

    try {
      await rabbitmq.publish(buffer, pluginResult.exchange, pluginResult.routingKey);
      return reply.status(pluginResult.statusCode ?? 202).send(pluginResult.response ?? { status: 'accepted' });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      if (errorMessage.includes('Backpressure')) {
        return reply.status(503).send({ error: 'Service overloaded' });
      }
      logger.error({ err, method: request.method, path: request.url }, 'publish_failed');
      return reply.status(500).send({ error: 'Publish failed' });
    }
  });

  return server;
}

interface EncodedBody {
  body: string;
  encoding: 'utf8' | 'base64';
}

function encodeBody(body: unknown): EncodedBody {
  if (body === undefined || body === null) {
    return { body: '', encoding: 'utf8' };
  }
  if (typeof body === 'string') {
    return { body, encoding: 'utf8' };
  }
  if (Buffer.isBuffer(body)) {
    if (isUtf8(body)) {
      return { body: body.toString('utf8'), encoding: 'utf8' };
    }
    return { body: body.toString('base64'), encoding: 'base64' };
  }
  return { body: JSON.stringify(body), encoding: 'utf8' };
}

const utf8Decoder = new TextDecoder('utf-8', { fatal: true });
const MAX_UTF8_CHECK_SIZE = 8 * 1024 * 1024;

function isUtf8(buffer: Buffer): boolean {
  if (buffer.length > MAX_UTF8_CHECK_SIZE) {
    return false;
  }

  try {
    utf8Decoder.decode(buffer);
    return true;
  } catch {
    return false;
  }
}

function normalizeHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    result[key] = Array.isArray(value) ? value : [value];
  }
  return result;
}

export async function startServer(): Promise<FastifyInstance> {
  const server = buildServer();

  await server.listen({ port: config.PORT, host: config.HOST });
  logger.info({ host: config.HOST, port: config.PORT }, 'http_server_started');

  return server;
}
