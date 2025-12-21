import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockChannel = {
  on: vi.fn(),
  publish: vi.fn(),
  close: vi.fn(),
  checkExchange: vi.fn(),
};

const mockConnection = {
  on: vi.fn(),
  createConfirmChannel: vi.fn(),
  createChannel: vi.fn(),
  close: vi.fn(),
};

const mockAmqp = {
  connect: vi.fn(),
};

vi.mock('amqplib', () => ({
  default: mockAmqp,
}));

vi.mock('../../src/config.js', () => ({
  config: {
    PORT: 8080,
    ADMIN_PORT: 9100,
    HOST: '127.0.0.1',
    RABBITMQ_URL: 'amqp://localhost',
    RABBITMQ_EXCHANGE: 'test-exchange',
    RABBITMQ_ROUTING_KEY: 'test.key',
    CHANNEL_POOL_SIZE: 2,
    MAX_INFLIGHT_PER_CHANNEL: 2,
  },
}));

vi.mock('../../src/metrics.js', () => ({
  messagesPublished: { inc: vi.fn() },
  messagesFailed: { inc: vi.fn() },
  publishDuration: { observe: vi.fn() },
  rabbitmqConnected: { set: vi.fn() },
  inflightMessages: { set: vi.fn(), dec: vi.fn() },
}));

vi.mock('../../src/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('rabbitmq', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();

    mockAmqp.connect.mockResolvedValue(mockConnection);
    mockConnection.createConfirmChannel.mockResolvedValue({ ...mockChannel });
    mockConnection.createChannel.mockResolvedValue({ ...mockChannel });
    mockChannel.on.mockReturnValue(mockChannel);
    mockChannel.close.mockResolvedValue(undefined);
    mockChannel.checkExchange.mockResolvedValue(undefined);
    mockConnection.close.mockResolvedValue(undefined);
  });

  it('should connect and create channel pool', async () => {
    const { rabbitmq } = await import('../../src/rabbitmq.js');

    await rabbitmq.connect();

    expect(mockAmqp.connect).toHaveBeenCalledWith('amqp://localhost');
    expect(mockConnection.createConfirmChannel).toHaveBeenCalledTimes(2);
    expect(rabbitmq.isConnected()).toBe(true);

    await rabbitmq.close();
  });

  it('should publish message with confirms', async () => {
    mockConnection.createConfirmChannel.mockResolvedValue({
      ...mockChannel,
      publish: vi.fn((_ex, _rk, _msg, _opts, callback) => {
        callback(null);
        return true;
      }),
    });

    const { rabbitmq } = await import('../../src/rabbitmq.js');
    await rabbitmq.connect();

    const message = Buffer.from('test message');
    await rabbitmq.publish(message);

    expect(mockConnection.createConfirmChannel).toHaveBeenCalled();

    await rabbitmq.close();
  });

  it('should handle publish failure', async () => {
    const publishError = new Error('Publish failed');
    mockConnection.createConfirmChannel.mockResolvedValue({
      ...mockChannel,
      publish: vi.fn((_ex, _rk, _msg, _opts, callback) => {
        callback(publishError);
        return true;
      }),
    });

    const { rabbitmq } = await import('../../src/rabbitmq.js');
    await rabbitmq.connect();

    const message = Buffer.from('test message');
    await expect(rabbitmq.publish(message)).rejects.toThrow('Publish failed');

    await rabbitmq.close();
  });

  it('should handle backpressure when all channels at capacity', async () => {
    const pendingCallbacks: Array<(err: Error | null) => void> = [];

    mockConnection.createConfirmChannel.mockImplementation(async () => ({
      on: vi.fn(),
      close: vi.fn(),
      publish: vi.fn((_ex, _rk, _msg, _opts, callback) => {
        pendingCallbacks.push(callback);
        return true;
      }),
    }));

    const { rabbitmq } = await import('../../src/rabbitmq.js');
    await rabbitmq.connect();

    const message = Buffer.from('test');
    const promises = [
      rabbitmq.publish(message),
      rabbitmq.publish(message),
      rabbitmq.publish(message),
      rabbitmq.publish(message),
    ];

    await expect(rabbitmq.publish(message)).rejects.toThrow('Backpressure');

    pendingCallbacks.forEach((cb) => cb(null));
    await Promise.all(promises);
    await rabbitmq.close();
  });

  it('should use round-robin channel selection', async () => {
    const channels: { publish: ReturnType<typeof vi.fn> }[] = [];

    mockConnection.createConfirmChannel.mockImplementation(async () => {
      const channel = {
        ...mockChannel,
        publish: vi.fn((_ex, _rk, _msg, _opts, callback) => {
          callback(null);
          return true;
        }),
      };
      channels.push(channel);
      return channel;
    });

    const { rabbitmq } = await import('../../src/rabbitmq.js');
    await rabbitmq.connect();

    await rabbitmq.publish(Buffer.from('msg1'));
    await rabbitmq.publish(Buffer.from('msg2'));
    await rabbitmq.publish(Buffer.from('msg3'));

    expect(channels[0].publish).toHaveBeenCalledTimes(2);
    expect(channels[1].publish).toHaveBeenCalledTimes(1);

    await rabbitmq.close();
  });

  it('should report disconnected after close', async () => {
    const { rabbitmq } = await import('../../src/rabbitmq.js');

    await rabbitmq.connect();
    expect(rabbitmq.isConnected()).toBe(true);

    await rabbitmq.close();
    expect(rabbitmq.isConnected()).toBe(false);
  });

  it('should handle connection failure', async () => {
    mockAmqp.connect.mockRejectedValue(new Error('Connection refused'));

    const { rabbitmq } = await import('../../src/rabbitmq.js');

    await expect(rabbitmq.connect()).rejects.toThrow('Connection refused');
    expect(rabbitmq.isConnected()).toBe(false);
  });

  it('should schedule reconnect on connection close', async () => {
    vi.useFakeTimers();
    let closeHandler: () => void;

    mockConnection.on.mockImplementation((event: string, handler: () => void) => {
      if (event === 'close') closeHandler = handler;
      return mockConnection;
    });

    const { rabbitmq } = await import('../../src/rabbitmq.js');
    const { logger } = await import('../../src/logger.js');

    await rabbitmq.connect();
    expect(rabbitmq.isConnected()).toBe(true);

    closeHandler!();

    expect(logger.warn).toHaveBeenCalledWith('rabbitmq_connection_closed');
    expect(logger.info).toHaveBeenCalledWith(
      { delay_ms: 1000, attempt: 1 },
      'rabbitmq_reconnect_scheduled'
    );

    vi.useRealTimers();
    await rabbitmq.close();
  });

  it('should reconnect successfully after connection close', async () => {
    vi.useFakeTimers();
    let closeHandler: () => void;

    mockConnection.on.mockImplementation((event: string, handler: () => void) => {
      if (event === 'close') closeHandler = handler;
      return mockConnection;
    });

    const { rabbitmq } = await import('../../src/rabbitmq.js');

    await rabbitmq.connect();
    mockAmqp.connect.mockClear();
    mockConnection.createConfirmChannel.mockClear();

    closeHandler!();

    await vi.advanceTimersByTimeAsync(1000);

    expect(mockAmqp.connect).toHaveBeenCalledTimes(1);
    expect(mockConnection.createConfirmChannel).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
    await rabbitmq.close();
  });

  it('should retry reconnect with exponential backoff on failure', async () => {
    vi.useFakeTimers();
    let closeHandler: () => void;

    mockConnection.on.mockImplementation((event: string, handler: () => void) => {
      if (event === 'close') closeHandler = handler;
      return mockConnection;
    });

    const { rabbitmq } = await import('../../src/rabbitmq.js');
    const { logger } = await import('../../src/logger.js');

    await rabbitmq.connect();

    mockAmqp.connect
      .mockRejectedValueOnce(new Error('Connection refused'))
      .mockResolvedValueOnce(mockConnection);

    closeHandler!();

    await vi.advanceTimersByTimeAsync(1000);
    expect(logger.error).toHaveBeenCalledWith(
      { err: expect.any(Error) },
      'rabbitmq_reconnect_failed'
    );

    expect(logger.info).toHaveBeenCalledWith(
      { delay_ms: 2000, attempt: 2 },
      'rabbitmq_reconnect_scheduled'
    );

    await vi.advanceTimersByTimeAsync(2000);
    expect(rabbitmq.isConnected()).toBe(true);

    vi.useRealTimers();
    await rabbitmq.close();
  });

  it('should handle connection error event', async () => {
    let errorHandler: (err: Error) => void;

    mockConnection.on.mockImplementation((event: string, handler: (err: Error) => void) => {
      if (event === 'error') errorHandler = handler;
      return mockConnection;
    });

    const { rabbitmq } = await import('../../src/rabbitmq.js');
    const { logger } = await import('../../src/logger.js');
    const { rabbitmqConnected } = await import('../../src/metrics.js');

    await rabbitmq.connect();

    const testError = new Error('Connection lost');
    errorHandler!(testError);

    expect(logger.error).toHaveBeenCalledWith({ err: testError }, 'rabbitmq_connection_error');
    expect(rabbitmqConnected.set).toHaveBeenCalledWith(0);

    await rabbitmq.close();
  });

  it('should handle channel error and close events', async () => {
    let channelErrorHandler: (err: Error) => void;
    let channelCloseHandler: () => void;

    mockConnection.createConfirmChannel.mockResolvedValue({
      ...mockChannel,
      on: vi.fn((event: string, handler: (err?: Error) => void) => {
        if (event === 'error') channelErrorHandler = handler;
        if (event === 'close') channelCloseHandler = handler;
        return mockChannel;
      }),
    });

    const { rabbitmq } = await import('../../src/rabbitmq.js');
    const { logger } = await import('../../src/logger.js');

    await rabbitmq.connect();

    channelErrorHandler!(new Error('Channel error'));
    expect(logger.error).toHaveBeenCalledWith(
      { err: expect.any(Error), channel: expect.any(Number) },
      'channel_error'
    );

    channelCloseHandler!();
    expect(logger.warn).toHaveBeenCalledWith(
      { channel: expect.any(Number) },
      'channel_closed'
    );

    await rabbitmq.close();
  });

  it('should remove channel from pool on close', async () => {
    const closeHandlers: (() => void)[] = [];
    let channelCount = 0;

    mockConnection.createConfirmChannel.mockImplementation(async () => {
      const idx = channelCount++;
      const channel = {
        ...mockChannel,
        on: vi.fn((event: string, handler: () => void) => {
          if (event === 'close') closeHandlers[idx] = handler;
          return channel;
        }),
      };
      return channel;
    });

    vi.doMock('../../src/config.js', () => ({
      config: {
        RABBITMQ_URL: 'amqp://localhost',
        CHANNEL_POOL_SIZE: 3,
        MAX_INFLIGHT_PER_CHANNEL: 100,
        RABBITMQ_EXCHANGE: 'test',
        RABBITMQ_ROUTING_KEY: '',
      },
    }));

    const { rabbitmq } = await import('../../src/rabbitmq.js');
    const { logger } = await import('../../src/logger.js');

    await rabbitmq.connect();
    expect(rabbitmq.isConnected()).toBe(true);

    closeHandlers[0]();

    expect(logger.info).toHaveBeenCalledWith(
      { remaining_channels: 2 },
      'channel_removed_from_pool'
    );

    closeHandlers[1]();
    expect(logger.info).toHaveBeenCalledWith(
      { remaining_channels: 1 },
      'channel_removed_from_pool'
    );

    closeHandlers[2]();
    expect(logger.info).toHaveBeenCalledWith(
      { remaining_channels: 0 },
      'channel_removed_from_pool'
    );

    expect(rabbitmq.isConnected()).toBe(false);

    await rabbitmq.close();
  });

  it('should handle synchronous publish error', async () => {
    mockConnection.createConfirmChannel.mockResolvedValue({
      ...mockChannel,
      publish: vi.fn(() => {
        throw new Error('Sync publish error');
      }),
    });

    const { rabbitmq } = await import('../../src/rabbitmq.js');
    await rabbitmq.connect();

    await expect(rabbitmq.publish(Buffer.from('test'))).rejects.toThrow('Sync publish error');

    await rabbitmq.close();
  });

  it('should ignore errors when closing channels and connection', async () => {
    mockChannel.close.mockRejectedValue(new Error('Channel already closed'));
    mockConnection.close.mockRejectedValue(new Error('Connection already closed'));

    mockConnection.createConfirmChannel.mockResolvedValue({
      ...mockChannel,
      close: vi.fn().mockRejectedValue(new Error('Channel already closed')),
    });

    const { rabbitmq } = await import('../../src/rabbitmq.js');
    await rabbitmq.connect();

    await expect(rabbitmq.close()).resolves.toBeUndefined();
    expect(rabbitmq.isConnected()).toBe(false);
  });

  it('should not re-add dead channel to inflightPerChannel map', async () => {
    let closeHandler: () => void;
    let publishCallback: (err: Error | null) => void;

    const channel = {
      ...mockChannel,
      on: vi.fn((event: string, handler: () => void) => {
        if (event === 'close') closeHandler = handler;
        return channel;
      }),
      publish: vi.fn((_ex, _rk, _msg, _opts, cb) => {
        publishCallback = cb;
        return true;
      }),
    };

    mockConnection.createConfirmChannel.mockResolvedValue(channel);
    mockConnection.createChannel.mockResolvedValue({
      checkExchange: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    });

    const { rabbitmq } = await import('../../src/rabbitmq.js');
    await rabbitmq.connect();

    const publishPromise = rabbitmq.publish(Buffer.from('test'));
    await new Promise(resolve => setImmediate(resolve));

    closeHandler!();

    publishCallback!(null);

    await publishPromise;

    await rabbitmq.close();
  });

  it('should wait for inflight messages to drain', async () => {
    let publishCallback: (err: Error | null) => void;

    mockConnection.createConfirmChannel.mockResolvedValue({
      ...mockChannel,
      publish: vi.fn((_ex, _rk, _msg, _opts, cb) => {
        publishCallback = cb;
        return true;
      }),
    });

    const { rabbitmq } = await import('../../src/rabbitmq.js');
    await rabbitmq.connect();

    const publishPromise = rabbitmq.publish(Buffer.from('test'));

    const drainPromise = rabbitmq.waitForInflight(1000);

    setTimeout(() => publishCallback!(null), 100);

    await drainPromise;
    await publishPromise;

    await rabbitmq.close();
  });

  it('should timeout when waiting for inflight messages', async () => {
    mockConnection.createConfirmChannel.mockResolvedValue({
      ...mockChannel,
      publish: vi.fn(() => true),
    });
    mockConnection.createChannel.mockResolvedValue({
      checkExchange: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    });

    const { rabbitmq } = await import('../../src/rabbitmq.js');
    const { logger } = await import('../../src/logger.js');
    await rabbitmq.connect();

    rabbitmq.publish(Buffer.from('test'));
    await new Promise(resolve => setImmediate(resolve));

    await rabbitmq.waitForInflight(100);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ remaining_inflight: 1, timeout_ms: 100 }),
      'drain_timeout'
    );

    await rabbitmq.close();
  });

  it('should handle channel removal during getNextChannel iteration', async () => {
    const closeHandlers: (() => void)[] = [];
    let channelCount = 0;
    const publishCallbacks: Array<(err: Error | null) => void> = [];

    mockConnection.createConfirmChannel.mockImplementation(async () => {
      const idx = channelCount++;
      const channel = {
        ...mockChannel,
        on: vi.fn((event: string, handler: () => void) => {
          if (event === 'close') closeHandlers[idx] = handler;
          return channel;
        }),
        publish: vi.fn((_ex, _rk, _msg, _opts, callback) => {
          publishCallbacks.push(callback);
          return true;
        }),
      };
      return channel;
    });
    mockConnection.createChannel.mockResolvedValue({
      checkExchange: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    });

    vi.doMock('../../src/config.js', () => ({
      config: {
        RABBITMQ_URL: 'amqp://localhost',
        CHANNEL_POOL_SIZE: 3,
        MAX_INFLIGHT_PER_CHANNEL: 1,
        RABBITMQ_EXCHANGE: 'test',
        RABBITMQ_ROUTING_KEY: '',
      },
    }));

    const { rabbitmq } = await import('../../src/rabbitmq.js');
    await rabbitmq.connect();

    const msg1Promise = rabbitmq.publish(Buffer.from('msg1'));
    const msg2Promise = rabbitmq.publish(Buffer.from('msg2'));
    const msg3Promise = rabbitmq.publish(Buffer.from('msg3'));
    await new Promise(resolve => setImmediate(resolve));

    closeHandlers[0]();

    await expect(rabbitmq.publish(Buffer.from('msg4'))).rejects.toThrow('Backpressure');

    publishCallbacks.forEach((cb) => cb(null));
    await Promise.all([msg1Promise, msg2Promise, msg3Promise]);

    await rabbitmq.close();
  });

  it('should trigger reconnect when all channels close but connection is still open', async () => {
    vi.useFakeTimers();
    const closeHandlers: (() => void)[] = [];
    let channelCount = 0;

    mockConnection.createConfirmChannel.mockImplementation(async () => {
      const idx = channelCount++;
      const channel = {
        ...mockChannel,
        on: vi.fn((event: string, handler: () => void) => {
          if (event === 'close') closeHandlers[idx] = handler;
          return channel;
        }),
      };
      return channel;
    });

    vi.doMock('../../src/config.js', () => ({
      config: {
        RABBITMQ_URL: 'amqp://localhost',
        CHANNEL_POOL_SIZE: 2,
        MAX_INFLIGHT_PER_CHANNEL: 100,
        RABBITMQ_EXCHANGE: 'test',
        RABBITMQ_ROUTING_KEY: '',
      },
    }));

    const { rabbitmq } = await import('../../src/rabbitmq.js');
    const { logger } = await import('../../src/logger.js');

    await rabbitmq.connect();
    expect(rabbitmq.isConnected()).toBe(true);

    closeHandlers[0]();
    expect(logger.warn).toHaveBeenCalledWith({ channel: 0 }, 'channel_closed');
    expect(rabbitmq.isConnected()).toBe(true);

    closeHandlers[1]();
    expect(logger.warn).toHaveBeenCalledWith({ channel: 1 }, 'channel_closed');
    expect(logger.warn).toHaveBeenCalledWith('all_channels_closed_reconnecting');
    expect(logger.info).toHaveBeenCalledWith(
      { delay_ms: 1000, attempt: 1 },
      'rabbitmq_reconnect_scheduled'
    );

    expect(rabbitmq.isConnected()).toBe(false);

    vi.useRealTimers();
    await rabbitmq.close();
  });

  it('should not double-schedule reconnect when all channels close', async () => {
    vi.useFakeTimers();
    const closeHandlers: (() => void)[] = [];
    let channelCount = 0;

    mockConnection.createConfirmChannel.mockImplementation(async () => {
      const idx = channelCount++;
      const channel = {
        ...mockChannel,
        on: vi.fn((event: string, handler: () => void) => {
          if (event === 'close') closeHandlers[idx] = handler;
          return channel;
        }),
      };
      return channel;
    });

    vi.doMock('../../src/config.js', () => ({
      config: {
        RABBITMQ_URL: 'amqp://localhost',
        CHANNEL_POOL_SIZE: 2,
        MAX_INFLIGHT_PER_CHANNEL: 100,
        RABBITMQ_EXCHANGE: 'test',
        RABBITMQ_ROUTING_KEY: '',
      },
    }));

    const { rabbitmq } = await import('../../src/rabbitmq.js');
    const { logger } = await import('../../src/logger.js');

    await rabbitmq.connect();

    closeHandlers[0]();
    closeHandlers[1]();

    const scheduleCalls = (logger.info as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call) => call[1] === 'rabbitmq_reconnect_scheduled'
    );
    expect(scheduleCalls).toHaveLength(1);

    vi.useRealTimers();
    await rabbitmq.close();
  });

  it('should decrement inflightMessages metric when channel with inflight messages is removed', async () => {
    let closeHandler: () => void;
    let publishCallback: (err: Error | null) => void;

    const channel = {
      ...mockChannel,
      on: vi.fn((event: string, handler: () => void) => {
        if (event === 'close') closeHandler = handler;
        return channel;
      }),
      publish: vi.fn((_ex, _rk, _msg, _opts, cb) => {
        publishCallback = cb;
        return true;
      }),
    };

    mockConnection.createConfirmChannel.mockResolvedValue(channel);
    mockConnection.createChannel.mockResolvedValue({
      checkExchange: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    });

    const { rabbitmq } = await import('../../src/rabbitmq.js');
    const { inflightMessages } = await import('../../src/metrics.js');
    const { logger } = await import('../../src/logger.js');
    await rabbitmq.connect();

    const publishPromise = rabbitmq.publish(Buffer.from('test'));
    await new Promise(resolve => setImmediate(resolve));

    expect(inflightMessages.set).toHaveBeenCalledWith(1);

    closeHandler!();

    expect(inflightMessages.dec).toHaveBeenCalledWith(1);
    expect(logger.warn).toHaveBeenCalledWith(
      { lostInflight: 1 },
      'channel_removed_inflight_messages_lost'
    );

    publishCallback!(null);
    await publishPromise;

    await rabbitmq.close();
  });

  it('should validate exchange on first publish', async () => {
    mockConnection.createConfirmChannel.mockResolvedValue({
      ...mockChannel,
      publish: vi.fn((_ex, _rk, _msg, _opts, callback) => {
        callback(null);
        return true;
      }),
    });

    const { rabbitmq } = await import('../../src/rabbitmq.js');
    const { config } = await import('../../src/config.js');
    await rabbitmq.connect();

    const message = Buffer.from('test message');
    await rabbitmq.publish(message);

    expect(mockConnection.createChannel).toHaveBeenCalledTimes(1);
    expect(mockChannel.checkExchange).toHaveBeenCalledWith(config.RABBITMQ_EXCHANGE);
    expect(mockChannel.close).toHaveBeenCalled();

    await rabbitmq.close();
  });

  it('should cache validated exchanges and not re-validate', async () => {
    mockConnection.createConfirmChannel.mockResolvedValue({
      ...mockChannel,
      publish: vi.fn((_ex, _rk, _msg, _opts, callback) => {
        callback(null);
        return true;
      }),
    });

    const { rabbitmq } = await import('../../src/rabbitmq.js');
    await rabbitmq.connect();

    const message = Buffer.from('test message');
    await rabbitmq.publish(message);
    await rabbitmq.publish(message);
    await rabbitmq.publish(message);

    expect(mockConnection.createChannel).toHaveBeenCalledTimes(1);
    expect(mockChannel.checkExchange).toHaveBeenCalledTimes(1);

    await rabbitmq.close();
  });

  it('should throw error when exchange does not exist', async () => {
    mockConnection.createChannel.mockResolvedValue({
      ...mockChannel,
      checkExchange: vi.fn().mockRejectedValue(new Error('NOT_FOUND')),
    });

    mockConnection.createConfirmChannel.mockResolvedValue({
      ...mockChannel,
      publish: vi.fn((_ex, _rk, _msg, _opts, callback) => {
        callback(null);
        return true;
      }),
    });

    const { rabbitmq } = await import('../../src/rabbitmq.js');
    await rabbitmq.connect();

    const message = Buffer.from('test message');
    const { config } = await import('../../src/config.js');
    await expect(rabbitmq.publish(message)).rejects.toThrow(
      `Exchange '${config.RABBITMQ_EXCHANGE}' does not exist`
    );

    await rabbitmq.close();
  });

  it('should validate different exchanges separately', async () => {
    mockConnection.createConfirmChannel.mockResolvedValue({
      ...mockChannel,
      publish: vi.fn((_ex, _rk, _msg, _opts, callback) => {
        callback(null);
        return true;
      }),
    });

    const { rabbitmq } = await import('../../src/rabbitmq.js');
    await rabbitmq.connect();

    const message = Buffer.from('test message');
    await rabbitmq.publish(message, 'exchange1');
    await rabbitmq.publish(message, 'exchange2');
    await rabbitmq.publish(message, 'exchange1');

    expect(mockConnection.createChannel).toHaveBeenCalledTimes(2);
    expect(mockChannel.checkExchange).toHaveBeenCalledWith('exchange1');
    expect(mockChannel.checkExchange).toHaveBeenCalledWith('exchange2');
    expect(mockChannel.checkExchange).toHaveBeenCalledTimes(2);

    await rabbitmq.close();
  });

  it('should clear validated exchanges cache on reconnect', async () => {
    vi.useFakeTimers();
    let closeHandler: () => void;

    mockConnection.on.mockImplementation((event: string, handler: () => void) => {
      if (event === 'close') closeHandler = handler;
      return mockConnection;
    });

    mockConnection.createConfirmChannel.mockResolvedValue({
      ...mockChannel,
      publish: vi.fn((_ex, _rk, _msg, _opts, callback) => {
        callback(null);
        return true;
      }),
    });

    const { rabbitmq } = await import('../../src/rabbitmq.js');
    await rabbitmq.connect();

    const message = Buffer.from('test message');
    await rabbitmq.publish(message);

    expect(mockConnection.createChannel).toHaveBeenCalledTimes(1);

    mockAmqp.connect.mockClear();
    mockConnection.createConfirmChannel.mockClear();
    mockConnection.createChannel.mockClear();
    mockChannel.checkExchange.mockClear();

    closeHandler!();
    await vi.advanceTimersByTimeAsync(1000);

    await rabbitmq.publish(message);

    expect(mockConnection.createChannel).toHaveBeenCalledTimes(1);
    expect(mockChannel.checkExchange).toHaveBeenCalled();

    vi.useRealTimers();
    await rabbitmq.close();
  });

  it.each([
    { name: 'empty exchange uses config default', exchange: '', routingKey: 'custom.key', expectExchange: null, expectRoutingKey: 'custom.key' },
    { name: 'custom exchange and routingKey', exchange: 'custom-exchange', routingKey: 'custom.key', expectExchange: 'custom-exchange', expectRoutingKey: 'custom.key' },
    { name: 'undefined exchange and routingKey use config defaults', exchange: undefined, routingKey: undefined, expectExchange: null, expectRoutingKey: null },
    { name: 'empty routingKey uses config default', exchange: 'custom-exchange', routingKey: '', expectExchange: 'custom-exchange', expectRoutingKey: null },
    { name: 'empty exchange and routingKey use config defaults', exchange: '', routingKey: '', expectExchange: null, expectRoutingKey: null },
  ])('should publish with $name', async ({ exchange, routingKey, expectExchange, expectRoutingKey }) => {
    const publishSpy = vi.fn((_ex, _rk, _msg, _opts, callback) => {
      callback(null);
      return true;
    });

    mockConnection.createConfirmChannel.mockResolvedValue({
      ...mockChannel,
      publish: publishSpy,
    });

    const { rabbitmq } = await import('../../src/rabbitmq.js');
    const { config } = await import('../../src/config.js');
    await rabbitmq.connect();

    const message = Buffer.from('test message');
    await rabbitmq.publish(message, exchange, routingKey);

    const expectedExchange = expectExchange ?? config.RABBITMQ_EXCHANGE;
    const expectedRoutingKey = expectRoutingKey ?? config.RABBITMQ_ROUTING_KEY;

    expect(publishSpy).toHaveBeenCalledWith(
      expectedExchange,
      expectedRoutingKey,
      message,
      { persistent: true },
      expect.any(Function)
    );

    await rabbitmq.close();
  });
});
