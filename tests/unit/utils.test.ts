import { describe, it, expect } from 'vitest';
import { getClientIp } from '../../src/utils.js';
import type { FastifyRequest } from 'fastify';

describe('getClientIp', () => {
  it('returns first element when x-forwarded-for is an array', () => {
    const request = {
      headers: {
        'x-forwarded-for': ['192.168.1.1', '10.0.0.1'],
      },
      ip: '127.0.0.1',
    } as unknown as FastifyRequest;

    expect(getClientIp(request)).toBe('192.168.1.1');
  });

  it('returns string value when x-forwarded-for is a string', () => {
    const request = {
      headers: {
        'x-forwarded-for': '192.168.1.1',
      },
      ip: '127.0.0.1',
    } as unknown as FastifyRequest;

    expect(getClientIp(request)).toBe('192.168.1.1');
  });

  it('returns request.ip when x-forwarded-for is undefined', () => {
    const request = {
      headers: {},
      ip: '127.0.0.1',
    } as unknown as FastifyRequest;

    expect(getClientIp(request)).toBe('127.0.0.1');
  });

  it('handles empty array by falling back to request.ip', () => {
    const request = {
      headers: {
        'x-forwarded-for': [],
      },
      ip: '127.0.0.1',
    } as unknown as FastifyRequest;

    expect(getClientIp(request)).toBe('127.0.0.1');
  });

  it('handles single-element array', () => {
    const request = {
      headers: {
        'x-forwarded-for': ['192.168.1.1'],
      },
      ip: '127.0.0.1',
    } as unknown as FastifyRequest;

    expect(getClientIp(request)).toBe('192.168.1.1');
  });
});
