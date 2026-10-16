import "reflect-metadata";
import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { Client } from "pg";
import { MikroORM } from "@mikro-orm/postgresql";
import { Module, type INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { DeleteQueueCommand } from "@aws-sdk/client-sqs";
import config from "../../database/orm.config";
import { DatabaseService } from "../../database/database.service";
import { HealthController } from "../../health/health.controller";
import { ReadinessService } from "../../health/readiness.service";
import { MetricsController } from "../metrics.controller";
import { OpenWallet } from "../../wallets/open-wallet";
import { ProcessTransaction } from "../../wagering/process-transaction";
import { createSqsClient, setupQueues, sendJson, type QueueUrls } from "../../messaging/sqs";
import { operationalMetrics } from "../metrics";

const dbName = `obs_${crypto.randomUUID().replaceAll("-", "")}`;
const admin = new Client({ host: config.host, port: config.port, user: config.user, password: config.password, database: "postgres" });
const client = createSqsClient();
let queues: QueueUrls;
let orm: MikroORM;
let app: INestApplication;
let url: string;
let created = false;
const oldPrefix = process.env.SQS_QUEUE_PREFIX;

async function server(database: Pick<DatabaseService, "createEntityManager">) {
  @Module({ controllers: [HealthController, MetricsController],
    providers: [{ provide: DatabaseService, useValue: database }, ReadinessService] })
  class TestModule {}
  const instance = await NestFactory.create(TestModule, { logger: false, abortOnError: false });
  await instance.listen(0, "127.0.0.1");
  return instance;
}
beforeAll(async () => {
  await admin.connect();
  await admin.query(`CREATE DATABASE "${dbName}"`);
  created = true;
  orm = await MikroORM.init({ ...config, dbName, migrations: { ...config.migrations, snapshot: false } });
  await orm.migrator.up();
  queues = await setupQueues(client, dbName);
  process.env.SQS_QUEUE_PREFIX = dbName;
  app = await server({ createEntityManager: () => orm.em.fork() });
  url = await app.getUrl();
}, 30000);
afterAll(async () => {
  try {
    await app?.close();
    if (queues) for (const QueueUrl of Object.values(queues)) await client.send(new DeleteQueueCommand({ QueueUrl }));
  } finally {
    client.destroy();
    await orm?.close();
    if (oldPrefix === undefined) delete process.env.SQS_QUEUE_PREFIX; else process.env.SQS_QUEUE_PREFIX = oldPrefix;
    if (created && /^obs_[a-f0-9]{32}$/.test(dbName)) await admin.query(`DROP DATABASE "${dbName}" WITH (FORCE)`);
    await admin.end();
  }
}, 30000);

test("liveness e readiness respondem 200 com PostgreSQL e filas reais acessiveis", async () => {
  expect((await fetch(`${url}/health/live`)).status).toBe(200);
  const ready = await fetch(`${url}/health/ready`);
  expect(ready.status).toBe(200);
  expect(await ready.json()).toEqual({ status: "ok", dependencies: { postgres: "up", sqs: "up" } });
  const metrics = await (await fetch(`${url}/metrics`)).text();
  expect(metrics).toContain("outbox_lag_seconds 0\n");
  expect(metrics).toContain("outbox_pending 0\n");
});

test("fila inexistente retorna 503 sem afetar liveness e recupera quando disponivel", async () => {
  process.env.SQS_QUEUE_PREFIX = `${dbName}-missing`;
  try {
    const ready = await fetch(`${url}/health/ready`);
    expect(ready.status).toBe(503);
    expect(await ready.json()).toMatchObject({ dependencies: { postgres: "up", sqs: "down" } });
    expect((await fetch(`${url}/health/live`)).status).toBe(200);
  } finally { process.env.SQS_QUEUE_PREFIX = dbName; }
  expect((await fetch(`${url}/health/ready`)).status).toBe(200);
});

test("PostgreSQL inacessivel retorna 503 em tempo limitado e liveness continua vivo", async () => {
  const unavailable = await MikroORM.init({ ...config, dbName, port: 1 });
  const instance = await server({ createEntityManager: () => unavailable.em.fork() });
  try {
    const address = await instance.getUrl();
    const started = performance.now();
    const ready = await fetch(`${address}/health/ready`);
    expect(ready.status).toBe(503);
    expect(await ready.json()).toMatchObject({ dependencies: { postgres: "down", sqs: "up" } });
    expect(performance.now() - started).toBeLessThan(6000);
    expect((await fetch(`${address}/health/live`)).status).toBe(200);
  } finally { await instance.close(); await unavailable.close(); }
}, 10000);

test("SQS inacessivel retorna 503 sem expor endereco ou credenciais", async () => {
  const oldEndpoint = process.env.SQS_ENDPOINT;
  process.env.SQS_ENDPOINT = "http://127.0.0.1:1";
  const instance = await server({ createEntityManager: () => orm.em.fork() });
  try {
    const ready = await fetch(`${await instance.getUrl()}/health/ready`);
    expect(ready.status).toBe(503);
    const text = await ready.text();
    expect(JSON.parse(text)).toMatchObject({ dependencies: { postgres: "up", sqs: "down" } });
    expect(text).not.toContain("127.0.0.1");
    expect(text).not.toContain("test");
  } finally {
    await instance.close();
    if (oldEndpoint === undefined) delete process.env.SQS_ENDPOINT; else process.env.SQS_ENDPOINT = oldEndpoint;
  }
}, 10000);

test("metricas persistentes por status, duplicatas, latencia e lag refletem operacoes reais", async () => {
  const wallet = await new OpenWallet(orm.em.fork()).execute({ playerId: crypto.randomUUID(), initialBalance: { amount: "100.00", currency: "BRL" } });
  const input = { providerId: "provider-a", externalTransactionId: crypto.randomUUID(), playerId: wallet.playerId,
    walletId: wallet.id, roundId: "round", gameId: "game", kind: "BET", money: { amount: "80.00", currency: "BRL" } };
  const log = spyOn(console, "log").mockImplementation(() => {});
  const before = operationalMetrics.duplicates;
  try {
    const first = await new ProcessTransaction(orm.em.fork()).execute(input, "bet-key");
    await new ProcessTransaction(orm.em.fork()).execute(input, "bet-key");
    await new ProcessTransaction(orm.em.fork()).execute({ ...input, externalTransactionId: crypto.randomUUID() }, "rejected-key");
    expect(operationalMetrics.duplicates).toBe(before + 1);
    const records = log.mock.calls.map(call => JSON.parse(call[0] as string)).filter(row => row.event === "transaction_completed");
    expect(records[0]).toMatchObject({ transactionId: first.transactionId, walletId: wallet.id, providerId: "provider-a", correlationId: first.transactionId });
    expect(JSON.stringify(records)).not.toContain("80.00");
    const response = await fetch(`${url}/metrics`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    const output = await response.text();
    expect(output).toContain('wager_transactions{status="PROCESSED"} 2');
    expect(output).toContain('wager_transactions{status="REJECTED"} 1');
    expect(output).toContain("outbox_pending 5");
    expect(output).toContain(`wager_duplicates_total ${before + 1}`);
    expect(output).toContain("transaction_processing_seconds_sum");
    expect(Number(output.match(/^outbox_lag_seconds (.+)$/m)?.[1])).toBeGreaterThan(0);
    expect(output).not.toContain(wallet.id);
  } finally { log.mockRestore(); }
});

test("metrica de DLQ consulta o broker e distingue indisponibilidade de fila vazia", async () => {
  await sendJson(client, queues.deadLetters, { diagnostic: "test" }, "test", crypto.randomUUID());
  const output = await (await fetch(`${url}/metrics`)).text();
  expect(output).toContain("sqs_dlq_messages 1\n");
  expect(output).toContain("sqs_metrics_up 1\n");
  process.env.SQS_QUEUE_PREFIX = `${dbName}-missing`;
  try {
    const degraded = await fetch(`${url}/metrics`);
    expect(degraded.status).toBe(200);
    const text = await degraded.text();
    expect(text).toContain("sqs_metrics_up 0\n");
    expect(text).not.toContain("sqs_dlq_messages");
    expect(text).toContain("outbox_pending");
  } finally { process.env.SQS_QUEUE_PREFIX = dbName; }
});
