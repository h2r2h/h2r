import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('config', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should load config with defaults', async () => {
    process.env.RABBITMQ_URL = 'amqp://test';
    process.env.RABBITMQ_ROUTING_KEY = 'test.routing.key';

    const { loadConfig } = await import('../../src/config.js');
    const config = loadConfig();

    expect(config.PORT).toBe(8080);
    expect(config.ADMIN_PORT).toBe(9100);
    expect(config.HOST).toBe('0.0.0.0');
    expect(config.RABBITMQ_URL).toBe('amqp://test');
    expect(config.RABBITMQ_EXCHANGE).toBe('publish');
    expect(config.RABBITMQ_ROUTING_KEY).toBe('test.routing.key');
    expect(config.CHANNEL_POOL_SIZE).toBe(10);
    expect(config.MAX_INFLIGHT_PER_CHANNEL).toBe(100);
  });

  it('should load custom values from env', async () => {
    process.env.PORT = '8085';
    process.env.ADMIN_PORT = '9199';
    process.env.HOST = '127.0.0.1';
    process.env.RABBITMQ_URL = 'amqp://custom:5672';
    process.env.RABBITMQ_EXCHANGE = 'my-exchange';
    process.env.RABBITMQ_ROUTING_KEY = 'my.routing.key';
    process.env.CHANNEL_POOL_SIZE = '20';
    process.env.MAX_INFLIGHT_PER_CHANNEL = '200';

    const { loadConfig } = await import('../../src/config.js');
    const config = loadConfig();

    expect(config.PORT).toBe(8085);
    expect(config.ADMIN_PORT).toBe(9199);
    expect(config.HOST).toBe('127.0.0.1');
    expect(config.RABBITMQ_URL).toBe('amqp://custom:5672');
    expect(config.RABBITMQ_EXCHANGE).toBe('my-exchange');
    expect(config.RABBITMQ_ROUTING_KEY).toBe('my.routing.key');
    expect(config.CHANNEL_POOL_SIZE).toBe(20);
    expect(config.MAX_INFLIGHT_PER_CHANNEL).toBe(200);
  });

  it('should throw on missing required RABBITMQ_URL', async () => {
    delete process.env.RABBITMQ_URL;

    await expect(import('../../src/config.js')).rejects.toThrow(/RABBITMQ_URL/);
  });

  it('should throw on invalid PORT type', async () => {
    process.env.RABBITMQ_URL = 'amqp://test';
    process.env.PORT = 'invalid';

    await expect(import('../../src/config.js')).rejects.toThrow(/PORT/);
  });
});
