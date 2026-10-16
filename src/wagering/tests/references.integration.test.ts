import "reflect-metadata";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { Client } from "pg";
import { fileURLToPath } from "node:url";
import { MikroORM } from "@mikro-orm/postgresql";
import { Module, type INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import config from "../../database/orm.config";
import { DatabaseService } from "../../database/database.service";
import { OpenWallet } from "../../wallets/open-wallet";
import { ProcessTransaction } from "../process-transaction";
import { WagerTransactionSchema } from "../wager-transaction.schema";
import { WageringController } from "../wagering.controller";
import { ReferenceRetryWorker } from "../reference-retry.worker";
import { REFERENCE_MAX_ATTEMPTS } from "../reference-retry-policy";
import type { TransactionInput } from "../transaction-input";

const dbName = `wager_test_${crypto.randomUUID().replaceAll("-", "")}`;
const admin = new Client({ host: config.host, port: config.port, user: config.user,
  password: config.password, database: "postgres", connectionTimeoutMillis: 5000 });
let orm: MikroORM;
let app: INestApplication;
let created = false;

beforeAll(async () => {
  await admin.connect();
  await admin.query(`CREATE DATABASE "${dbName}"`);
  created = true;
  orm = await MikroORM.init({ ...config, dbName, migrations: { ...config.migrations, snapshot: false } });
  await orm.migrator.up();
  @Module({
    controllers: [WageringController],
    providers: [{ provide: DatabaseService, useValue: { createEntityManager: () => orm.em.fork() } }],
  })
  class TestModule {}
  app = await NestFactory.create(TestModule, { logger: false, abortOnError: false });
  await app.listen(0, "127.0.0.1");
}, 30000);

afterAll(async () => {
  try { await app?.close(); await orm?.close(); }
  finally {
    try {
      if (created && /^wager_test_[a-f0-9]{32}$/.test(dbName)) {
        await admin.query(`DROP DATABASE "${dbName}" WITH (FORCE)`);
      }
    } finally { await admin.end(); }
  }
}, 30000);

async function fixture(): Promise<TransactionInput> {
  const wallet = await new OpenWallet(orm.em.fork()).execute({
    playerId: crypto.randomUUID(), initialBalance: { amount: "100.00", currency: "BRL" },
  });
  return {
    providerId: "provider-a", externalTransactionId: crypto.randomUUID(), playerId: wallet.playerId,
    walletId: wallet.id, roundId: "round-1", gameId: "game-1", kind: "BET",
    money: { amount: "80.00", currency: "BRL" },
  };
}
function reversal(reference: TransactionInput, kind: "REFUND" | "ROLLBACK" = "REFUND"): TransactionInput {
  return { ...reference, externalTransactionId: crypto.randomUUID(), kind,
    referenceExternalTransactionId: reference.externalTransactionId };
}
function execute(input: TransactionInput) {
  return new ProcessTransaction(orm.em.fork()).execute(input, `${input.providerId}:${input.externalTransactionId}`);
}
function stored(id: string) {
  return orm.em.fork().findOneOrFail(WagerTransactionSchema, { id });
}
function retry(id: string, now: Date) {
  return new ProcessTransaction(orm.em.fork()).retryPending(id, now);
}
async function assertWallet(walletId: string, balance: string, version: number, entries: string) {
  const rows = await orm.em.fork().execute(`
    SELECT w.balance::text, w.version, count(l.id)::text AS entries,
      w.balance = coalesce(sum(CASE WHEN l.direction = 'CREDIT' THEN l.amount ELSE -l.amount END), 0) AS consistent
    FROM wallets w LEFT JOIN wallet_ledger_entries l ON l.wallet_id = w.id
    WHERE w.id = ? GROUP BY w.id
  `, [walletId]);
  expect(rows).toEqual([{ balance, version, entries, consistent: true }]);
}

test("REFUND concorrente de mesma BET: uma reversao e rejeicao auditavel da outra", async () => {
  const bet = await fixture();
  await execute(bet);
  const refunds = [reversal(bet), reversal(bet)];
  const results = await Promise.all(refunds.map(execute));
  expect(results.map((r) => r.status).sort()).toEqual(["PROCESSED", "REJECTED"]);
  expect(results.find((r) => r.status === "REJECTED")?.failureCode).toBe("REFERENCE_ALREADY_REVERSED");
  const index = results.findIndex((r) => r.status === "PROCESSED");
  expect(await execute(refunds[index])).toEqual({ ...results[index], idempotentReplay: true });
  await assertWallet(bet.walletId, "100.00", 3, "3");
});

test("REFUND e ROLLBACK possuem unicidade separada conforme README", async () => {
  const bet = await fixture();
  await execute(bet);
  expect((await execute(reversal(bet))).status).toBe("PROCESSED");
  expect((await execute(reversal(bet, "ROLLBACK"))).status).toBe("PROCESSED");
  await assertWallet(bet.walletId, "180.00", 4, "4");
});

test("ROLLBACK de WIN e REFUND debita; original permanece imutavel", async () => {
  const bet = await fixture();
  await execute(bet);
  const refund = reversal(bet);
  await execute(refund);
  expect((await execute(reversal(refund, "ROLLBACK"))).status).toBe("PROCESSED");
  const win: TransactionInput = { ...bet, externalTransactionId: crypto.randomUUID(), kind: "WIN" };
  const original = await execute(win);
  expect((await execute(reversal(win, "ROLLBACK"))).status).toBe("PROCESSED");
  expect((await stored(original.transactionId)).status).toBe("PROCESSED");
  await assertWallet(bet.walletId, "20.00", 6, "6");
});

test("ROLLBACK de credito gasto e rejeitado com codigo proprio e sem ledger", async () => {
  const bet = await fixture();
  const win: TransactionInput = { ...bet, kind: "WIN", money: { amount: "150.00", currency: "BRL" } };
  await execute(win);
  await execute({ ...bet, externalTransactionId: crypto.randomUUID(), money: { amount: "200.00", currency: "BRL" } });
  const rollback = reversal(win, "ROLLBACK");
  const result = await execute(rollback);
  expect(result).toMatchObject({ status: "REJECTED", failureCode: "REVERSAL_INSUFFICIENT_FUNDS" });
  expect(await execute(rollback)).toEqual({ ...result, idempotentReplay: true });
  await assertWallet(bet.walletId, "50.00", 3, "3");
});

test.each(["REFUND", "ROLLBACK"] as const)("%s chega antes da BET e outro processo retoma do banco", async (kind) => {
  const bet = await fixture();
  const request = reversal(bet, kind);
  const pending = await execute(request);
  expect(pending.status).toBe("PENDING_REFERENCE");
  expect(await execute(request)).toEqual({ ...pending, idempotentReplay: true });
  const row = await stored(pending.transactionId);
  expect(row.referenceAttempts).toBe(1);
  expect(await retry(row.id, new Date(row.nextReferenceAttemptAt!.getTime() - 1))).toBeNull();
  await assertWallet(bet.walletId, "100.00", 1, "1");
  await execute(bet);

  const child = Bun.spawn([process.execPath, "run",
    fileURLToPath(new URL("./reference-retry-process.fixture.ts", import.meta.url)),
    dbName, row.id, row.nextReferenceAttemptAt!.toISOString()], { stdout: "pipe", stderr: "pipe" });
  try {
    const output = await new Response(child.stdout).text();
    const errors = await new Response(child.stderr).text();
    expect(await child.exited, errors).toBe(0);
    expect(JSON.parse(output.trim().split("\n").at(-1)!)).toMatchObject({ transactionId: row.id, status: "PROCESSED" });
  } finally { child.kill(); }
  expect(await execute(request)).toMatchObject({ status: "PROCESSED", idempotentReplay: true });
  await assertWallet(bet.walletId, "100.00", 3, "3");
}, 15000);

test("dois workers reprocessam a mesma pendencia sem duplicar credito", async () => {
  const bet = await fixture();
  const pending = await execute(reversal(bet));
  const row = await stored(pending.transactionId);
  await execute(bet);
  const database = { createEntityManager: () => orm.em.fork() };
  await Promise.all([
    new ReferenceRetryWorker(database).runOnce(row.nextReferenceAttemptAt!),
    new ReferenceRetryWorker(database).runOnce(row.nextReferenceAttemptAt!),
  ]);
  expect((await stored(row.id)).status).toBe("PROCESSED");
  await assertWallet(bet.walletId, "100.00", 3, "3");
});

test("worker agendado processa pendencia sem novo pedido HTTP", async () => {
  const bet = await fixture();
  const pending = await execute(reversal(bet));
  await execute(bet);
  const worker = new ReferenceRetryWorker({ createEntityManager: () => orm.em.fork() });
  worker.onApplicationBootstrap();
  try {
    const deadline = Date.now() + 6000;
    while ((await stored(pending.transactionId)).status === "PENDING_REFERENCE" && Date.now() < deadline) {
      await Bun.sleep(100);
    }
    expect((await stored(pending.transactionId)).status).toBe("PROCESSED");
    await assertWallet(bet.walletId, "100.00", 3, "3");
  } finally { await worker.beforeApplicationShutdown(); }
}, 10000);

test("referencia inexistente esgota tentativas, preserva saldo e replay terminal", async () => {
  const bet = await fixture();
  const request = reversal(bet);
  const pending = await execute(request);
  let row = await stored(pending.transactionId);
  for (let attempt = 1; attempt < REFERENCE_MAX_ATTEMPTS; attempt++) {
    const scheduled = row.nextReferenceAttemptAt!;
    await retry(row.id, scheduled);
    row = await stored(row.id);
    if (row.status === "PENDING_REFERENCE") expect(row.nextReferenceAttemptAt!.getTime()).toBeGreaterThan(scheduled.getTime());
  }
  expect(row.status).toBe("REJECTED");
  expect(row.failureCode).toBe("REFERENCE_NOT_FOUND");
  expect(row.referenceAttempts).toBe(REFERENCE_MAX_ATTEMPTS);
  expect(row.nextReferenceAttemptAt).toBeNull();
  expect(await execute(request)).toMatchObject({ status: "REJECTED", idempotentReplay: true });
  await execute(bet);
  expect(await retry(row.id, new Date(Date.now() + 1_000_000))).toBeNull();
  await assertWallet(bet.walletId, "20.00", 2, "2");
});

test("WIN com referencia aguarda BET e permite premio de outro valor", async () => {
  const bet = await fixture();
  const win: TransactionInput = { ...reversal(bet), kind: "WIN", money: { amount: "150.00", currency: "BRL" } };
  const pending = await execute(win);
  await execute(bet);
  const row = await stored(pending.transactionId);
  expect((await retry(row.id, row.nextReferenceAttemptAt!))?.status).toBe("PROCESSED");
  await assertWallet(bet.walletId, "170.00", 3, "3");
});

test("referencia de outro provedor nao e confundida pelo mesmo id externo", async () => {
  const bet = await fixture();
  await execute(bet);
  const request = { ...reversal(bet), providerId: "provider-b" };
  expect((await execute(request)).status).toBe("PENDING_REFERENCE");
  await assertWallet(bet.walletId, "20.00", 2, "2");
});

test("rodada divergente, valor parcial e referencia rejeitada nao movimentam saldo", async () => {
  const bet = await fixture();
  await execute(bet);
  expect((await execute({ ...reversal(bet), roundId: "other-round" })).failureCode).toBe("REFERENCE_MISMATCH");
  expect((await execute({ ...reversal(bet), money: { amount: "40.00", currency: "BRL" } })).failureCode).toBe("REFERENCE_AMOUNT_MISMATCH");
  const rejectedBet = { ...bet, externalTransactionId: crypto.randomUUID() };
  await execute(rejectedBet);
  expect((await execute(reversal(rejectedBet))).failureCode).toBe("REFERENCE_NOT_PROCESSED");
  await assertWallet(bet.walletId, "20.00", 2, "2");
});

test("banco impede segunda reversao processada e referencia com valor errado", async () => {
  const bet = await fixture();
  await execute(bet);
  const result = await execute(reversal(bet));
  const original = await stored(result.transactionId);
  const copy = { ...original, id: crypto.randomUUID(), externalTransactionId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID() };
  await expect(orm.em.fork().createQueryBuilder(WagerTransactionSchema).insert(copy).execute())
    .rejects.toThrow("transactions_one_reversal_per_kind");
  await expect(orm.em.fork().createQueryBuilder(WagerTransactionSchema).insert({ ...copy, amount: "40.00" }).execute())
    .rejects.toThrow("Reversal amount must match reference");
  await assertWallet(bet.walletId, "100.00", 3, "3");
});

test("HTTP distingue referencia obrigatoria, pendencia e conflito no campo referenciado", async () => {
  const bet = await fixture();
  const request = reversal(bet);
  const url = `${await app.getUrl()}/wagering/transactions`;
  const send = (body: unknown) => fetch(url, {
    method: "POST", headers: { "content-type": "application/json", "idempotency-key": request.externalTransactionId },
    body: JSON.stringify(body),
  });
  expect((await send({ ...request, referenceExternalTransactionId: undefined })).status).toBe(400);
  const pending = await send(request);
  expect(pending.status).toBe(202);
  expect(await pending.json()).toMatchObject({ status: "PENDING_REFERENCE" });
  expect((await send({ ...request, referenceExternalTransactionId: "other" })).status).toBe(409);
  await assertWallet(bet.walletId, "100.00", 1, "1");
});
