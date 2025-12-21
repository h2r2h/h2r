import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('logger', () => {
  const originalEnv = process.env;
  const originalIsTTY = process.stdout.isTTY;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
    Object.defineProperty(process.stdout, 'isTTY', { value: originalIsTTY });
  });

  describe('shouldLogRequest', () => {
    it('should return false for health endpoint with 200', async () => {
      const { shouldLogRequest } = await import('../../src/logger.js');
      expect(shouldLogRequest('/health', 200)).toBe(false);
    });

    it('should return true for health endpoint with 503', async () => {
      const { shouldLogRequest } = await import('../../src/logger.js');
      expect(shouldLogRequest('/health', 503)).toBe(true);
    });

    it('should return false for healthz with 200', async () => {
      const { shouldLogRequest } = await import('../../src/logger.js');
      expect(shouldLogRequest('/healthz', 200)).toBe(false);
    });

    it('should return false for metrics with 200', async () => {
      const { shouldLogRequest } = await import('../../src/logger.js');
      expect(shouldLogRequest('/metrics', 200)).toBe(false);
    });

    it('should return true for regular endpoints', async () => {
      const { shouldLogRequest } = await import('../../src/logger.js');
      expect(shouldLogRequest('/api/test', 200)).toBe(true);
      expect(shouldLogRequest('/webhook', 202)).toBe(true);
      expect(shouldLogRequest('/test', 500)).toBe(true);
    });
  });

  describe('createLogger', () => {
    it('should create logger with default level', async () => {
      const { createLogger } = await import('../../src/logger.js');
      const logger = createLogger();
      expect(logger).toBeDefined();
      expect(logger.level).toBe('info');
    });

    it('should create logger with custom level', async () => {
      const { createLogger } = await import('../../src/logger.js');
      const logger = createLogger({ level: 'debug' });
      expect(logger.level).toBe('debug');
    });

    it('should respect LOG_LEVEL env var', async () => {
      process.env.LOG_LEVEL = 'warn';
      const { createLogger } = await import('../../src/logger.js');
      const logger = createLogger();
      expect(logger.level).toBe('warn');
    });
  });
});
