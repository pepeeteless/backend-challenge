import "reflect-metadata";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { Client } from "pg";
import { MikroORM } from "@mikro-orm/postgresql";
import { Module, type INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import config from "../database/orm.config";
import { DatabaseService } from "../database/database.service";
import { OpenWallet } from "../wallets/open-wallet";
import { WalletsController } from "../wallets/wallets.controller";
import { WageringController } from "./wagering.controller";
import { ProcessBet, type BetResult } from "./process-bet";
import type { BetInput } from "./bet-input";

const dbName = `wager_test_${crypto.randomUUID().replaceAll("-", "")}`;
const admin = new Client({ host: config.host, port: config.port, user: config.user,
  password: config.password, database: "postgres", connectionTimeoutMillis: 5000 });
let orm: MikroORM;
let app: INestApplication | undefined;
let created = false;

beforeAll(async () => {
  await admin.connect();
  await admin.query(`CREATE DATABASE "${dbName}"`);
  created = true;
  orm = await MikroORM.init({
    ...config, dbName,
    migrations: { ...config.migrations, snapshot: false },
  });
  await orm.migrator.up();
}, 30000);

afterAll(async () => {
  try {
    await app?.close();
    await orm?.close();
  } finally {
    try {
      // Nunca remove o banco pepe: nome aleatorio gerado e validado neste teste.
      if (created && /^wager_test_[a-f0-9]{32}$/.test(dbName)) {
        await admin.query(`DROP DATABASE "${dbName}" WITH (FORCE)`);
      }
    } finally { await admin.end(); }
  }
}, 30000);

async function fixture(): Promise<BetInput> {
  const wallet = await new OpenWallet(orm.em.fork()).execute({
    playerId: crypto.randomUUID(), initialBalance: { amount: "100.00", currency: "BRL" },
  });
  return {
    providerId: "provider-a", externalTransactionId: crypto.randomUUID(),
    playerId: wallet.playerId, walletId: wallet.id, roundId: "round-1", gameId: "game-1",
    kind: "BET", money: { amount: "80.00", currency: "BRL" },
  };
}

function execute(input: BetInput, key = input.externalTransactionId) {
  return new ProcessBet(orm.em.fork()).execute(input, key);
}

async function assertWallet(walletId: string, balance: string, version: number, debits: string) {
  const rows = await orm.em.fork().execute(`
    SELECT w.balance::text, w.version,
      count(l.id) FILTER (WHERE l.direction = 'DEBIT')::text AS debits,
      w.balance = coalesce(sum(CASE WHEN l.direction = 'CREDIT' THEN l.amount ELSE -l.amount END), 0)
        AS consistent
    FROM wallets w LEFT JOIN wallet_ledger_entries l ON l.wallet_id = w.id
    WHERE w.id = ? GROUP BY w.id
  `, [walletId]);
  expect(rows).toEqual([{ balance, version, debits, consistent: true }]);
}

test("nova migracao pode ser revertida e reaplicada em banco compativel", async () => {
  await orm.migrator.down();
  const rows = await orm.em.fork().execute(`SELECT column_name FROM information_schema.columns
    WHERE table_name = 'wager_transactions' AND column_name = 'payload_hash'`);
  expect(rows).toHaveLength(0);
  await orm.migrator.up();
});

test("duas BET de 80 disputam 100: apenas uma debita", async () => {
  const input = await fixture();
  const other = { ...input, externalTransactionId: crypto.randomUUID() };
  const results = await Promise.all([execute(input), execute(other)]);
  expect(results.map((r) => r.status).sort()).toEqual(["PROCESSED", "REJECTED"]);
  expect(results.find((r) => r.status === "REJECTED")?.failureCode).toBe("INSUFFICIENT_FUNDS");
  const rejectedInput = results[0].status === "REJECTED" ? input : other;
  expect(await execute(rejectedInput)).toMatchObject({ status: "REJECTED", idempotentReplay: true });
  await assertWallet(input.walletId, "20.00", 2, "1");
});

test("50 reenvios simultaneos geram um debito e a mesma resposta", async () => {
  const input = await fixture();
  const results = await Promise.all(Array.from({ length: 50 }, () => execute(input)));
  expect(results.filter((r) => !r.idempotentReplay)).toHaveLength(1);
  expect(new Set(results.map((r) => r.transactionId)).size).toBe(1);
  expect(results.every((r) => r.status === "PROCESSED" && r.balance.amount === "20.00")).toBe(true);
  await assertWallet(input.walletId, "20.00", 2, "1");
}, 15000);

test("replay preserva saldo original mesmo depois de outra aposta", async () => {
  const input = await fixture();
  const first = await execute(input);
  await execute({ ...input, externalTransactionId: crypto.randomUUID(), money: { amount: "10.00", currency: "BRL" } });
  expect(await execute(input)).toEqual({ ...first, idempotentReplay: true });
  await assertWallet(input.walletId, "10.00", 3, "2");
});

test("payload divergente e troca de chave para a mesma identidade externa sao conflitos", async () => {
  const input = await fixture();
  await execute(input);
  await expect(execute({ ...input, money: { amount: "10.00", currency: "BRL" } }))
    .rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  await expect(execute(input, "different-key")).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  await assertWallet(input.walletId, "20.00", 2, "1");
});

test("mesma chave concorrente em carteiras diferentes nao causa dois debitos", async () => {
  const a = await fixture();
  const b = await fixture();
  const key = crypto.randomUUID();
  const results = await Promise.allSettled([execute(a, key), execute(b, key)]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  for (const [i, input] of [a, b].entries()) {
    if (results[i].status === "fulfilled") await assertWallet(input.walletId, "20.00", 2, "1");
    else {
      expect((results[i] as PromiseRejectedResult).reason).toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
      await assertWallet(input.walletId, "100.00", 1, "0");
    }
  }
});

test("rejeicao por moeda divergente e persistida sem lancamento", async () => {
  const input = await fixture();
  const wrongCurrency = { ...input, money: { amount: "80.00", currency: "USD" } };
  const result = await execute(wrongCurrency);
  expect(result).toMatchObject({ status: "REJECTED", failureCode: "CURRENCY_MISMATCH" });
  expect(await execute(wrongCurrency)).toEqual({ ...result, idempotentReplay: true });
  await assertWallet(input.walletId, "100.00", 1, "0");
});

test("falha ao inserir ledger desfaz saldo e BET; reenvio depois pode concluir", async () => {
  const input = await fixture();
  const em = orm.em.fork();
  // Constraint exclusiva do banco descartavel: falha depois de UPDATE wallets.
  await em.execute(`ALTER TABLE wallet_ledger_entries ADD CONSTRAINT test_failure
    CHECK (wallet_id <> '${input.walletId}'::uuid OR direction <> 'DEBIT') NOT VALID`);
  try {
    await expect(execute(input)).rejects.toThrow();
    await assertWallet(input.walletId, "100.00", 1, "0");
    expect(await em.execute("SELECT id FROM wager_transactions WHERE idempotency_key = ?", [input.externalTransactionId]))
      .toHaveLength(0);
  } finally {
    await em.execute("ALTER TABLE wallet_ledger_entries DROP CONSTRAINT test_failure");
  }
  expect((await execute(input)).status).toBe("PROCESSED");
  await assertWallet(input.walletId, "20.00", 2, "1");
});

test("banco impede modificar e excluir transacao terminal", async () => {
  const input = await fixture();
  const result = await execute(input);
  await expect(orm.em.fork().execute("UPDATE wager_transactions SET status = 'PENDING' WHERE id = ?", [result.transactionId]))
    .rejects.toThrow("immutable");
  await expect(orm.em.fork().execute("DELETE FROM wager_transactions WHERE id = ?", [result.transactionId]))
    .rejects.toThrow("immutable");
  await assertWallet(input.walletId, "20.00", 2, "1");
});

test("carteira bloqueada nao impede processar outra carteira", async () => {
  const a = await fixture();
  const b = await fixture();
  const lockingEm = orm.em.fork();
  await lockingEm.begin();
  try {
    await lockingEm.execute("SELECT id FROM wallets WHERE id = ? FOR UPDATE", [a.walletId]);
    expect((await execute(b)).status).toBe("PROCESSED");
  } finally { await lockingEm.rollback(); }
  await assertWallet(a.walletId, "100.00", 1, "0");
  await assertWallet(b.walletId, "20.00", 2, "1");
});

test("tres processos independentes reenviam a mesma BET sem duplicar", async () => {
  const input = await fixture();
  // fileURLToPath tambem trata letras de unidade e espacos no Windows.
  const { fileURLToPath } = await import("node:url");
  const fixturePath = fileURLToPath(new URL("./bet-process.fixture.ts", import.meta.url));
  const children = Array.from({ length: 3 }, () => Bun.spawn([
    process.execPath, "run", fixturePath, dbName, JSON.stringify(input), input.externalTransactionId,
  ], { stdin: "pipe", stdout: "pipe", stderr: "pipe" }));
  try {
    const readers = children.map((child) => child.stdout.getReader());
    const initial = await Promise.all(readers.map(async (reader) => {
      let text = "";
      while (!text.includes("READY\n")) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error("Child exited before READY");
        text += new TextDecoder().decode(chunk.value);
      }
      return text;
    }));
    children.forEach((child) => child.stdin.end());
    const outputs = await Promise.all(readers.map(async (reader, i) => {
      let output = initial[i];
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        output += new TextDecoder().decode(chunk.value);
      }
      return JSON.parse(output.trim().split("\n").at(-1)!) as BetResult;
    }));
    expect(await Promise.all(children.map((child) => child.exited))).toEqual([0, 0, 0]);
    expect(outputs.filter((result) => !result.idempotentReplay)).toHaveLength(1);
    expect(new Set(outputs.map((result) => result.transactionId)).size).toBe(1);
    await assertWallet(input.walletId, "20.00", 2, "1");
  } finally { children.forEach((child) => child.kill()); }
}, 20000);

test("HTTP processa BET, replay, conflito, rejeicao e payload invalido", async () => {
  @Module({
    controllers: [WageringController, WalletsController],
    providers: [{ provide: DatabaseService, useValue: { createEntityManager: () => orm.em.fork() } }],
  })
  class TestModule {}
  app = await NestFactory.create(TestModule, { logger: false, abortOnError: false });
  await app.listen(0, "127.0.0.1");
  const url = `${await app.getUrl()}/wagering/transactions`;
  const input = await fixture();
  const send = (body: unknown, key?: string) => fetch(url, {
    method: "POST", headers: { "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) },
    body: JSON.stringify(body),
  });
  const first = await send(input, input.externalTransactionId);
  expect(first.status).toBe(200);
  const body = await first.json() as BetResult;
  expect(body).toMatchObject({ status: "PROCESSED", balance: { amount: "20.00" }, idempotentReplay: false });
  const replay = await send(input, input.externalTransactionId);
  expect(replay.status).toBe(200);
  expect(await replay.json()).toEqual({ ...body, idempotentReplay: true });
  expect((await send({ ...input, roundId: "different" }, input.externalTransactionId)).status).toBe(409);
  expect((await send(input)).status).toBe(400);
  expect((await send({ ...input, kind: "OPENING" }, "opening-attempt")).status).toBe(400);
  const rejectedInput = { ...input, externalTransactionId: crypto.randomUUID() };
  const rejected = await send(rejectedInput, rejectedInput.externalTransactionId);
  expect(rejected.status).toBe(422);
  expect(await rejected.json()).toMatchObject({ status: "REJECTED", failureCode: "INSUFFICIENT_FUNDS" });
  await assertWallet(input.walletId, "20.00", 2, "1");
}, 10000);
