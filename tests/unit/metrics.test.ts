import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../src/config.js', () => ({
  config: {
    ADMIN_PORT: 9100,
    HOST: '0.0.0.0',
  },
}));

vi.mock('../../src/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  shouldLogRequest: vi.fn(() => true),
}));

vi.mock('../../src/health.js', () => ({
  getHealthCheck: vi.fn(() => ({
    connected: true,
    status: { status: 'ok', rabbitmq: 'connected' },
  })),
}));

import {
  register,
  messagesPublished,
  messagesFailed,
  publishDuration,
  rabbitmqConnected,
  inflightMessages,
} from '../../src/metrics.js';

describe('metrics', () => {
  beforeEach(async () => {
    register.resetMetrics();
  });

  it('should expose messages_published counter', async () => {
    messagesPublished.inc();
    messagesPublished.inc();
    const metrics = await register.metrics();
    expect(metrics).toContain('h2r_messages_published_total 2');
  });

  it('should expose messages_failed counter', async () => {
    messagesFailed.inc();
    const metrics = await register.metrics();
    expect(metrics).toContain('h2r_messages_failed_total 1');
  });

  it('should expose publish_duration histogram', async () => {
    publishDuration.observe(0.005);
    publishDuration.observe(0.015);
    const metrics = await register.metrics();
    expect(metrics).toContain('h2r_publish_duration_seconds_bucket');
    expect(metrics).toContain('h2r_publish_duration_seconds_count 2');
  });

  it('should expose rabbitmq_connected gauge', async () => {
    rabbitmqConnected.set(1);
    const metrics = await register.metrics();
    expect(metrics).toContain('h2r_rabbitmq_connected 1');
  });

  it('should expose inflight_messages gauge', async () => {
    inflightMessages.set(5);
    const metrics = await register.metrics();
    expect(metrics).toContain('h2r_inflight_messages 5');
  });
});

describe('admin server', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return 200 on /healthz when connected', async () => {
    const { getHealthCheck } = await import('../../src/health.js');
    vi.mocked(getHealthCheck).mockReturnValue({
      connected: true,
      status: { status: 'ok', rabbitmq: 'connected' },
    });

    const { startAdminServer } = await import('../../src/metrics.js');
    const server = await startAdminServer();

    const response = await server.inject({
      method: 'GET',
      url: '/healthz',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok', rabbitmq: 'connected' });

    await server.close();
  });

  it('should return 503 on /healthz when disconnected', async () => {
    const { getHealthCheck } = await import('../../src/health.js');
    vi.mocked(getHealthCheck).mockReturnValue({
      connected: false,
      status: { status: 'degraded', rabbitmq: 'disconnected' },
    });

    const { startAdminServer } = await import('../../src/metrics.js');
    const server = await startAdminServer();

    const response = await server.inject({
      method: 'GET',
      url: '/healthz',
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'degraded', rabbitmq: 'disconnected' });

    await server.close();
  });

  it('should return metrics on /metrics', async () => {
    const { startAdminServer } = await import('../../src/metrics.js');
    const server = await startAdminServer();

    const response = await server.inject({
      method: 'GET',
      url: '/metrics',
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/plain');

    await server.close();
  });
});
