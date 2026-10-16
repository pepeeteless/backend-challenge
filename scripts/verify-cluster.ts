import { strict as assert } from "node:assert";
import type { TransactionResult } from "../src/wagering/contracts/transaction-result";
import type { ReconciliationResult } from "../src/wallets/repositories/ledger.repository";

interface CreatedWallet {
  id: string;
}

interface LedgerPage {
  items: Array<{ direction: "DEBIT" | "CREDIT" }>;
}

const urls = [3001, 3002, 3003].map((port) => `http://127.0.0.1:${port}`);
async function request<T = unknown>(
  base: string,
  path: string,
  body?: unknown,
  key?: string,
) {
  const response = await fetch(base + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "Content-Type": "application/json",
      ...(key ? { "Idempotency-Key": key } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const data = (await response.json()) as T;
  return { status: response.status, data };
}
for (const url of urls)
  assert.equal((await request(url, "/health/ready")).status, 200);
const playerId = crypto.randomUUID();
const created = await request<CreatedWallet>(urls[0]!, "/wallets", {
  playerId,
  initialBalance: { amount: "100.00", currency: "BRL" },
});
assert.equal(created.status, 201);
const walletId = created.data.id;
const makeBet = () => ({
  providerId: "cluster-demo",
  externalTransactionId: crypto.randomUUID(),
  playerId,
  walletId,
  roundId: "cluster-round",
  gameId: "demo",
  kind: "BET",
  money: { amount: "80.00", currency: "BRL" },
});
const bets = [makeBet(), makeBet()];
const results = await Promise.all(
  bets.map((bet, i) =>
    request<TransactionResult>(
      urls[i]!,
      "/wagering/transactions",
      bet,
      `cluster:${bet.externalTransactionId}`,
    ),
  ),
);
assert.deepEqual(results.map((r) => r.data.status).sort(), [
  "PROCESSED",
  "REJECTED",
]);
const approvedIndex = results.findIndex((result) => result.data.status === "PROCESSED");
const approvedBet = bets[approvedIndex];
const approvedResult = results[approvedIndex];
assert.ok(approvedBet);
assert.ok(approvedResult);
const repeats = await Promise.all(
  Array.from({ length: 50 }, (_, i) =>
    request<TransactionResult>(
      urls[i % 3]!,
      "/wagering/transactions",
      approvedBet,
      `cluster:${approvedBet.externalTransactionId}`,
    ),
  ),
);
for (const result of repeats) {
  assert.equal(result.status, 200);
  assert.equal(result.data.transactionId, approvedResult.data.transactionId);
  assert.equal(result.data.idempotentReplay, true);
  assert.equal(result.data.balance.amount, "20.00");
}
const restart = Bun.spawn(
  [
    "docker",
    "compose",
    "-f",
    "compose.yaml",
    "-f",
    "compose.app.yaml",
    "restart",
    "app1",
  ],
  { stdout: "inherit", stderr: "inherit" },
);
assert.equal(await restart.exited, 0);
let ready = false;
for (let i = 0; i < 60; i++) {
  try {
    ready = (await request(urls[0]!, "/health/ready")).status === 200;
  } catch {}
  if (ready) break;
  await Bun.sleep(1000);
}
assert.equal(ready, true);
const replay = await request<TransactionResult>(
  urls[0]!,
  "/wagering/transactions",
  approvedBet,
  `cluster:${approvedBet.externalTransactionId}`,
);
assert.equal(replay.data.idempotentReplay, true);
assert.equal(replay.data.balance.amount, "20.00");
for (const url of urls) {
  const reconciliation = await request<ReconciliationResult>(
    url,
    `/wallets/${walletId}/reconciliation`,
    {},
  );
  assert.equal(reconciliation.status, 200);
  assert.equal(reconciliation.data.consistent, true);
  assert.equal(reconciliation.data.storedBalance.amount, "20.00");
  assert.equal(reconciliation.data.checkedEntries, 2);
  const ledger = await request<LedgerPage>(url, `/wallets/${walletId}/ledger`);
  assert.equal(
    ledger.data.items.filter(
      entry => entry.direction === "DEBIT",
    ).length,
    1,
  );
}
console.log(
  JSON.stringify({
    result: "ok",
    walletId,
    instances: 3,
    replays: 50,
    restart: true,
    balance: "20.00",
  }),
);
