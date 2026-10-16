import { strict as assert } from "node:assert";

const urls = [3001, 3002, 3003].map(port => `http://127.0.0.1:${port}`);
async function request(base: string, path: string, body?: unknown, key?: string) {
  const response = await fetch(base + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json", ...(key ? { "Idempotency-Key": key } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const data = await response.json() as Record<string, any>;
  return { status: response.status, data };
}
for (const url of urls) assert.equal((await request(url, "/health/ready")).status, 200);
const playerId = crypto.randomUUID();
const created = await request(urls[0]!, "/wallets", {
  playerId, initialBalance: { amount: "100.00", currency: "BRL" },
});
assert.equal(created.status, 201);
const walletId = created.data.id as string;
const makeBet = () => ({ providerId: "cluster-demo", externalTransactionId: crypto.randomUUID(),
  playerId, walletId, roundId: "cluster-round", gameId: "demo", kind: "BET",
  money: { amount: "80.00", currency: "BRL" } });
const bets = [makeBet(), makeBet()];
const results = await Promise.all(bets.map((bet, i) =>
  request(urls[i]!, "/wagering/transactions", bet, `cluster:${bet.externalTransactionId}`)));
assert.deepEqual(results.map(r => r.data.status).sort(), ["PROCESSED", "REJECTED"]);
const winner = results.findIndex(r => r.data.status === "PROCESSED");
const bet = bets[winner]!;
const repeats = await Promise.all(Array.from({ length: 50 }, (_, i) =>
  request(urls[i % 3]!, "/wagering/transactions", bet, `cluster:${bet.externalTransactionId}`)));
for (const result of repeats) {
  assert.equal(result.status, 200);
  assert.equal(result.data.transactionId, results[winner]!.data.transactionId);
  assert.equal(result.data.idempotentReplay, true);
  assert.equal(result.data.balance.amount, "20.00");
}
// Reinicio real de uma API; PostgreSQL e filas continuam rodando.
const restart = Bun.spawn(["docker", "compose", "-f", "compose.yaml", "-f", "compose.app.yaml", "restart", "app1"],
  { stdout: "inherit", stderr: "inherit" });
assert.equal(await restart.exited, 0);
let ready = false;
for (let i = 0; i < 60; i++) {
  try { ready = (await request(urls[0]!, "/health/ready")).status === 200; } catch {}
  if (ready) break;
  await Bun.sleep(1000);
}
assert.equal(ready, true);
const replay = await request(urls[0]!, "/wagering/transactions", bet, `cluster:${bet.externalTransactionId}`);
assert.equal(replay.data.idempotentReplay, true);
assert.equal(replay.data.balance.amount, "20.00");
for (const url of urls) {
  const reconciliation = await request(url, `/wallets/${walletId}/reconciliation`, {});
  assert.equal(reconciliation.status, 200);
  assert.equal(reconciliation.data.consistent, true);
  assert.equal(reconciliation.data.storedBalance.amount, "20.00");
  assert.equal(reconciliation.data.checkedEntries, 2); // abertura + um debito
  const ledger = await request(url, `/wallets/${walletId}/ledger`);
  assert.equal(ledger.data.items.filter((entry: { direction: string }) => entry.direction === "DEBIT").length, 1);
}
console.log(JSON.stringify({ result: "ok", walletId, instances: 3, replays: 50, restart: true, balance: "20.00" }));
