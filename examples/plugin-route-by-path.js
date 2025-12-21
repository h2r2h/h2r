/**
 * Example plugin: route messages to different exchanges/queues based on URL path.
 *
 * Usage:
 *   PLUGIN_PATH=/path/to/plugin-route-by-path.js npm start
 *
 * Behavior:
 *   - /internal/* paths are rejected with 403
 *   - /priority/* paths are routed to "priority" exchange
 *   - /webhook/* paths are routed with routing key "webhook"
 *   - All other paths use default exchange/routing
 */

export function plugin({ method, url, headers, body, bodyEncoding }) {
  if (url.startsWith('/internal')) {
    return {
      publish: false,
      statusCode: 403,
      response: { error: 'Internal endpoints not allowed' },
      reason: 'internal_endpoint',
    };
  }

  if (url.startsWith('/priority')) {
    return {
      publish: true,
      exchange: 'priority',
    };
  }

  if (url.startsWith('/webhook')) {
    return {
      publish: true,
      routingKey: 'webhook',
    };
  }

  return { publish: true };
}
