import { config } from './config.js';
import { logger } from './logger.js';

export interface PluginInput {
  method: string;
  url: string;
  headers: Record<string, string[]>;
  body: string;
  bodyEncoding?: 'utf8' | 'base64';
}

export interface PluginResult {
  publish: boolean;
  statusCode?: number;
  response?: unknown;
  exchange?: string;    // Override exchange (not recommended - use RABBITMQ_EXCHANGE config)
  routingKey?: string;
  reason?: string;
}

export type PluginFunction = (input: PluginInput) => PluginResult | Promise<PluginResult>;

export interface Plugin {
  plugin: PluginFunction;
}

let pluginFn: PluginFunction | null = null;

export async function loadPlugin(): Promise<void> {
  if (!config.PLUGIN_PATH) {
    return;
  }

  try {
    const mod = await import(config.PLUGIN_PATH);
    const plugin = typeof mod.default === 'function' ? mod.default : (mod.default?.plugin ?? mod.plugin);
    if (typeof plugin !== 'function') {
      throw new Error('Plugin must export a function as default or named "plugin"');
    }
    pluginFn = plugin;
    logger.info({ path: config.PLUGIN_PATH }, 'plugin_loaded');
  } catch (err) {
    logger.error({ err: (err as Error).message, path: config.PLUGIN_PATH }, 'plugin_load_failed');
    throw err;
  }
}

export async function applyPlugin(input: PluginInput): Promise<PluginResult> {
  if (!pluginFn) {
    return { publish: true };
  }

  const result = await pluginFn(input);

  if (result === null || result === undefined) {
    throw new Error('Plugin returned null or undefined');
  }

  if (typeof result !== 'object') {
    throw new Error(`Plugin returned invalid type: ${typeof result}`);
  }

  if (typeof result.publish !== 'boolean') {
    throw new Error('Plugin result must have a boolean "publish" field');
  }

  return result;
}

export function hasPlugin(): boolean {
  return pluginFn !== null;
}
