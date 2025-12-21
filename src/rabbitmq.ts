import amqp, { type ConfirmChannel } from 'amqplib';
import { config } from './config.js';
import { messagesPublished, messagesFailed, publishDuration, rabbitmqConnected, inflightMessages } from './metrics.js';
import { logger } from './logger.js';

type AmqpConnection = Awaited<ReturnType<typeof amqp.connect>>;

class RabbitMQClient {
  private connection: AmqpConnection | null = null;
  private channels: ConfirmChannel[] = [];
  private channelIndex = 0;
  private inflightPerChannel: Map<ConfirmChannel, number> = new Map();
  private reconnecting = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closing = false;
  private readonly maxReconnectDelay = 30000;
  private validatedExchanges = new Set<string>();

  async connect(): Promise<void> {
    try {
      this.connection = await amqp.connect(config.RABBITMQ_URL);
      this.connection.on('error', (err: Error) => this.handleConnectionError(err));
      this.connection.on('close', () => this.handleConnectionClose());

      await this.initChannelPool();
      this.reconnectAttempts = 0;
      this.validatedExchanges.clear();
      rabbitmqConnected.set(1);
      logger.info({ channel_count: config.CHANNEL_POOL_SIZE }, 'rabbitmq_connected');
    } catch (err) {
      await this.cleanup();
      throw err;
    }
  }

  private async cleanup(): Promise<void> {
    rabbitmqConnected.set(0);

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnecting = false;

    const channelsToClose = [...this.channels];
    this.channels = [];
    this.inflightPerChannel.clear();

    for (const channel of channelsToClose) {
      try {
        await channel.close();
      } catch {
        // Ignore
      }
    }

    if (this.connection) {
      try {
        await this.connection.close();
      } catch {
        // Ignore
      }
      this.connection = null;
    }
  }

  private async initChannelPool(): Promise<void> {
    if (!this.connection) throw new Error('No connection');

    this.channels = [];
    this.inflightPerChannel.clear();

    for (let i = 0; i < config.CHANNEL_POOL_SIZE; i++) {
      const channel = await this.connection.createConfirmChannel();
      channel.on('error', (err: Error) => logger.error({ err, channel: i }, 'channel_error'));
      channel.on('close', () => {
        logger.warn({ channel: i }, 'channel_closed');
        this.removeChannel(channel);
        if (this.channels.length === 0 && this.connection !== null) {
          logger.warn('all_channels_closed_reconnecting');
          this.scheduleReconnect();
        }
      });
      this.channels.push(channel);
      this.inflightPerChannel.set(channel, 0);
    }
  }

  private removeChannel(channel: ConfirmChannel): void {
    const index = this.channels.indexOf(channel);
    if (index !== -1) {
      this.channels.splice(index, 1);
    }
    const inflight = this.inflightPerChannel.get(channel) ?? 0;
    if (inflight > 0) {
      inflightMessages.dec(inflight);
      logger.warn({ lostInflight: inflight }, 'channel_removed_inflight_messages_lost');
    }
    this.inflightPerChannel.delete(channel);
    if (this.channelIndex >= this.channels.length) {
      this.channelIndex = 0;
    }
    logger.info({ remaining_channels: this.channels.length }, 'channel_removed_from_pool');
  }

  private handleConnectionError(err: Error): void {
    logger.error({ err }, 'rabbitmq_connection_error');
    rabbitmqConnected.set(0);
  }

  private handleConnectionClose(): void {
    logger.warn('rabbitmq_connection_closed');
    rabbitmqConnected.set(0);
    if (!this.closing) {
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnecting || this.closing) return;
    this.reconnecting = true;

    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), this.maxReconnectDelay);
    this.reconnectAttempts++;

    logger.info({ delay_ms: delay, attempt: this.reconnectAttempts }, 'rabbitmq_reconnect_scheduled');

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (this.closing) {
        this.reconnecting = false;
        return;
      }
      try {
        await this.connect();
        this.reconnecting = false;
      } catch (err) {
        logger.error({ err }, 'rabbitmq_reconnect_failed');
        this.reconnecting = false;
        this.scheduleReconnect();
      }
    }, delay);
  }

  private getNextChannel(): ConfirmChannel | null {
    const channels = this.channels;
    if (channels.length === 0) return null;

    const startIndex = this.channelIndex % channels.length;
    let index = startIndex;

    do {
      const channel = channels[index];
      index = (index + 1) % channels.length;

      if (!this.inflightPerChannel.has(channel)) continue;

      const inflight = this.inflightPerChannel.get(channel) ?? 0;
      if (inflight < config.MAX_INFLIGHT_PER_CHANNEL) {
        this.channelIndex = index;
        return channel;
      }
    } while (index !== startIndex);

    return null;
  }

  async publish(message: Buffer, exchange?: string, routingKey?: string): Promise<void> {
    const targetExchange = (exchange !== undefined && exchange !== '') ? exchange : config.RABBITMQ_EXCHANGE;
    const targetRoutingKey = (routingKey !== undefined && routingKey !== '') ? routingKey : config.RABBITMQ_ROUTING_KEY;

    if (!this.validatedExchanges.has(targetExchange)) {
      await this.validateExchange(targetExchange);
      this.validatedExchanges.add(targetExchange);
    }

    const channel = this.getNextChannel();
    if (!channel) {
      messagesFailed.inc();
      throw new Error('Backpressure: all channels at capacity');
    }

    const inflight = this.inflightPerChannel.get(channel) ?? 0;
    this.inflightPerChannel.set(channel, inflight + 1);
    inflightMessages.set(this.getTotalInflight());

    const startTime = Date.now();

    return new Promise<void>((resolve, reject) => {
      const handleResult = (err: Error | null) => {
        if (this.inflightPerChannel.has(channel)) {
          const current = this.inflightPerChannel.get(channel) ?? 1;
          this.inflightPerChannel.set(channel, current - 1);
          inflightMessages.set(this.getTotalInflight());
        }

        const duration = (Date.now() - startTime) / 1000;
        publishDuration.observe(duration);

        if (err) {
          messagesFailed.inc();
          reject(err);
        } else {
          messagesPublished.inc();
          resolve();
        }
      };

      try {
        channel.publish(
          targetExchange,
          targetRoutingKey,
          message,
          { persistent: true },
          handleResult
        );
      } catch (err) {
        handleResult(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private async validateExchange(exchange: string): Promise<void> {
    if (!this.connection) {
      throw new Error('No connection available for exchange validation');
    }

    const tempChannel = await this.connection.createChannel();
    try {
      await tempChannel.checkExchange(exchange);
    } catch (err) {
      throw new Error(`Exchange '${exchange}' does not exist`);
    } finally {
      await tempChannel.close();
    }
  }

  private getTotalInflight(): number {
    let total = 0;
    for (const count of this.inflightPerChannel.values()) {
      total += count;
    }
    return total;
  }

  isConnected(): boolean {
    return this.connection !== null && this.channels.length > 0;
  }

  async waitForInflight(timeoutMs: number = 5000): Promise<void> {
    const startTime = Date.now();
    const checkInterval = 50;

    while (this.getTotalInflight() > 0) {
      if (Date.now() - startTime > timeoutMs) {
        const remaining = this.getTotalInflight();
        logger.warn({ remaining_inflight: remaining, timeout_ms: timeoutMs }, 'drain_timeout');
        return;
      }
      await new Promise(resolve => setTimeout(resolve, checkInterval));
    }

    logger.info('inflight_drained');
  }

  async close(): Promise<void> {
    this.closing = true;
    await this.cleanup();
  }
}

export const rabbitmq = new RabbitMQClient();
