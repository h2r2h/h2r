import type { FastifyRequest } from 'fastify';

export function getClientIp(request: FastifyRequest): string {
  const xff = request.headers['x-forwarded-for'];
  return Array.isArray(xff) ? (xff[0] || request.ip) : (xff || request.ip);
}
