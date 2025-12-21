import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const mockRabbitmq = {
  isConnected: vi.fn(),
  publish: vi.fn(),
  connect: vi.fn(),
  close: vi.fn(),
};

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

vi.mock('../../src/config.js', () => ({
  config: {
    PORT: 0,
    ADMIN_PORT: 0,
    HOST: '127.0.0.1',
    RABBITMQ_URL: 'amqp://localhost',
    RABBITMQ_EXCHANGE: 'test-exchange',
    RABBITMQ_ROUTING_KEY: 'test.key',
    CHANNEL_POOL_SIZE: 10,
    MAX_INFLIGHT_PER_CHANNEL: 100,
    MAX_BODY_SIZE: 1024,
  },
}));

vi.mock('../../src/rabbitmq.js', () => ({
  rabbitmq: mockRabbitmq,
}));

vi.mock('../../src/logger.js', () => ({
  logger: mockLogger,
  shouldLogRequest: vi.fn(() => true),
}));

const mockApplyPlugin = vi.fn();

vi.mock('../../src/plugin.js', () => ({
  applyPlugin: mockApplyPlugin,
}));

describe('server', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRabbitmq.isConnected.mockReturnValue(true);
    mockRabbitmq.publish.mockResolvedValue(undefined);
    mockApplyPlugin.mockResolvedValue({ publish: true });
  });

  afterEach(async () => {
    vi.resetModules();
  });

  describe('catch-all routes', () => {
    it('should capture POST request and publish with bodyEncoding', async () => {
      const { buildServer } = await import('../../src/server.js');
      const server = buildServer();

      const response = await server.inject({
        method: 'POST',
        url: '/webhook/stripe',
        headers: { 'content-type': 'application/json' },
        payload: { event: 'payment.success' },
      });

      expect(response.statusCode).toBe(202);
      expect(response.json()).toEqual({ status: 'accepted' });
      expect(mockRabbitmq.publish).toHaveBeenCalledTimes(1);

      const envelope = JSON.parse(mockRabbitmq.publish.mock.calls[0][0].toString());
      expect(envelope.metadata.metadata_version).toBe('v1');
      expect(envelope.metadata.created_at).toBeDefined();
      expect(envelope.metadata.message_type).toBe('h2r');
      expect(envelope.metadata.message_version).toBe('v1');
      expect(envelope.content.method).toBe('POST');
      expect(envelope.content.url).toBe('/webhook/stripe');
      expect(envelope.content.body).toContain('payment.success');
      expect(envelope.content.bodyEncoding).toBe('utf8');

      await server.close();
    });

    it('should capture GET request with empty body', async () => {
      const { buildServer } = await import('../../src/server.js');
      const server = buildServer();

      const response = await server.inject({
        method: 'GET',
        url: '/api/status',
      });

      expect(response.statusCode).toBe(202);

      const envelope = JSON.parse(mockRabbitmq.publish.mock.calls[0][0].toString());
      expect(envelope.content.method).toBe('GET');
      expect(envelope.content.url).toBe('/api/status');
      expect(envelope.content.body).toBe('');
      expect(envelope.content.bodyEncoding).toBe('utf8');

      await server.close();
    });

    it('should capture all headers as arrays', async () => {
      const { buildServer } = await import('../../src/server.js');
      const server = buildServer();

      const response = await server.inject({
        method: 'POST',
        url: '/test',
        headers: {
          'content-type': 'text/plain',
          'x-custom-header': 'custom-value',
          'authorization': 'Bearer token123',
        },
        payload: 'test',
      });

      expect(response.statusCode).toBe(202);
      expect(mockRabbitmq.publish).toHaveBeenCalledTimes(1);
      const envelope = JSON.parse(mockRabbitmq.publish.mock.calls[0][0].toString());
      expect(envelope.content.headers['x-custom-header']).toEqual(['custom-value']);
      expect(envelope.content.headers['authorization']).toEqual(['Bearer token123']);
      expect(Array.isArray(envelope.content.headers['content-type'])).toBe(true);

      await server.close();
    });


    it('should return 503 when RabbitMQ unavailable', async () => {
      mockRabbitmq.isConnected.mockReturnValue(false);

      const { buildServer } = await import('../../src/server.js');
      const server = buildServer();

      const response = await server.inject({
        method: 'POST',
        url: '/test',
        headers: { 'content-type': 'text/plain' },
        payload: 'test',
      });

      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ error: 'RabbitMQ unavailable' });
      expect(mockRabbitmq.publish).not.toHaveBeenCalled();

      await server.close();
    });

    it('should return 503 on backpressure', async () => {
      mockRabbitmq.publish.mockRejectedValue(new Error('Backpressure: all channels at capacity'));

      const { buildServer } = await import('../../src/server.js');
      const server = buildServer();

      const response = await server.inject({
        method: 'POST',
        url: '/test',
        headers: { 'content-type': 'text/plain' },
        payload: 'test',
      });

      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ error: 'Service overloaded' });

      await server.close();
    });

    it('should handle PUT request', async () => {
      const { buildServer } = await import('../../src/server.js');
      const server = buildServer();

      const response = await server.inject({
        method: 'PUT',
        url: '/resource/123',
        payload: { name: 'updated' },
      });

      expect(response.statusCode).toBe(202);

      const envelope = JSON.parse(mockRabbitmq.publish.mock.calls[0][0].toString());
      expect(envelope.content.method).toBe('PUT');
      expect(envelope.content.url).toBe('/resource/123');

      await server.close();
    });

    it('should handle DELETE request', async () => {
      const { buildServer } = await import('../../src/server.js');
      const server = buildServer();

      const response = await server.inject({
        method: 'DELETE',
        url: '/resource/456',
      });

      expect(response.statusCode).toBe(202);

      const envelope = JSON.parse(mockRabbitmq.publish.mock.calls[0][0].toString());
      expect(envelope.content.method).toBe('DELETE');

      await server.close();
    });

    it('should handle binary body with base64 encoding', async () => {
      const { buildServer } = await import('../../src/server.js');
      const server = buildServer();

      const binaryData = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]);

      const response = await server.inject({
        method: 'POST',
        url: '/binary',
        headers: { 'content-type': 'application/octet-stream' },
        payload: binaryData,
      });

      expect(response.statusCode).toBe(202);
      expect(mockRabbitmq.publish).toHaveBeenCalled();

      const envelope = JSON.parse(mockRabbitmq.publish.mock.calls[0][0].toString());
      expect(envelope.content.bodyEncoding).toBe('base64');

      await server.close();
    });

    it('should handle publish error that is not backpressure', async () => {
      mockRabbitmq.publish.mockRejectedValue(new Error('Unknown error'));

      const { buildServer } = await import('../../src/server.js');
      const server = buildServer();

      const response = await server.inject({
        method: 'POST',
        url: '/test',
        headers: { 'content-type': 'text/plain' },
        payload: 'test',
      });

      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({ error: 'Publish failed' });

      await server.close();
    });

    it('should reject oversized body with 413', async () => {
      const { buildServer } = await import('../../src/server.js');
      const server = buildServer();

      const largePayload = 'x'.repeat(2048);

      const response = await server.inject({
        method: 'POST',
        url: '/test',
        headers: { 'content-type': 'text/plain' },
        payload: largePayload,
      });

      expect(response.statusCode).toBe(413);
      expect(mockRabbitmq.publish).not.toHaveBeenCalled();

      await server.close();
    });
  });

  describe('startServer', () => {
    it('should start server and return instance', async () => {
      const { startServer } = await import('../../src/server.js');
      const server = await startServer();

      expect(server).toBeDefined();
      expect(server.server.listening).toBe(true);

      await server.close();
    });
  });

  describe('plugin integration', () => {
    it('should filter request when plugin returns publish: false', async () => {
      mockApplyPlugin.mockResolvedValue({
        publish: false,
        statusCode: 403,
        response: { error: 'Forbidden' },
        reason: 'test_filter',
      });

      const { buildServer } = await import('../../src/server.js');
      const server = buildServer();

      const response = await server.inject({
        method: 'POST',
        url: '/internal/secret',
        payload: { data: 'test' },
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ error: 'Forbidden' });
      expect(mockRabbitmq.publish).not.toHaveBeenCalled();
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'test_filter' }),
        'request_filtered'
      );

      await server.close();
    });

    it('should use default response when plugin filters without response', async () => {
      mockApplyPlugin.mockResolvedValue({ publish: false });

      const { buildServer } = await import('../../src/server.js');
      const server = buildServer();

      const response = await server.inject({
        method: 'GET',
        url: '/test',
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: 'filtered' });
      expect(mockRabbitmq.publish).not.toHaveBeenCalled();

      await server.close();
    });

    it('should pass custom exchange and routing key to publish', async () => {
      mockApplyPlugin.mockResolvedValue({
        publish: true,
        exchange: 'custom-exchange',
        routingKey: 'custom.key',
      });

      const { buildServer } = await import('../../src/server.js');
      const server = buildServer();

      const response = await server.inject({
        method: 'POST',
        url: '/webhook',
        payload: { event: 'test' },
      });

      expect(response.statusCode).toBe(202);
      expect(mockRabbitmq.publish).toHaveBeenCalledWith(
        expect.any(Buffer),
        'custom-exchange',
        'custom.key'
      );

      await server.close();
    });

    it('should use custom status code on success', async () => {
      mockApplyPlugin.mockResolvedValue({
        publish: true,
        statusCode: 201,
        response: { id: 'created-123' },
      });

      const { buildServer } = await import('../../src/server.js');
      const server = buildServer();

      const response = await server.inject({
        method: 'POST',
        url: '/resource',
        payload: { name: 'test' },
      });

      expect(response.statusCode).toBe(201);
      expect(response.json()).toEqual({ id: 'created-123' });
      expect(mockRabbitmq.publish).toHaveBeenCalled();

      await server.close();
    });

    it('should pass correct input to plugin', async () => {
      const { buildServer } = await import('../../src/server.js');
      const server = buildServer();

      await server.inject({
        method: 'POST',
        url: '/webhook/stripe?sig=abc',
        headers: {
          'content-type': 'application/json',
          'x-custom': 'value',
        },
        payload: { event: 'payment.success' },
      });

      expect(mockApplyPlugin).toHaveBeenCalledWith({
        method: 'POST',
        url: '/webhook/stripe?sig=abc',
        headers: expect.objectContaining({
          'content-type': ['application/json'],
          'x-custom': ['value'],
        }),
        body: expect.stringContaining('payment.success'),
        bodyEncoding: 'utf8',
      });

      await server.close();
    });

    it('should return 500 when plugin throws sync exception', async () => {
      mockApplyPlugin.mockRejectedValue(new Error('Plugin crashed'));

      const { buildServer } = await import('../../src/server.js');
      const server = buildServer();

      const response = await server.inject({
        method: 'POST',
        url: '/test',
        payload: { data: 'test' },
      });

      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({ error: 'Plugin error' });
      expect(mockRabbitmq.publish).not.toHaveBeenCalled();

      await server.close();
    });

    it('should return 500 when plugin throws async exception', async () => {
      mockApplyPlugin.mockImplementation(async () => {
        await new Promise(r => setTimeout(r, 5));
        throw new Error('Async plugin crashed');
      });

      const { buildServer } = await import('../../src/server.js');
      const server = buildServer();

      const response = await server.inject({
        method: 'POST',
        url: '/test',
        payload: { data: 'test' },
      });

      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({ error: 'Plugin error' });
      expect(mockRabbitmq.publish).not.toHaveBeenCalled();

      await server.close();
    });

    it('should pass empty string exchange to publish (rabbitmq layer handles fallback)', async () => {
      mockApplyPlugin.mockResolvedValue({
        publish: true,
        exchange: '',
        routingKey: 'custom.key',
      });

      const { buildServer } = await import('../../src/server.js');
      const server = buildServer();

      const response = await server.inject({
        method: 'POST',
        url: '/webhook',
        payload: { event: 'test' },
      });

      expect(response.statusCode).toBe(202);
      expect(mockRabbitmq.publish).toHaveBeenCalledWith(
        expect.any(Buffer),
        '',
        'custom.key'
      );

      await server.close();
    });

    it('should pass empty string routingKey to publish (rabbitmq layer handles fallback)', async () => {
      mockApplyPlugin.mockResolvedValue({
        publish: true,
        exchange: 'custom-exchange',
        routingKey: '',
      });

      const { buildServer } = await import('../../src/server.js');
      const server = buildServer();

      const response = await server.inject({
        method: 'POST',
        url: '/webhook',
        payload: { event: 'test' },
      });

      expect(response.statusCode).toBe(202);
      expect(mockRabbitmq.publish).toHaveBeenCalledWith(
        expect.any(Buffer),
        'custom-exchange',
        ''
      );

      await server.close();
    });

    it('should handle undefined exchange and routingKey', async () => {
      mockApplyPlugin.mockResolvedValue({
        publish: true,
        exchange: undefined,
        routingKey: undefined,
      });

      const { buildServer } = await import('../../src/server.js');
      const server = buildServer();

      const response = await server.inject({
        method: 'POST',
        url: '/webhook',
        payload: { event: 'test' },
      });

      expect(response.statusCode).toBe(202);
      expect(mockRabbitmq.publish).toHaveBeenCalledWith(
        expect.any(Buffer),
        undefined,
        undefined
      );

      await server.close();
    });
  });
});
