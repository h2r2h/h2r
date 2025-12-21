import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeFileSync, unlinkSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

vi.mock('../../src/logger.js', () => ({
  logger: mockLogger,
}));

describe('plugin', () => {
  const testDir = join(tmpdir(), `h2r-plugin-test-${Date.now()}`);
  let originalPluginPath: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mkdirSync(testDir, { recursive: true });
    originalPluginPath = process.env.PLUGIN_PATH;
  });

  afterEach(() => {
    if (originalPluginPath !== undefined) {
      process.env.PLUGIN_PATH = originalPluginPath;
    } else {
      delete process.env.PLUGIN_PATH;
    }
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  describe('loadPlugin', () => {
    it('should do nothing when PLUGIN_PATH is not set', async () => {
      delete process.env.PLUGIN_PATH;

      vi.doMock('../../src/config.js', () => ({
        config: { PLUGIN_PATH: '' },
      }));

      const { loadPlugin, applyPlugin } = await import('../../src/plugin.js');
      await loadPlugin();

      const result = await applyPlugin({
        method: 'GET',
        url: '/test',
        headers: {},
        body: '',
        bodyEncoding: 'utf8',
      });

      expect(result).toEqual({ publish: true });
      expect(mockLogger.info).not.toHaveBeenCalled();
    });

    it('should load plugin from path', async () => {
      const pluginPath = join(testDir, 'test-plugin.js');
      writeFileSync(pluginPath, `
        export function plugin(input) {
          return { publish: true, statusCode: 201 };
        }
      `);

      vi.doMock('../../src/config.js', () => ({
        config: { PLUGIN_PATH: pluginPath },
      }));

      const { loadPlugin, applyPlugin } = await import('../../src/plugin.js');
      await loadPlugin();

      expect(mockLogger.info).toHaveBeenCalledWith(
        { path: pluginPath },
        'plugin_loaded'
      );

      const result = await applyPlugin({
        method: 'GET',
        url: '/test',
        headers: {},
        body: '',
        bodyEncoding: 'utf8',
      });

      expect(result.publish).toBe(true);
      expect(result.statusCode).toBe(201);
    });

    it('should load plugin with default export', async () => {
      const pluginPath = join(testDir, 'default-plugin.js');
      writeFileSync(pluginPath, `
        export default {
          plugin(input) {
            return { publish: true, statusCode: 200 };
          }
        };
      `);

      vi.doMock('../../src/config.js', () => ({
        config: { PLUGIN_PATH: pluginPath },
      }));

      const { loadPlugin, applyPlugin } = await import('../../src/plugin.js');
      await loadPlugin();

      expect(mockLogger.info).toHaveBeenCalledWith(
        { path: pluginPath },
        'plugin_loaded'
      );

      const result = await applyPlugin({
        method: 'GET',
        url: '/test',
        headers: {},
        body: '',
        bodyEncoding: 'utf8',
      });

      expect(result.publish).toBe(true);
      expect(result.statusCode).toBe(200);
    });

    it('should load plugin with default export function directly', async () => {
      const pluginPath = join(testDir, 'default-fn-plugin.js');
      writeFileSync(pluginPath, `
        const plugin = (input) => ({ publish: true, statusCode: 202 });
        export default { plugin };
      `);

      vi.doMock('../../src/config.js', () => ({
        config: { PLUGIN_PATH: pluginPath },
      }));

      const { loadPlugin, applyPlugin } = await import('../../src/plugin.js');
      await loadPlugin();

      expect(mockLogger.info).toHaveBeenCalledWith(
        { path: pluginPath },
        'plugin_loaded'
      );

      const result = await applyPlugin({
        method: 'GET',
        url: '/test',
        headers: {},
        body: '',
        bodyEncoding: 'utf8',
      });

      expect(result.publish).toBe(true);
      expect(result.statusCode).toBe(202);
    });

    it('should load plugin with default export as function', async () => {
      const pluginPath = join(testDir, 'default-export-fn.js');
      writeFileSync(pluginPath, `
        export default function(input) {
          return { publish: true, statusCode: 204 };
        }
      `);

      vi.doMock('../../src/config.js', () => ({
        config: { PLUGIN_PATH: pluginPath },
      }));

      const { loadPlugin, applyPlugin } = await import('../../src/plugin.js');
      await loadPlugin();

      expect(mockLogger.info).toHaveBeenCalledWith(
        { path: pluginPath },
        'plugin_loaded'
      );

      const result = await applyPlugin({
        method: 'GET',
        url: '/test',
        headers: {},
        body: '',
        bodyEncoding: 'utf8',
      });

      expect(result.publish).toBe(true);
      expect(result.statusCode).toBe(204);
    });

    it('should throw when plugin does not export plugin function', async () => {
      const pluginPath = join(testDir, 'invalid-plugin.js');
      writeFileSync(pluginPath, `
        export function notPlugin(input) {
          return { publish: true };
        }
      `);

      vi.doMock('../../src/config.js', () => ({
        config: { PLUGIN_PATH: pluginPath },
      }));

      const { loadPlugin } = await import('../../src/plugin.js');

      await expect(loadPlugin()).rejects.toThrow('Plugin must export a function as default or named "plugin"');
      expect(mockLogger.error).toHaveBeenCalled();
    });

    it('should throw when plugin path does not exist', async () => {
      const pluginPath = join(testDir, 'nonexistent.js');

      vi.doMock('../../src/config.js', () => ({
        config: { PLUGIN_PATH: pluginPath },
      }));

      const { loadPlugin } = await import('../../src/plugin.js');

      await expect(loadPlugin()).rejects.toThrow();
      expect(mockLogger.error).toHaveBeenCalled();
    });
  });

  describe('applyPlugin', () => {
    it('should pass all input fields to plugin', async () => {
      const pluginPath = join(testDir, 'echo-plugin.js');
      writeFileSync(pluginPath, `
        export function plugin(input) {
          return {
            publish: true,
            reason: JSON.stringify(input),
          };
        }
      `);

      vi.doMock('../../src/config.js', () => ({
        config: { PLUGIN_PATH: pluginPath },
      }));

      const { loadPlugin, applyPlugin } = await import('../../src/plugin.js');
      await loadPlugin();

      const input = {
        method: 'POST',
        url: '/webhook',
        headers: { 'content-type': 'application/json' },
        body: '{"test":true}',
        bodyEncoding: 'utf8' as const,
      };

      const result = await applyPlugin(input);
      const echoed = JSON.parse(result.reason!);

      expect(echoed.method).toBe('POST');
      expect(echoed.url).toBe('/webhook');
      expect(echoed.headers['content-type']).toBe('application/json');
      expect(echoed.body).toBe('{"test":true}');
      expect(echoed.bodyEncoding).toBe('utf8');
    });

    it('should handle async plugin', async () => {
      const pluginPath = join(testDir, 'async-plugin.js');
      writeFileSync(pluginPath, `
        export async function plugin(input) {
          await new Promise(r => setTimeout(r, 10));
          return { publish: false, reason: 'async_filter' };
        }
      `);

      vi.doMock('../../src/config.js', () => ({
        config: { PLUGIN_PATH: pluginPath },
      }));

      const { loadPlugin, applyPlugin } = await import('../../src/plugin.js');
      await loadPlugin();

      const result = await applyPlugin({
        method: 'GET',
        url: '/test',
        headers: {},
        body: '',
        bodyEncoding: 'utf8',
      });

      expect(result.publish).toBe(false);
      expect(result.reason).toBe('async_filter');
    });

    it('should return all plugin result fields', async () => {
      const pluginPath = join(testDir, 'full-result-plugin.js');
      writeFileSync(pluginPath, `
        export function plugin(input) {
          return {
            publish: true,
            statusCode: 201,
            response: { id: '123' },
            exchange: 'custom-exchange',
            routingKey: 'custom.key',
            reason: 'custom_routing',
          };
        }
      `);

      vi.doMock('../../src/config.js', () => ({
        config: { PLUGIN_PATH: pluginPath },
      }));

      const { loadPlugin, applyPlugin } = await import('../../src/plugin.js');
      await loadPlugin();

      const result = await applyPlugin({
        method: 'GET',
        url: '/test',
        headers: {},
        body: '',
        bodyEncoding: 'utf8',
      });

      expect(result.publish).toBe(true);
      expect(result.statusCode).toBe(201);
      expect(result.response).toEqual({ id: '123' });
      expect(result.exchange).toBe('custom-exchange');
      expect(result.routingKey).toBe('custom.key');
      expect(result.reason).toBe('custom_routing');
    });

    it('should propagate sync plugin exception', async () => {
      const pluginPath = join(testDir, 'throwing-plugin.js');
      writeFileSync(pluginPath, `
        export function plugin(input) {
          throw new Error('Plugin crashed');
        }
      `);

      vi.doMock('../../src/config.js', () => ({
        config: { PLUGIN_PATH: pluginPath },
      }));

      const { loadPlugin, applyPlugin } = await import('../../src/plugin.js');
      await loadPlugin();

      await expect(applyPlugin({
        method: 'GET',
        url: '/test',
        headers: {},
        body: '',
        bodyEncoding: 'utf8',
      })).rejects.toThrow('Plugin crashed');
    });

    it('should propagate async plugin exception', async () => {
      const pluginPath = join(testDir, 'async-throwing-plugin.js');
      writeFileSync(pluginPath, `
        export async function plugin(input) {
          await new Promise(r => setTimeout(r, 5));
          throw new Error('Async plugin crashed');
        }
      `);

      vi.doMock('../../src/config.js', () => ({
        config: { PLUGIN_PATH: pluginPath },
      }));

      const { loadPlugin, applyPlugin } = await import('../../src/plugin.js');
      await loadPlugin();

      await expect(applyPlugin({
        method: 'GET',
        url: '/test',
        headers: {},
        body: '',
        bodyEncoding: 'utf8',
      })).rejects.toThrow('Async plugin crashed');
    });

    it('should return partial result as-is (missing optional fields)', async () => {
      const pluginPath = join(testDir, 'minimal-plugin.js');
      writeFileSync(pluginPath, `
        export function plugin(input) {
          return { publish: false };
        }
      `);

      vi.doMock('../../src/config.js', () => ({
        config: { PLUGIN_PATH: pluginPath },
      }));

      const { loadPlugin, applyPlugin } = await import('../../src/plugin.js');
      await loadPlugin();

      const result = await applyPlugin({
        method: 'GET',
        url: '/test',
        headers: {},
        body: '',
        bodyEncoding: 'utf8',
      });

      expect(result.publish).toBe(false);
      expect(result.statusCode).toBeUndefined();
      expect(result.response).toBeUndefined();
      expect(result.exchange).toBeUndefined();
      expect(result.routingKey).toBeUndefined();
    });

    it('should throw when plugin returns null', async () => {
      const pluginPath = join(testDir, 'null-plugin.js');
      writeFileSync(pluginPath, `
        export function plugin(input) {
          return null;
        }
      `);

      vi.doMock('../../src/config.js', () => ({
        config: { PLUGIN_PATH: pluginPath },
      }));

      const { loadPlugin, applyPlugin } = await import('../../src/plugin.js');
      await loadPlugin();

      await expect(applyPlugin({
        method: 'GET',
        url: '/test',
        headers: {},
        body: '',
        bodyEncoding: 'utf8',
      })).rejects.toThrow('Plugin returned null or undefined');
    });

    it('should throw when plugin returns undefined', async () => {
      const pluginPath = join(testDir, 'undefined-plugin.js');
      writeFileSync(pluginPath, `
        export function plugin(input) {
          return undefined;
        }
      `);

      vi.doMock('../../src/config.js', () => ({
        config: { PLUGIN_PATH: pluginPath },
      }));

      const { loadPlugin, applyPlugin } = await import('../../src/plugin.js');
      await loadPlugin();

      await expect(applyPlugin({
        method: 'GET',
        url: '/test',
        headers: {},
        body: '',
        bodyEncoding: 'utf8',
      })).rejects.toThrow('Plugin returned null or undefined');
    });

    it('should throw when plugin returns non-object', async () => {
      const pluginPath = join(testDir, 'string-plugin.js');
      writeFileSync(pluginPath, `
        export function plugin(input) {
          return "invalid";
        }
      `);

      vi.doMock('../../src/config.js', () => ({
        config: { PLUGIN_PATH: pluginPath },
      }));

      const { loadPlugin, applyPlugin } = await import('../../src/plugin.js');
      await loadPlugin();

      await expect(applyPlugin({
        method: 'GET',
        url: '/test',
        headers: {},
        body: '',
        bodyEncoding: 'utf8',
      })).rejects.toThrow('Plugin returned invalid type: string');
    });

    it('should throw when plugin result missing publish field', async () => {
      const pluginPath = join(testDir, 'no-publish-plugin.js');
      writeFileSync(pluginPath, `
        export function plugin(input) {
          return { statusCode: 200 };
        }
      `);

      vi.doMock('../../src/config.js', () => ({
        config: { PLUGIN_PATH: pluginPath },
      }));

      const { loadPlugin, applyPlugin } = await import('../../src/plugin.js');
      await loadPlugin();

      await expect(applyPlugin({
        method: 'GET',
        url: '/test',
        headers: {},
        body: '',
        bodyEncoding: 'utf8',
      })).rejects.toThrow('Plugin result must have a boolean "publish" field');
    });

    it('should throw when publish is not boolean', async () => {
      const pluginPath = join(testDir, 'non-bool-publish-plugin.js');
      writeFileSync(pluginPath, `
        export function plugin(input) {
          return { publish: 1 };
        }
      `);

      vi.doMock('../../src/config.js', () => ({
        config: { PLUGIN_PATH: pluginPath },
      }));

      const { loadPlugin, applyPlugin } = await import('../../src/plugin.js');
      await loadPlugin();

      await expect(applyPlugin({
        method: 'GET',
        url: '/test',
        headers: {},
        body: '',
        bodyEncoding: 'utf8',
      })).rejects.toThrow('Plugin result must have a boolean "publish" field');
    });
  });

  describe('hasPlugin', () => {
    it('should return false when no plugin loaded', async () => {
      vi.doMock('../../src/config.js', () => ({
        config: { PLUGIN_PATH: '' },
      }));

      const { loadPlugin, hasPlugin } = await import('../../src/plugin.js');
      await loadPlugin();

      expect(hasPlugin()).toBe(false);
    });

    it('should return true when plugin loaded', async () => {
      const pluginPath = join(testDir, 'simple-plugin.js');
      writeFileSync(pluginPath, `
        export function plugin() { return { publish: true }; }
      `);

      vi.doMock('../../src/config.js', () => ({
        config: { PLUGIN_PATH: pluginPath },
      }));

      const { loadPlugin, hasPlugin } = await import('../../src/plugin.js');
      await loadPlugin();

      expect(hasPlugin()).toBe(true);
    });
  });
});

describe('plugin-route-by-path example', () => {
  it('should reject /internal paths with 403', async () => {
    const { plugin } = await import('../../examples/plugin-route-by-path.js');

    const result = plugin({
      method: 'GET',
      url: '/internal/secret',
      headers: {},
      body: '',
      bodyEncoding: 'utf8',
    });

    expect(result.publish).toBe(false);
    expect(result.statusCode).toBe(403);
    expect(result.response).toEqual({ error: 'Internal endpoints not allowed' });
  });

  it('should route /priority paths to priority exchange', async () => {
    const { plugin } = await import('../../examples/plugin-route-by-path.js');

    const result = plugin({
      method: 'POST',
      url: '/priority/urgent',
      headers: {},
      body: '',
      bodyEncoding: 'utf8',
    });

    expect(result.publish).toBe(true);
    expect(result.exchange).toBe('priority');
  });

  it('should route /webhook paths with webhook routing key', async () => {
    const { plugin } = await import('../../examples/plugin-route-by-path.js');

    const result = plugin({
      method: 'POST',
      url: '/webhook/stripe',
      headers: {},
      body: '',
      bodyEncoding: 'utf8',
    });

    expect(result.publish).toBe(true);
    expect(result.routingKey).toBe('webhook');
  });

  it('should allow other paths with defaults', async () => {
    const { plugin } = await import('../../examples/plugin-route-by-path.js');

    const result = plugin({
      method: 'GET',
      url: '/api/users',
      headers: {},
      body: '',
      bodyEncoding: 'utf8',
    });

    expect(result.publish).toBe(true);
    expect(result.exchange).toBeUndefined();
    expect(result.routingKey).toBeUndefined();
  });
});
