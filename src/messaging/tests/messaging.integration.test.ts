import "reflect-metadata";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { DatabaseService } from "../../database/database.service";
import { WageringController } from "../../wagering/wagering.controller";
import { TransactionQueriesController } from "../../wagering/transaction-queries.controller";
import { Client } from "pg";
import { MikroORM } from "@mikro-orm/postgresql";
import { ChangeMessageVisibilityCommand, DeleteMessageCommand, DeleteQueueCommand, ReceiveMessageCommand } from "@aws-sdk/client-sqs";
import config from "../../database/orm.config";
import { OpenWallet } from "../../wallets/open-wallet";
import { ProcessTransaction } from "../../wagering/process-transaction";
import { InboxSchema, OutboxSchema } from "../message.schema";
import { createSqsClient, setupQueues, sendJson, type QueueUrls } from "../sqs";
import { SqsConsumer } from "../sqs.consumer";
import { OutboxPublisher } from "../outbox.publisher";
import { MessagingWorker } from "../messaging.worker";
import { operationalMetrics } from "../../observability/metrics";
import { DeadLetterConsumer } from "../dead-letter.consumer";
import { DeadLetterSchema } from "../dead-letter.schema";

const dbName = `messaging_test_${crypto.randomUUID().replaceAll("-", "")}`;
const admin = new Client({ host: config.host, port: config.port, user: config.user, password: config.password, database: "postgres" });
const client = createSqsClient();
let orm: MikroORM;
let queues: QueueUrls;
let created = false;
beforeAll(async () => {
  await admin.connect();
  await admin.query(`CREATE DATABASE "${dbName}"`);
  created = true;
  orm = await MikroORM.init({ ...config, dbName, migrations: { ...config.migrations, snapshot: false } });
  await orm.migrator.up();
  queues = await setupQueues(client, dbName);
}, 30000);

test("worker agendado consome e publica; desligamento aguarda trabalho em andamento", async () => {
  const { input, envelope } = await fixture();
  const workerQueues = await setupQueues(client, `${dbName}-w`);
  const previousPrefix = process.env.SQS_QUEUE_PREFIX;
  process.env.SQS_QUEUE_PREFIX = `${dbName}-w`;
  const worker = new MessagingWorker({ createEntityManager: () => orm.em.fork() });
  try {
    await sendJson(client, workerQueues.transactions, envelope, input.walletId, crypto.randomUUID());
    worker.onApplicationBootstrap();
    const deadline = Date.now() + 10000;
    let done = false;
    while (Date.now() < deadline) {
      const inbox = await orm.em.fork().count(InboxSchema, { messageId: envelope.messageId });
      const published = await orm.em.fork().count(OutboxSchema, { aggregateId: input.walletId, publishedAt: { $ne: null } });
      if (inbox === 1 && published === 4) { done = true; break; }
      await Bun.sleep(100);
    }
    expect(done).toBe(true);
    await assertConsistent(input.walletId, "20.00");
  } finally {
    await worker.beforeApplicationShutdown();
    for (const QueueUrl of Object.values(workerQueues)) await client.send(new DeleteQueueCommand({ QueueUrl }));
    if (previousPrefix === undefined) delete process.env.SQS_QUEUE_PREFIX;
    else process.env.SQS_QUEUE_PREFIX = previousPrefix;
  }
}, 15000);
afterAll(async () => {
  try {
    if (queues) for (const QueueUrl of Object.values(queues)) await client.send(new DeleteQueueCommand({ QueueUrl }));
  } finally {
    client.destroy();
    await orm?.close();
    if (created && /^messaging_test_[a-f0-9]{32}$/.test(dbName)) await admin.query(`DROP DATABASE "${dbName}" WITH (FORCE)`);
    await admin.end();
  }
}, 30000);

async function fixture() {
  const wallet = await new OpenWallet(orm.em.fork()).execute({ playerId: crypto.randomUUID(), initialBalance: { amount: "100.00", currency: "BRL" } });
  const input = { providerId: "provider-a", externalTransactionId: crypto.randomUUID(), playerId: wallet.playerId,
    walletId: wallet.id, roundId: "round", gameId: "game", kind: "BET", money: { amount: "80.00", currency: "BRL" } };
  const key = input.externalTransactionId;
  const envelope = { messageId: crypto.randomUUID(), type: "WagerTransactionRequested", occurredAt: new Date().toISOString(), data: { ...input, idempotencyKey: key } };
  return { wallet, input, key, envelope };
}
const consumer = () => new SqsConsumer(orm.em.fork(), client, queues);
const auditor = () => new DeadLetterConsumer(orm.em.fork(), client, queues.deadLetters);
async function assertConsistent(walletId: string, balance: string) {
  const rows = await orm.em.fork().execute(`SELECT w.balance::text AS balance,
    w.balance = coalesce(sum(CASE WHEN l.direction = 'CREDIT' THEN l.amount ELSE -l.amount END), 0) AS consistent
    FROM wallets w LEFT JOIN wallet_ledger_entries l ON w.id = l.wallet_id WHERE w.id = ? GROUP BY w.id`, [walletId]);
  expect(rows).toEqual([{ balance, consistent: true }]);
}

test("HTTP e SQS compartilham idempotencia; redelivery usa inbox persistente", async () => {
  const { input, key, envelope } = await fixture();
  const original = await new ProcessTransaction(orm.em.fork()).execute(input, key);
  for (let i = 0; i < 2; i++) {
    await sendJson(client, queues.transactions, envelope, input.walletId, crypto.randomUUID());
    expect(await consumer().consumeOnce()).toBe(true);
  }
  expect(await orm.em.fork().count(InboxSchema, { messageId: envelope.messageId })).toBe(1);
  const saved = await orm.em.fork().findOneOrFail(InboxSchema, { messageId: envelope.messageId });
  expect(saved.response?.transactionId).toBe(original.transactionId);
  expect(await orm.em.fork().count(OutboxSchema, { aggregateId: input.walletId })).toBe(4); // abertura + BET
  await assertConsistent(input.walletId, "20.00");
});

test("falha ao gravar outbox desfaz inbox, transacao, saldo e ledger", async () => {
  const { input, key, envelope } = await fixture();
  await orm.em.fork().execute(`ALTER TABLE outbox_messages ADD CONSTRAINT injected_failure CHECK (aggregate_id <> '${input.walletId}') NOT VALID`);
  try {
    await expect(new ProcessTransaction(orm.em.fork()).execute(input, key, { consumerName: "wager-transactions", messageId: envelope.messageId })).rejects.toThrow();
    expect(await orm.em.fork().count(InboxSchema, { messageId: envelope.messageId })).toBe(0);
    const rows = await orm.em.fork().execute("SELECT id FROM wager_transactions WHERE external_transaction_id = ?", [input.externalTransactionId]);
    expect(rows).toHaveLength(0);
    expect(await orm.em.fork().count(OutboxSchema, { aggregateId: input.walletId })).toBe(2);
    await assertConsistent(input.walletId, "100.00");
  } finally { await orm.em.fork().execute("ALTER TABLE outbox_messages DROP CONSTRAINT injected_failure"); }
  await consumer().process({ Body: JSON.stringify(envelope) });
  await assertConsistent(input.walletId, "20.00");
});

test("messageId repetido com payload diferente vai para DLQ sem novo debito", async () => {
  const { input, envelope } = await fixture();
  await consumer().process({ Body: JSON.stringify(envelope) });
  const changed = { ...envelope, data: { ...envelope.data, money: { amount: "1.00", currency: "BRL" } } };
  await sendJson(client, queues.transactions, changed, input.walletId, crypto.randomUUID());
  await consumer().consumeOnce();
  const result = await client.send(new ReceiveMessageCommand({ QueueUrl: queues.deadLetters, WaitTimeSeconds: 1 }));
  expect(JSON.parse(result.Messages![0]!.Body!).messageId).toBe(envelope.messageId);
  await client.send(new DeleteMessageCommand({ QueueUrl: queues.deadLetters, ReceiptHandle: result.Messages![0]!.ReceiptHandle }));
  await assertConsistent(input.walletId, "20.00");
});

test("rejeicao financeira recebe ack e nao produz evento de saldo", async () => {
  const { input, envelope } = await fixture();
  envelope.data.money.amount = "200.00";
  await sendJson(client, queues.transactions, envelope, input.walletId, crypto.randomUUID());
  await consumer().consumeOnce();
  const record = await orm.em.fork().findOneOrFail(InboxSchema, { messageId: envelope.messageId });
  expect(record.response?.status).toBe("REJECTED");
  const events = await orm.em.fork().find(OutboxSchema, { aggregateId: input.walletId });
  expect(events.map(e => e.eventType).sort()).toEqual(["WagerTransactionProcessed", "WagerTransactionRejected", "WalletBalanceChanged"]);
  expect(await consumer().receive()).toBeUndefined();
  await assertConsistent(input.walletId, "100.00");
});

test("dois publishers publicam outbox confirmada; evento publicado nao volta a ser selecionado", async () => {
  const count = await orm.em.fork().count(OutboxSchema, { publishedAt: null });
  const publish = async () => {
    const worker = new OutboxPublisher(orm.em.fork(), client, queues.events);
    while (await worker.publishOnce()) { /* drena o banco isolado */ }
  };
  await Promise.all([publish(), publish()]);
  expect(await orm.em.fork().count(OutboxSchema, { publishedAt: null })).toBe(0);
  const ids = new Set<string>();
  while (ids.size < count) {
    const result = await client.send(new ReceiveMessageCommand({ QueueUrl: queues.events, MaxNumberOfMessages: 10, WaitTimeSeconds: 1 }));
    if (!result.Messages?.length) break;
    for (const message of result.Messages) {
      const event = JSON.parse(message.Body!);
      expect(ids.has(event.eventId)).toBe(false);
      ids.add(event.eventId);
      expect(event.version).toBe(1);
      await client.send(new DeleteMessageCommand({ QueueUrl: queues.events, ReceiptHandle: message.ReceiptHandle }));
    }
  }
  expect(ids.size).toBe(count);
  expect(await new OutboxPublisher(orm.em.fork(), client, queues.events).publishOnce()).toBe(false);
}, 30000);

test("DLQ arquiva mensagem e FAILED com inbox/outbox, sem saldo ou ledger novos", async () => {
  const { input, key, envelope } = await fixture();
  await sendJson(client, queues.deadLetters, envelope, input.walletId, crypto.randomUUID());
  expect(await auditor().consumeOnce()).toBe(true);
  const inbox = await orm.em.fork().findOneOrFail(InboxSchema, { messageId: envelope.messageId });
  expect(inbox.response).toMatchObject({ status: "FAILED", failureCode: "INFRASTRUCTURE_RETRY_EXHAUSTED", balance: { amount: "100.00" } });
  const id = inbox.response!.transactionId;
  const archive = await orm.em.fork().findOneOrFail(DeadLetterSchema, { transactionId: id });
  expect(JSON.parse(archive.body)).toEqual(envelope);
  expect(archive.outcome).toBe("FAILED");
  expect(await orm.em.fork().count(OutboxSchema, { aggregateId: input.walletId })).toBe(3);
  expect(await orm.em.fork().count(OutboxSchema, { aggregateId: input.walletId, eventType: "WagerTransactionFailed" })).toBe(1);
  await assertConsistent(input.walletId, "100.00");
  // Outra operacao muda o saldo; replay da falha ainda devolve o saldo original.
  await new ProcessTransaction(orm.em.fork()).execute({ ...input, externalTransactionId: crypto.randomUUID(), money: { amount: "1.00", currency: "BRL" } }, crypto.randomUUID());
  expect(await new ProcessTransaction(orm.em.fork()).execute(input, key)).toMatchObject({ status: "FAILED", idempotentReplay: true, balance: { amount: "100.00" } });
  await expect(orm.em.fork().nativeDelete(DeadLetterSchema, { messageId: archive.messageId })).rejects.toThrow("immutable");
  await expect(orm.em.fork().execute("UPDATE wager_transactions SET status = 'PENDING' WHERE id = ?", [id])).rejects.toThrow("immutable");
  const leftover = await client.send(new ReceiveMessageCommand({ QueueUrl: queues.deadLetters, WaitTimeSeconds: 1 }));
  expect(leftover.Messages ?? []).toHaveLength(0);
});

test("FAILED HTTP e consultavel e replay tem 500 com codigo terminal explicito", async () => {
  const { input, key, envelope } = await fixture();
  const archived = await auditor().archive({ MessageId: crypto.randomUUID(), Body: JSON.stringify(envelope) });
  @Module({ controllers: [WageringController, TransactionQueriesController],
    providers: [{ provide: DatabaseService, useValue: { createEntityManager: () => orm.em.fork() } }] })
  class FailedTestModule {}
  const app = await NestFactory.create(FailedTestModule, { logger: false, abortOnError: false });
  try {
    await app.listen(0, "127.0.0.1");
    const url = await app.getUrl();
    const replay = await fetch(`${url}/wagering/transactions`, { method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify(input) });
    expect(replay.status).toBe(500);
    expect(await replay.json()).toMatchObject({ status: "FAILED", failureCode: "INFRASTRUCTURE_RETRY_EXHAUSTED", idempotentReplay: true });
    const query = await fetch(`${url}/wagering/transactions/${archived.transactionId}`);
    expect(query.status).toBe(200);
    expect(await query.json()).toMatchObject({ status: "FAILED", failureCode: "INFRASTRUCTURE_RETRY_EXHAUSTED" });
  } finally { await app.close(); }
});

test("auditoria de DLQ nao sobrescreve PROCESSED nem PENDING_REFERENCE", async () => {
  const { input, key, envelope } = await fixture();
  const processed = await new ProcessTransaction(orm.em.fork()).execute(input, key);
  const record = await auditor().archive({ MessageId: crypto.randomUUID(), Body: JSON.stringify(envelope) });
  expect(record).toMatchObject({ outcome: "PROCESSED", transactionId: processed.transactionId });
  expect(await orm.em.fork().count(OutboxSchema, { aggregateId: input.walletId, eventType: "WagerTransactionFailed" })).toBe(0);
  await assertConsistent(input.walletId, "20.00");
  const pendingInput = { ...input, kind: "REFUND", externalTransactionId: crypto.randomUUID(), referenceExternalTransactionId: crypto.randomUUID() };
  const pending = await new ProcessTransaction(orm.em.fork()).execute(pendingInput, pendingInput.externalTransactionId);
  const pendingEnvelope = { ...envelope, messageId: crypto.randomUUID(), data: { ...pendingInput, idempotencyKey: pendingInput.externalTransactionId } };
  const waiting = await auditor().archive({ MessageId: crypto.randomUUID(), Body: JSON.stringify(pendingEnvelope) });
  expect(waiting).toMatchObject({ outcome: "PENDING_REFERENCE", transactionId: pending.transactionId });
});

test("auditores concorrentes e redelivery depois do commit produzem um FAILED e um evento", async () => {
  const { input, envelope } = await fixture();
  const message = { MessageId: crypto.randomUUID(), Body: JSON.stringify(envelope) };
  const records = await Promise.all(Array.from({ length: 3 }, () => auditor().archive(message)));
  expect(new Set(records.map(row => row.transactionId)).size).toBe(1);
  expect(await orm.em.fork().count(DeadLetterSchema, { messageId: message.MessageId })).toBe(1);
  await auditor().archive(message);
  expect(await orm.em.fork().count(OutboxSchema, { aggregateId: input.walletId, eventType: "WagerTransactionFailed" })).toBe(1);
  await assertConsistent(input.walletId, "100.00");
});

test("falha de auditoria mantem DLQ recuperavel; rollback desfaz FAILED, inbox, outbox e arquivo", async () => {
  const { input, envelope } = await fixture();
  await sendJson(client, queues.deadLetters, envelope, input.walletId, crypto.randomUUID());
  const received = await client.send(new ReceiveMessageCommand({ QueueUrl: queues.deadLetters, WaitTimeSeconds: 1 }));
  const message = received.Messages![0]!;
  await orm.em.fork().execute(`ALTER TABLE dead_letter_messages ADD CONSTRAINT injected_archive_failure CHECK (transaction_id IS NULL) NOT VALID`);
  try {
    await expect(auditor().archive(message)).rejects.toThrow();
    expect(await orm.em.fork().count(InboxSchema, { messageId: envelope.messageId })).toBe(0);
    expect(await orm.em.fork().count(DeadLetterSchema, { messageId: message.MessageId! })).toBe(0);
    expect(await orm.em.fork().count(OutboxSchema, { aggregateId: input.walletId })).toBe(2);
    expect(await orm.em.fork().execute("SELECT id FROM wager_transactions WHERE external_transaction_id = ?", [input.externalTransactionId])).toHaveLength(0);
  } finally { await orm.em.fork().execute("ALTER TABLE dead_letter_messages DROP CONSTRAINT injected_archive_failure"); }
  await client.send(new ChangeMessageVisibilityCommand({ QueueUrl: queues.deadLetters, ReceiptHandle: message.ReceiptHandle, VisibilityTimeout: 0 }));
  const restarted = await MikroORM.init({ ...config, dbName });
  try { expect(await new DeadLetterConsumer(restarted.em.fork(), client, queues.deadLetters).consumeOnce()).toBe(true); }
  finally { await restarted.close(); }
  expect(await orm.em.fork().count(DeadLetterSchema, { messageId: message.MessageId! })).toBe(1);
  await assertConsistent(input.walletId, "100.00");
});

test("DLQ invalida e conflito sao arquivados sem inventar ou alterar transacoes", async () => {
  const invalid = await auditor().archive({ MessageId: crypto.randomUUID(), Body: "not-json" });
  expect(invalid).toMatchObject({ outcome: "INVALID_ENVELOPE", transactionId: null });
  const { input, key, envelope } = await fixture();
  await new ProcessTransaction(orm.em.fork()).execute(input, key);
  const changed = { ...envelope, data: { ...envelope.data, money: { amount: "1.00", currency: "BRL" } } };
  const conflict = await auditor().archive({ MessageId: crypto.randomUUID(), Body: JSON.stringify(changed) });
  expect(conflict).toMatchObject({ outcome: "IDEMPOTENCY_CONFLICT", transactionId: null });
  expect(await orm.em.fork().count(InboxSchema, { messageId: envelope.messageId })).toBe(0);
  await assertConsistent(input.walletId, "20.00");
});

test("falha de publicacao agenda backoff sem perder o evento", async () => {
  // A outbox e compartilhada: publique eventos anteriores antes desta fixture.
  const drain = new OutboxPublisher(orm.em.fork(), client, queues.events);
  while (await drain.publishOnce()) {}
  const { input } = await fixture();
  const publisher = new OutboxPublisher(orm.em.fork(), client, `${queues.events}-missing`);
  const now = new Date();
  expect(await publisher.publishOnce(now)).toBe(true);
  const failed = await orm.em.fork().findOneOrFail(OutboxSchema, { aggregateId: input.walletId, attempts: 1 });
  expect(failed.publishedAt).toBeNull();
  expect(failed.nextAttemptAt.getTime()).toBe(now.getTime() + 2000);
  const recovery = new OutboxPublisher(orm.em.fork(), client, queues.events);
  while (await recovery.publishOnce(new Date(now.getTime() + 3000))) {}
  expect(await orm.em.fork().count(OutboxSchema, { aggregateId: input.walletId, publishedAt: null })).toBe(0);
  await assertConsistent(input.walletId, "100.00");
});

test("worker morto depois do commit e antes do ack: reinicio nao debita novamente", async () => {
  const { input, envelope } = await fixture();
  await sendJson(client, queues.transactions, envelope, input.walletId, crypto.randomUUID());
  const child = Bun.spawn([process.execPath, "run", "src/messaging/tests/consumer-process.fixture.ts", dbName, JSON.stringify(queues)], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  let receipt: string | undefined;
  try {
    const reader = child.stdout.getReader();
    let output = "";
    while (!receipt) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error(`Worker ended: ${output}`);
      output += new TextDecoder().decode(chunk.value);
      for (const line of output.split("\n")) {
        try { const data = JSON.parse(line); if (data.committed) receipt = data.receipt; } catch {}
      }
    }
    child.kill(9);
    await child.exited;
    await assertConsistent(input.walletId, "20.00");
    // Simula expiracao da visibilidade sem aguardar 30s; a mensagem nunca recebeu ack.
    await client.send(new ChangeMessageVisibilityCommand({ QueueUrl: queues.transactions, ReceiptHandle: receipt, VisibilityTimeout: 0 }));
    await consumer().consumeOnce();
    expect(await orm.em.fork().count(InboxSchema, { messageId: envelope.messageId })).toBe(1);
    expect(await orm.em.fork().count(OutboxSchema, { aggregateId: input.walletId })).toBe(4);
    await assertConsistent(input.walletId, "20.00");
  } finally { child.kill(); await child.exited; }
}, 30000);

test("erro transitorio tem backoff e vai para DLQ na quinta tentativa", async () => {
  const beforeDlq = operationalMetrics.dlq;
  const retryCount = () => Number(operationalMetrics.render().match(/worker_retries_total\{component="sqs"\} (\d+)/)?.[1]);
  const beforeRetries = retryCount();
  const { input, envelope } = await fixture();
  await sendJson(client, queues.transactions, envelope, input.walletId, crypto.randomUUID());
  // Constraint temporaria injeta falha real de persistencia, sem mockar banco ou broker.
  await orm.em.fork().execute(`ALTER TABLE outbox_messages ADD CONSTRAINT injected_retry CHECK (aggregate_id <> '${input.walletId}') NOT VALID`);
  try {
    for (let attempt = 1; attempt <= 5; attempt++) {
      await consumer().consumeOnce();
      if (attempt === 1) expect(await consumer().receive()).toBeUndefined();
      if (attempt < 5) await Bun.sleep(2 ** attempt * 1000 + 100);
    }
    const result = await client.send(new ReceiveMessageCommand({ QueueUrl: queues.deadLetters, WaitTimeSeconds: 1 }));
    expect(JSON.parse(result.Messages![0]!.Body!).messageId).toBe(envelope.messageId);
    await client.send(new DeleteMessageCommand({ QueueUrl: queues.deadLetters, ReceiptHandle: result.Messages![0]!.ReceiptHandle }));
    expect(await orm.em.fork().count(InboxSchema, { messageId: envelope.messageId })).toBe(0);
    expect(operationalMetrics.dlq).toBe(beforeDlq + 1);
    expect(retryCount()).toBe(beforeRetries + 4);
    await assertConsistent(input.walletId, "100.00");
  } finally { await orm.em.fork().execute("ALTER TABLE outbox_messages DROP CONSTRAINT injected_retry"); }
}, 45000);

test("dez entregas concorrentes da mesma inbox produzem somente um efeito", async () => {
  const { input, key, envelope } = await fixture();
  const results = await Promise.all(Array.from({ length: 10 }, () => new ProcessTransaction(orm.em.fork())
    .execute(input, key, { consumerName: "wager-transactions", messageId: envelope.messageId })));
  expect(results.filter(r => !r.idempotentReplay)).toHaveLength(1);
  expect(await orm.em.fork().count(InboxSchema, { messageId: envelope.messageId })).toBe(1);
  expect(await orm.em.fork().count(OutboxSchema, { aggregateId: input.walletId })).toBe(4);
  await assertConsistent(input.walletId, "20.00");
});

test("LOSS emite somente processamento; referencia pendente emite pendencia e depois rejeicao", async () => {
  const { input } = await fixture();
  const loss = { ...input, kind: "LOSS", money: { amount: "0.00", currency: "BRL" } };
  await new ProcessTransaction(orm.em.fork()).execute(loss, input.externalTransactionId);
  const pending = { ...input, externalTransactionId: crypto.randomUUID(), kind: "REFUND", referenceExternalTransactionId: crypto.randomUUID() };
  const result = await new ProcessTransaction(orm.em.fork()).execute(pending, pending.externalTransactionId);
  for (let i = 1; i <= 9; i++) await new ProcessTransaction(orm.em.fork()).retryPending(result.transactionId, new Date(Date.now() + i * 120000));
  const events = await orm.em.fork().find(OutboxSchema, { aggregateId: input.walletId });
  expect(events.filter(e => e.eventType === "WalletBalanceChanged")).toHaveLength(1); // apenas abertura
  expect(events.filter(e => e.eventType === "WagerTransactionProcessed")).toHaveLength(2);
  expect(events.filter(e => e.eventType === "WagerTransactionPendingReference")).toHaveLength(1);
  expect(events.filter(e => e.eventType === "WagerTransactionRejected")).toHaveLength(1);
  await assertConsistent(input.walletId, "100.00");
});

test("envio confirmado com rollback da marcacao pode republicar; consumidor deduplica por eventId", async () => {
  // Isola a fila de saida para nao depender dos eventos de outros testes.
  const isolated = await setupQueues(client, `${dbName}-r`);
  try {
    await fixture();
    const em = orm.em.fork();
    await em.begin();
    try {
      await new OutboxPublisher(em, client, isolated.events).publishOnce();
    } finally { await em.rollback(); }
    // O broker recebeu, mas publishedAt nao foi confirmado: mesma janela de falha de uma queda.
    const received = await client.send(new ReceiveMessageCommand({ QueueUrl: isolated.events, WaitTimeSeconds: 1 }));
    const event = JSON.parse(received.Messages![0]!.Body!);
    const pending = await orm.em.fork().findOneOrFail(OutboxSchema, { id: event.eventId });
    expect(pending.publishedAt).toBeNull();
    await new OutboxPublisher(orm.em.fork(), client, isolated.events).publishOnce();
    expect((await orm.em.fork().findOneOrFail(OutboxSchema, { id: event.eventId })).publishedAt).not.toBeNull();
    await client.send(new DeleteMessageCommand({ QueueUrl: isolated.events, ReceiptHandle: received.Messages![0]!.ReceiptHandle }));

    // Contrato de consumidor downstream de exemplo: unicidade persistente do eventId.
    // IDs de transporte distintos forcam duas publicacoes, sem esperar a janela FIFO de 5min.
    await orm.em.fork().execute("CREATE TABLE example_event_receipts (event_id uuid PRIMARY KEY, payload jsonb NOT NULL)");
    for (let i = 0; i < 2; i++) {
      await sendJson(client, isolated.events, event, event.aggregateId, crypto.randomUUID());
      const result = await client.send(new ReceiveMessageCommand({ QueueUrl: isolated.events, WaitTimeSeconds: 1 }));
      const body = JSON.parse(result.Messages![0]!.Body!);
      await orm.em.fork().transactional(async tx => {
        await tx.execute("INSERT INTO example_event_receipts VALUES (?, ?::jsonb) ON CONFLICT DO NOTHING", [body.eventId, JSON.stringify(body)]);
        // Efeitos de negocio de um consumidor devem ocorrer aqui, apenas se o INSERT inserir.
      });
      await client.send(new DeleteMessageCommand({ QueueUrl: isolated.events, ReceiptHandle: result.Messages![0]!.ReceiptHandle }));
    }
    expect(await orm.em.fork().execute("SELECT count(*)::text AS count FROM example_event_receipts WHERE event_id = ?", [event.eventId])).toEqual([{ count: "1" }]);
  } finally {
    for (const QueueUrl of Object.values(isolated)) await client.send(new DeleteQueueCommand({ QueueUrl }));
  }
}, 30000);
