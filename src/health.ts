import { rabbitmq } from './rabbitmq.js';

export interface HealthStatus {
  status: 'ok' | 'degraded';
  rabbitmq: 'connected' | 'disconnected';
}

export interface HealthCheck {
  connected: boolean;
  status: HealthStatus;
}

export function getHealthCheck(): HealthCheck {
  const connected = rabbitmq.isConnected();
  return {
    connected,
    status: {
      status: connected ? 'ok' : 'degraded',
      rabbitmq: connected ? 'connected' : 'disconnected',
    },
  };
}
