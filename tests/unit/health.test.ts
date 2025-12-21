import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockRabbitmq = {
  isConnected: vi.fn(),
};

vi.mock('../../src/rabbitmq.js', () => ({
  rabbitmq: mockRabbitmq,
}));

describe('health', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('should return connected status when rabbitmq is connected', async () => {
    mockRabbitmq.isConnected.mockReturnValue(true);

    const { getHealthCheck } = await import('../../src/health.js');
    const result = getHealthCheck();

    expect(result.connected).toBe(true);
    expect(result.status).toEqual({
      status: 'ok',
      rabbitmq: 'connected',
    });
  });

  it('should return disconnected status when rabbitmq is disconnected', async () => {
    mockRabbitmq.isConnected.mockReturnValue(false);

    const { getHealthCheck } = await import('../../src/health.js');
    const result = getHealthCheck();

    expect(result.connected).toBe(false);
    expect(result.status).toEqual({
      status: 'degraded',
      rabbitmq: 'disconnected',
    });
  });

  it('should return atomic result with consistent connected and status', async () => {
    mockRabbitmq.isConnected.mockReturnValue(true);

    const { getHealthCheck } = await import('../../src/health.js');
    const result = getHealthCheck();

    expect(mockRabbitmq.isConnected).toHaveBeenCalledTimes(1);
    expect(result.connected).toBe(true);
    expect(result.status.status).toBe('ok');
    expect(result.status.rabbitmq).toBe('connected');
  });
});
