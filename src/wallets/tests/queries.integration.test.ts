import "reflect-metadata";
import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { Client } from "pg";
import { MikroORM, type EntityManager } from "@mikro-orm/postgresql";
import { Module, type INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import config from "../../database/orm.config";
import { DatabaseService } from "../../database/database.service";
import { WalletsController } from "../wallets.controller";
import { TransactionQueriesController } from "../../wagering/transaction-queries.controller";
import { MetricsController } from "../../observability/metrics.controller";
import { OpenWallet } from "../open-wallet";
import { ProcessTransaction } from "../../wagering/process-transaction";
import { LedgerRepository, type ReconciliationResult } from "../ledger.repository";
import { WalletSchema } from "../wallet.schema";
import type { Wallet } from "../wallet";
import type { TransactionInput } from "../../wagering/transaction-input";
import { reconciliationMetrics } from "../../observability/metrics";

const dbName = `query_test_${crypto.randomUUID().replaceAll("-", "")}`;
const admin = new Client({ host: config.host, port: config.port, user: config.user, password: config.password, database: "postgres" });
let orm: MikroORM;
let app: INestApplication;
let url: string;
let created = false;
let requestManager: EntityManager | undefined;
beforeAll(async () => {
  await admin.connect();
  await admin.query(`CREATE DATABASE "${dbName}"`);
  created = true;
  orm = await MikroORM.init({ ...config, dbName, migrations: { ...config.migrations, snapshot: false } });
  await orm.migrator.up();
  @Module({ controllers: [WalletsController, TransactionQueriesController, MetricsController],
    providers: [{ provide: DatabaseService, useValue: { createEntityManager: () => requestManager ?? orm.em.fork() } }] })
  class TestModule {}
  app = await NestFactory.create(TestModule, { logger: false, abortOnError: false });
  await app.listen(0, "127.0.0.1");
  url = await app.getUrl();
}, 30000);
afterAll(async () => {
  try { await app?.close(); await orm?.close(); }
  finally {
    try { if (created && /^query_test_[a-f0-9]{32}$/.test(dbName)) await admin.query(`DROP DATABASE "${dbName}" WITH (FORCE)`); }
    finally { await admin.end(); }
  }
}, 30000);

const open = (amount = "100.00") => new OpenWallet(orm.em.fork()).execute({ playerId: crypto.randomUUID(), initialBalance: { amount, currency: "BRL" } });
function input(wallet: Wallet, kind: TransactionInput["kind"] = "BET", amount = "10.00"): TransactionInput {
  return { providerId: "provider-a", externalTransactionId: crypto.randomUUID(), walletId: wallet.id,
    playerId: wallet.playerId, roundId: "round", gameId: "game", kind, money: { amount, currency: "BRL" } };
}
const execute = (body: TransactionInput) => new ProcessTransaction(orm.em.fork()).execute(body, `${body.providerId}:${body.externalTransactionId}`);
async function get(path: string, method = "GET") {
  const response = await fetch(`${url}${path}`, { method });
  return { status: response.status, body: await response.json() };
}
type Page = Awaited<ReturnType<LedgerRepository["page"]>>;
async function page(walletId: string, query = ""): Promise<Page> {
  const response = await fetch(`${url}/wallets/${walletId}/ledger${query}`);
  expect(response.status).toBe(200);
  return await response.json() as Page;
}

test("consultas por UUID e provedor retornam a mesma transacao sem misturar namespaces", async () => {
  const wallet = await open();
  const body = input(wallet);
  const result = await execute(body);
  const other = await execute({ ...body, providerId: "provider-b" });
  const byId = await get(`/wagering/transactions/${result.transactionId}`);
  const byProvider = await get(`/providers/provider-a/wagering/transactions/${body.externalTransactionId}`);
  expect(byId).toEqual(byProvider);
  expect(byId.body).toMatchObject({ transactionId: result.transactionId, kind: "BET", status: "PROCESSED",
    money: { amount: "10.00", currency: "BRL" }, result: { balance: { amount: "90.00", currency: "BRL" } } });
  expect((await get(`/providers/provider-b/wagering/transactions/${body.externalTransactionId}`)).body).toMatchObject({ transactionId: other.transactionId });
  expect((await get(`/providers/provider-c/wagering/transactions/${body.externalTransactionId}`)).status).toBe(404);
  expect(byId.body).not.toHaveProperty("payloadHash");
  expect(byId.body).not.toHaveProperty("idempotencyKey");
  const opening = (await page(wallet.id)).items[0]!;
  expect((await get(`/wagering/transactions/${opening.transactionId}`)).body).toMatchObject({ kind: "OPENING", status: "PROCESSED", result: null });
});

test("consulta mostra rejeicao e transicao de referencia pendente para processada", async () => {
  const wallet = await open();
  const bet = input(wallet, "BET", "80.00");
  const refund = await execute({ ...input(wallet, "REFUND", "80.00"), referenceExternalTransactionId: bet.externalTransactionId });
  expect((await get(`/wagering/transactions/${refund.transactionId}`)).body).toMatchObject({ status: "PENDING_REFERENCE" });
  await execute(bet);
  const rejected = await execute(input(wallet, "BET", "80.00"));
  expect((await get(`/wagering/transactions/${rejected.transactionId}`)).body).toMatchObject({ status: "REJECTED", failureCode: "INSUFFICIENT_FUNDS" });
  await new ProcessTransaction(orm.em.fork()).retryPending(refund.transactionId, new Date(Date.now() + 2000));
  expect((await get(`/wagering/transactions/${refund.transactionId}`)).body).toMatchObject({ status: "PROCESSED", result: { balance: { amount: "100.00", currency: "BRL" } } });
});

test("cursor percorre abertura, debito e credito sem duplicar; novos lancamentos ficam para nova consulta", async () => {
  const wallet = await open();
  await execute(input(wallet));
  await execute(input(wallet, "WIN", "3.00"));
  await execute(input(wallet, "LOSS", "0.00"));
  const initial = await page(wallet.id);
  expect(initial.items).toHaveLength(3);
  const first = await page(wallet.id, "?limit=1");
  expect(first.nextCursor).toBeString();
  await execute(input(wallet, "WIN", "5.00"));
  const second = await page(wallet.id, `?limit=1&cursor=${first.nextCursor}`);
  expect(await page(wallet.id, `?limit=1&cursor=${first.nextCursor}`)).toEqual(second);
  const third = await page(wallet.id, `?limit=1&cursor=${second.nextCursor}`);
  expect([...first.items, ...second.items, ...third.items]).toEqual(initial.items);
  expect(third.nextCursor).toBeNull();
  expect((await page(wallet.id)).items).toHaveLength(4);
  const otherWallet = await open("0.00");
  expect((await get(`/wallets/${otherWallet.id}/ledger?cursor=${first.nextCursor}`)).status).toBe(400);
});

test("validacao de UUID, cursor, limite e carteiras vazias ou inexistentes", async () => {
  const wallet = await open("0.00");
  expect(await page(wallet.id)).toEqual({ items: [], nextCursor: null });
  for (const query of ["limit=0", "limit=101", "limit=-1", "limit=1.5", "limit=abc", "limit=1&limit=2", "cursor=bad", "cursor=", "unexpected=x"]) {
    expect((await get(`/wallets/${wallet.id}/ledger?${query}`)).status).toBe(400);
  }
  for (const path of ["/wallets/bad/ledger", "/wagering/transactions/bad"]) expect((await get(path)).status).toBe(400);
  expect((await get(`/wagering/transactions/${crypto.randomUUID()}`)).status).toBe(404);
  expect((await get(`/wallets/${crypto.randomUUID()}/ledger`)).status).toBe(404);
  expect((await get(`/wallets/${crypto.randomUUID()}/reconciliation`, "POST")).status).toBe(404);
});

test("reconciliacao inclui abertura e movimentos, preserva centavos e suporta carteira vazia", async () => {
  const empty = await open("0.00");
  expect((await get(`/wallets/${empty.id}/reconciliation`, "POST")).body).toMatchObject({ consistent: true, checkedEntries: 0, calculatedBalance: { amount: "0.00", currency: "BRL" } });
  const wallet = await open("9007199254740993.01");
  await execute(input(wallet, "BET", "0.02"));
  await execute(input(wallet, "WIN", "0.01"));
  const response = await get(`/wallets/${wallet.id}/reconciliation`, "POST");
  expect(response.status).toBe(200);
  expect(response.body).toEqual({ walletId: wallet.id, storedBalance: { amount: "9007199254740993.00", currency: "BRL" },
    calculatedBalance: { amount: "9007199254740993.00", currency: "BRL" }, difference: { amount: "0.00", currency: "BRL" }, consistent: true, checkedEntries: 3 });
});

test("soma historica maior que limite monetario nao perde precisao", async () => {
  const max = "999999999999999999.99";
  const wallet = await open(max);
  for (let i = 0; i < 2; i++) { await execute(input(wallet, "BET", max)); await execute(input(wallet, "WIN", max)); }
  expect((await get(`/wallets/${wallet.id}/reconciliation`, "POST")).body).toMatchObject({
    consistent: true, checkedEntries: 5, calculatedBalance: { amount: max, currency: "BRL" }, difference: { amount: "0.00", currency: "BRL" },
  });
});

test("divergencia e sinalizada, logada e contabilizada sem corrigir saldo", async () => {
  const wallet = await open();
  await execute(input(wallet, "BET", "80.00"));
  await orm.em.fork().nativeUpdate(WalletSchema, { id: wallet.id }, { balance: "19.99" });
  const before = reconciliationMetrics.divergences;
  const log = spyOn(console, "error").mockImplementation(() => {});
  try {
    const response = await get(`/wallets/${wallet.id}/reconciliation`, "POST");
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ consistent: false, storedBalance: { amount: "19.99" }, calculatedBalance: { amount: "20.00" }, difference: { amount: "-0.01" } });
    expect(reconciliationMetrics.divergences).toBe(before + 1);
    expect(log).toHaveBeenCalledTimes(1);
    const entry = JSON.parse(log.mock.calls[0]![0] as string);
    expect(entry).toMatchObject({ event: "reconciliation_divergence", walletId: wallet.id });
    expect(entry).not.toHaveProperty("storedBalance");
    expect(entry.correlationId).toBeString();
    expect((await get(`/wallets/${wallet.id}`)).body).toMatchObject({ balance: { amount: "19.99" }, version: 2 });
    const metrics = await fetch(`${url}/metrics`);
    expect(await metrics.text()).toContain(`reconciliation_divergences_total ${before + 1}`);
  } finally { log.mockRestore(); }
});

test("reconciliacao concorrente com apostas nunca compara estados de commits diferentes", async () => {
  const wallet = await open();
  const results = await Promise.all([
    ...Array.from({ length: 10 }, () => execute(input(wallet, "BET", "1.00"))),
    ...Array.from({ length: 20 }, async () => (await get(`/wallets/${wallet.id}/reconciliation`, "POST")).body as ReconciliationResult),
  ]);
  for (const result of results.slice(10) as ReconciliationResult[]) expect(result.consistent).toBe(true);
  expect((await get(`/wallets/${wallet.id}/reconciliation`, "POST")).body).toMatchObject({ consistent: true, storedBalance: { amount: "90.00" }, checkedEntries: 11 });
});

test("bloqueio temporario do PostgreSQL retorna 503 nas consultas", async () => {
  const wallet = await open();
  const blocker = orm.em.fork();
  const requester = orm.em.fork();
  await blocker.begin();
  await requester.begin();
  const log = spyOn(console, "error").mockImplementation(() => {});
  try {
    await blocker.execute("LOCK TABLE wallet_ledger_entries IN ACCESS EXCLUSIVE MODE");
    await requester.execute("SET LOCAL lock_timeout = '50ms'");
    requestManager = requester;
    const response = await get(`/wallets/${wallet.id}/ledger`);
    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ code: "TEMPORARY_UNAVAILABLE" });
  } finally {
    requestManager = undefined;
    await requester.rollback();
    await blocker.rollback();
    log.mockRestore();
  }
});
