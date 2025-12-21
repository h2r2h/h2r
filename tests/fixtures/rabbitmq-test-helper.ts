import { RabbitMQContainer, type StartedRabbitMQContainer } from '@testcontainers/rabbitmq';
import * as amqp from 'amqplib';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFINITIONS_PATH = path.resolve(__dirname, 'definitions.json');

export interface RabbitMQTestConfig {
  amqpUrl: string;
  mgmtUrl: string;
  host: string;
  amqpPort: number;
  mgmtPort: number;
}

export interface RabbitMQTestContext {
  config: RabbitMQTestConfig;
  container: StartedRabbitMQContainer | null;
  isExternal: boolean;
}

interface SetupOptions {
  user?: string;
  pass?: string;
  vhost?: string;
  loadDefinitions?: boolean;
  deleteQueues?: string[];
}

function parseAmqpUrl(url: string): { host: string; port: number; user: string; pass: string; vhost: string } {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: parseInt(parsed.port || '5672', 10),
    user: parsed.username || 'guest',
    pass: parsed.password || 'guest',
    vhost: decodeURIComponent(parsed.pathname.slice(1)) || '/',
  };
}

async function deleteQueues(amqpUrl: string, queues: string[]): Promise<void> {
  if (queues.length === 0) return;

  const connection = await amqp.connect(amqpUrl);
  const channel = await connection.createChannel();

  for (const queue of queues) {
    try {
      await channel.deleteQueue(queue);
      console.log(`Deleted queue ${queue}`);
    } catch {
      // Queue might not exist
    }
  }

  await channel.close();
  await connection.close();
}

export async function setupRabbitMQ(options: SetupOptions = {}): Promise<RabbitMQTestContext> {
  const {
    user = 'my-user1',
    pass = 'my-user1',
    vhost = '/',
    loadDefinitions = true,
    deleteQueues: queuesToDelete = [],
  } = options;

  const externalUrl = process.env.EXTERNAL_RABBITMQ_URL;
  const externalMgmtUrl = process.env.EXTERNAL_RABBITMQ_MGMT_URL;

  if (externalUrl) {
    const parsed = parseAmqpUrl(externalUrl);
    const mgmtUrl = externalMgmtUrl || `http://${parsed.host}:15672`;

    console.log(`Using external RabbitMQ: ${externalUrl}`);

    if (queuesToDelete.length > 0) {
      await deleteQueues(externalUrl, queuesToDelete);
    }

    return {
      config: {
        amqpUrl: externalUrl,
        mgmtUrl,
        host: parsed.host,
        amqpPort: parsed.port,
        mgmtPort: parseInt(new URL(mgmtUrl).port || '15672', 10),
      },
      container: null,
      isExternal: true,
    };
  }

  if (process.env.KEEP_CONTAINERS) {
    process.env.TESTCONTAINERS_RYUK_DISABLED = 'true';
  }

  const container = await new RabbitMQContainer('rabbitmq:3.13-management-alpine')
    .withStartupTimeout(120000)
    .start();

  const host = container.getHost();
  const amqpPort = container.getMappedPort(5672);
  const mgmtPort = container.getMappedPort(15672);

  if (loadDefinitions) {
    const definitions = await readFile(DEFINITIONS_PATH, 'utf-8');
    const response = await fetch(`http://${host}:${mgmtPort}/api/definitions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Basic ' + Buffer.from('guest:guest').toString('base64'),
      },
      body: definitions,
    });

    if (!response.ok) {
      throw new Error(`Failed to load definitions: ${response.status} ${await response.text()}`);
    }
  }

  const amqpUrl = `amqp://${user}:${pass}@${host}:${amqpPort}${vhost}`;
  const mgmtUrl = `http://guest:guest@${host}:${mgmtPort}`;

  console.log(`Started RabbitMQ container: ${amqpUrl}`);

  return {
    config: {
      amqpUrl,
      mgmtUrl,
      host,
      amqpPort,
      mgmtPort,
    },
    container,
    isExternal: false,
  };
}

export async function teardownRabbitMQ(ctx: RabbitMQTestContext): Promise<void> {
  if (ctx.isExternal) {
    return;
  }

  if (process.env.KEEP_CONTAINERS && ctx.container) {
    console.log(`\n🐰 RabbitMQ container kept running:`);
    console.log(`   AMQP: ${ctx.config.amqpUrl}`);
    console.log(`   Management: ${ctx.config.mgmtUrl}`);
    console.log(`   Stop with: docker stop ${ctx.container.getId()}\n`);
    return;
  }

  await ctx.container?.stop();
}
