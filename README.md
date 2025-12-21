# h2r - HTTP to RabbitMQ Publisher

HTTP server that accepts any request and publishes it as a message to RabbitMQ for async replay.

## Usage

```bash
npm install
npm run build
npm start
```

Development mode with hot reload:
```bash
npm run dev
```

## Configuration

| Variable                   | Required | Default   | Description                                                    |
| -------------------------- | -------- | --------- | -------------------------------------------------------------- |
| `RABBITMQ_URL`             | Yes      | -         | AMQP connection URL (e.g., `amqp://user:pass@host:5672/vhost`) |
| `PORT`                     | No       | `8080`    | HTTP server port                                               |
| `ADMIN_PORT`               | No       | `9100`    | Admin/metrics server port                                      |
| `HOST`                     | No       | `0.0.0.0` | Listen address                                                 |
| `RABBITMQ_EXCHANGE`        | No       | `consume` | Exchange to publish messages to                                |
| `RABBITMQ_ROUTING_KEY`     | No       | (empty)   | Routing key for published messages                             |
| `CHANNEL_POOL_SIZE`        | No       | `10`      | Number of RabbitMQ channels in the pool                        |
| `MAX_INFLIGHT_PER_CHANNEL` | No       | `100`     | Max concurrent publishes per channel                           |
| `PLUGIN_PATH`              | No       | (empty)   | Path to optional plugin module                                 |
| `MAX_BODY_SIZE`            | No       | `10485760` (10MB) | Max request body size in bytes (returns 413 if exceeded) |

Supports `.env` files.

## Endpoints

### HTTP Server (PORT)

- `* /*` - All HTTP requests are captured and queued

Returns `202 Accepted` on success, `503` if RabbitMQ unavailable or under backpressure.

### Admin Server (ADMIN_PORT)

- `GET /healthz` - Health check (200 if RabbitMQ connected, 503 otherwise)
- `GET /metrics` - Prometheus metrics

## Message Format

Messages are published as JSON with envelope:

```json
{
  "metadata": {
    "metadata_version": "v1",
    "created_at": "2024-01-15T10:30:00.000Z",
    "traceparent": "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
    "message_type": "h2r",
    "message_version": "v1"
  },
  "content": {
    "method": "POST",
    "url": "/api/webhook?id=123",
    "headers": {"content-type": ["application/json"], "x-custom": ["value"]},
    "body": "...",
    "bodyEncoding": "utf8"
  }
}
```

### Metadata fields

| Field              | Required | Description                                                    |
| ------------------ | -------- | -------------------------------------------------------------- |
| `metadata_version` | Yes      | Always `v1`                                                    |
| `created_at`       | Yes      | ISO8601 timestamp (UTC)                                        |
| `traceparent`      | No       | W3C trace context (forwarded from incoming request if present) |
| `message_type`     | No       | Always `h2r`                                                   |
| `message_version`  | No       | Always `v1`                                                    |

### Content fields

| Field          | Description                             |
| -------------- | --------------------------------------- |
| `method`       | HTTP method                             |
| `url`          | Request URL (path + query string)       |
| `headers`      | Request headers (arrays of values)      |
| `body`         | Request body                            |
| `bodyEncoding` | `utf8` for text, `base64` for binary    |

## Metrics

| Metric                         | Type      | Description                     |
| ------------------------------ | --------- | ------------------------------- |
| `h2r_messages_published_total` | Counter   | Successfully published messages |
| `h2r_messages_failed_total`    | Counter   | Failed publish attempts         |
| `h2r_publish_duration_seconds` | Histogram | Publish latency                 |
| `h2r_rabbitmq_connected`       | Gauge     | Connection state (1=up)         |
| `h2r_inflight_messages`        | Gauge     | Current in-flight publishes     |

## Plugin

Optional request processing via external module. Set `PLUGIN_PATH` to a JS module path.

Plugin interface:
```typescript
export interface PluginInput {
  method: string;
  url: string;
  headers: Record<string, string[]>;
  body: string;
  bodyEncoding: 'utf8' | 'base64';
}

export interface PluginResult {
  publish: boolean;        // false = skip RabbitMQ, return response directly
  statusCode?: number;     // override HTTP status (default 202 on publish, 200 on filter)
  response?: unknown;      // override response body
  exchange?: string;       // override target exchange (empty string or undefined = use RABBITMQ_EXCHANGE)
  routingKey?: string;     // override routing key (empty string or undefined = use RABBITMQ_ROUTING_KEY)
  reason?: string;         // logged when filtering
}

export function plugin(input: PluginInput): PluginResult | Promise<PluginResult>;
```

**Note on `exchange` and `routingKey` behavior:**
- `undefined`: Uses the default from `RABBITMQ_EXCHANGE` or `RABBITMQ_ROUTING_KEY`
- Empty string (`''`): Also falls back to the default (same as `undefined`)
- Non-empty string: Uses the provided value

Plugins can use either named exports or default exports:

**Named export:**
```javascript
export function plugin({ url }) {
  if (url.startsWith('/internal')) {
    return { publish: false, statusCode: 403, response: { error: 'Forbidden' } };
  }
  if (url.startsWith('/priority')) {
    return { publish: true, exchange: 'priority' };
  }
  return { publish: true };
}
```

**Default export (function):**
```javascript
export default function({ url }) {
  if (url.startsWith('/internal')) {
    return { publish: false, statusCode: 403, response: { error: 'Forbidden' } };
  }
  if (url.startsWith('/priority')) {
    return { publish: true, exchange: 'priority' };
  }
  return { publish: true };
}
```

## Testing

```bash
npm run test:unit          # Unit tests only
npm run test:e2e           # E2E tests (starts RabbitMQ via testcontainers)
npm test                   # All tests
```

### Reusing RabbitMQ container

Keep the container running after tests for faster re-runs:

```bash
KEEP_CONTAINERS=true npm run test:e2e
```

Output shows connection details:
```
🐰 RabbitMQ container kept running:
   AMQP: amqp://my-user1:my-user1@localhost:32825/
   Management: http://guest:guest@localhost:32826
   Stop with: docker stop <container_id>
```

### Using external RabbitMQ

Run tests against an existing RabbitMQ instance:

```bash
EXTERNAL_RABBITMQ_URL=amqp://my-user1:my-user1@localhost:32825/ npm run test:e2e
```

## Behavior

- Uses a pool of confirm channels for throughput
- Automatic reconnection with exponential backoff (max 30s)
- Backpressure: returns 503 when all channels at capacity
- Messages published with `persistent: true`
