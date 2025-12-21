import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import amqp, { type ChannelModel, type Channel } from 'amqplib';
import type { FastifyInstance } from 'fastify';
import { setupRabbitMQ, teardownRabbitMQ, type RabbitMQTestContext } from '../fixtures/rabbitmq-test-helper.js';

const PUBLISH_EXCHANGE = 'publish';
const CONSUME_EXCHANGE = 'consume';
const ROUTING_KEY = 'my-user1.http.request';
const TEST_QUEUE = 'my-user1.http.test';

describe('h2r e2e', () => {
  let rabbitCtx: RabbitMQTestContext;
  let testConnection: ChannelModel;
  let testChannel: Channel;
  let server: FastifyInstance;

  beforeAll(async () => {
    rabbitCtx = await setupRabbitMQ();

    testConnection = await amqp.connect(rabbitCtx.config.amqpUrl);
    testChannel = await testConnection.createChannel();

    await testChannel.assertQueue(TEST_QUEUE, { durable: true });
    await testChannel.bindQueue(TEST_QUEUE, CONSUME_EXCHANGE, ROUTING_KEY);

    vi.resetModules();

    process.env.RABBITMQ_URL = rabbitCtx.config.amqpUrl;
    process.env.RABBITMQ_EXCHANGE = PUBLISH_EXCHANGE;
    process.env.RABBITMQ_ROUTING_KEY = ROUTING_KEY;
    process.env.PORT = '0';
    process.env.ADMIN_PORT = '0';
    process.env.CHANNEL_POOL_SIZE = '2';

    const { rabbitmq } = await import('../../src/rabbitmq.js');
    const { buildServer } = await import('../../src/server.js');

    await rabbitmq.connect();
    server = buildServer();
    await server.ready();
  }, 120000);

  afterAll(async () => {
    if (server) {
      await server.close();
    }

    vi.resetModules();
    const { rabbitmq } = await import('../../src/rabbitmq.js');
    await rabbitmq.close();

    await testChannel?.close();
    await testConnection?.close();

    await teardownRabbitMQ(rabbitCtx);
  });

  beforeEach(async () => {
    await testChannel.purgeQueue(TEST_QUEUE);
    vi.resetModules();
  });

  async function consumeMessage(timeoutMs = 5000): Promise<string | null> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const msg = await testChannel.get(TEST_QUEUE, { noAck: false });
      if (msg) {
        testChannel.ack(msg);
        return msg.content.toString();
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return null;
  }

  describe('POST requests', () => {
    it('should publish POST request to RabbitMQ', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/webhook/test',
        headers: { 'content-type': 'application/json' },
        payload: { event: 'test.event', data: { foo: 'bar' } },
      });

      expect(response.statusCode).toBe(202);

      const messageStr = await consumeMessage();
      expect(messageStr).not.toBeNull();

      const envelope = JSON.parse(messageStr!);
      expect(envelope.metadata.metadata_version).toBe('v1');
      expect(envelope.metadata.created_at).toBeDefined();
      expect(envelope.metadata.message_type).toBe('h2r');
      expect(envelope.metadata.message_version).toBe('v1');
      expect(envelope.content.method).toBe('POST');
      expect(envelope.content.url).toBe('/webhook/test');
      expect(envelope.content.headers['content-type']).toEqual(['application/json']);
      expect(envelope.content.body).toContain('test.event');
    });

    it('should handle large payload', async () => {
      const largePayload = { data: 'x'.repeat(10000) };

      const response = await server.inject({
        method: 'POST',
        url: '/large',
        payload: largePayload,
      });

      expect(response.statusCode).toBe(202);

      const messageStr = await consumeMessage();
      const envelope = JSON.parse(messageStr!);
      expect(envelope.content.body).toContain('x'.repeat(10000));
    });
  });

  describe('GET requests', () => {
    it('should publish GET request with empty body', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/api/status?param=value',
      });

      expect(response.statusCode).toBe(202);

      const messageStr = await consumeMessage();
      const envelope = JSON.parse(messageStr!);
      expect(envelope.content.method).toBe('GET');
      expect(envelope.content.url).toBe('/api/status?param=value');
      expect(envelope.content.body).toBe('');
    });
  });

  describe('Headers preservation', () => {
    it('should preserve custom headers', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/test',
        headers: {
          'x-request-id': 'req-12345',
          'x-correlation-id': 'corr-67890',
          authorization: 'Bearer test-token',
        },
        payload: 'test',
      });

      expect(response.statusCode).toBe(202);

      const messageStr = await consumeMessage();
      const envelope = JSON.parse(messageStr!);
      expect(envelope.content.headers['x-request-id']).toEqual(['req-12345']);
      expect(envelope.content.headers['x-correlation-id']).toEqual(['corr-67890']);
      expect(envelope.content.headers['authorization']).toEqual(['Bearer test-token']);
    });

    it('should forward traceparent to metadata', async () => {
      const traceparent = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
      const response = await server.inject({
        method: 'POST',
        url: '/test',
        headers: { traceparent },
        payload: 'test',
      });

      expect(response.statusCode).toBe(202);

      const messageStr = await consumeMessage();
      const envelope = JSON.parse(messageStr!);
      expect(envelope.metadata.traceparent).toBe(traceparent);
    });
  });

  describe('Other HTTP methods', () => {
    it('should handle PUT request', async () => {
      const response = await server.inject({
        method: 'PUT',
        url: '/resource/123',
        payload: { name: 'updated' },
      });

      expect(response.statusCode).toBe(202);

      const messageStr = await consumeMessage();
      const envelope = JSON.parse(messageStr!);
      expect(envelope.content.method).toBe('PUT');
      expect(envelope.content.url).toBe('/resource/123');
    });

    it('should handle DELETE request', async () => {
      const response = await server.inject({
        method: 'DELETE',
        url: '/resource/456',
      });

      expect(response.statusCode).toBe(202);

      const messageStr = await consumeMessage();
      const envelope = JSON.parse(messageStr!);
      expect(envelope.content.method).toBe('DELETE');
    });

    it('should handle PATCH request', async () => {
      const response = await server.inject({
        method: 'PATCH',
        url: '/resource/789',
        payload: { field: 'patched' },
      });

      expect(response.statusCode).toBe(202);

      const messageStr = await consumeMessage();
      const envelope = JSON.parse(messageStr!);
      expect(envelope.content.method).toBe('PATCH');
    });
  });

  describe('Concurrent requests', () => {
    it('should handle multiple concurrent requests', async () => {
      const requests = Array.from({ length: 10 }, (_, i) =>
        server.inject({
          method: 'POST',
          url: `/concurrent/${i}`,
          payload: { index: i },
        })
      );

      const responses = await Promise.all(requests);

      for (const response of responses) {
        expect(response.statusCode).toBe(202);
      }

      const messages: string[] = [];
      for (let i = 0; i < 10; i++) {
        const msg = await consumeMessage(1000);
        if (msg) messages.push(msg);
      }

      expect(messages.length).toBe(10);
    });
  });
});
