import envSchema from 'env-schema';

const schema = {
  type: 'object',
  required: ['RABBITMQ_URL', 'RABBITMQ_ROUTING_KEY'],
  properties: {
    PORT: { type: 'number', default: 8080 },
    ADMIN_PORT: { type: 'number', default: 9100 },
    HOST: { type: 'string', default: '0.0.0.0' },
    RABBITMQ_URL: { type: 'string' },
    RABBITMQ_EXCHANGE: { type: 'string', default: 'publish' },
    RABBITMQ_ROUTING_KEY: { type: 'string' },
    CHANNEL_POOL_SIZE: { type: 'number', default: 10 },
    MAX_INFLIGHT_PER_CHANNEL: { type: 'number', default: 100 },
    PLUGIN_PATH: { type: 'string', default: '' },
    MAX_BODY_SIZE: { type: 'number', default: 10 * 1024 * 1024 },
  },
} as const;

export interface Config {
  PORT: number;
  ADMIN_PORT: number;
  HOST: string;
  RABBITMQ_URL: string;
  RABBITMQ_EXCHANGE: string;
  RABBITMQ_ROUTING_KEY: string;
  CHANNEL_POOL_SIZE: number;
  MAX_INFLIGHT_PER_CHANNEL: number;
  PLUGIN_PATH: string;
  MAX_BODY_SIZE: number;
}

export function loadConfig(): Config {
  return envSchema<Config>({ schema, dotenv: { quiet: true } });
}

export const config = loadConfig();
