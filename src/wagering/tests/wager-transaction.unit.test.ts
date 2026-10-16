import { expect, test } from "bun:test";
import { Money } from "../../wallets/money";
import { Wallet } from "../../wallets/wallet";
import {
  transactionInputSchema,
  hashTransactionPayload,
} from "../transaction-input";
import { isTerminalStatus, WagerTransaction } from "../wager-transaction";

function fixture(amount = "80.00", currency = "BRL") {
  const wallet = Wallet.open({
    id: crypto.randomUUID(),
    playerId: crypto.randomUUID(),
    initialBalance: Money.from({ amount: "100.00", currency: "BRL" }),
  });
  const identity = {
    id: crypto.randomUUID(),
    providerId: "provider-a",
    externalTransactionId: "bet-1",
    idempotencyKey: "provider-a:bet-1",
    payloadHash: "hash",
    walletId: wallet.id,
    playerId: wallet.playerId,
    roundId: "round-1",
    gameId: "game-1",
    kind: "BET" as const,
    money: Money.from({ amount, currency }),
  };
  return { wallet, identity, transaction: WagerTransaction.create(identity) };
}

test("FAILED e terminal, preserva carteira e nao permite voltar a aplicar", () => {
  const { wallet, transaction } = fixture();
  transaction.fail("INFRASTRUCTURE_RETRY_EXHAUSTED");
  expect(transaction.status).toBe("FAILED");
  expect(transaction.failureCode).toBe("INFRASTRUCTURE_RETRY_EXHAUSTED");
  expect(transaction.processedAt).toBeUndefined();
  expect(transaction.isTerminal()).toBe(true);
  expect(wallet.balance.toJSON().amount).toBe("100.00");
  expect(wallet.version).toBe(1);
  expect(() => transaction.apply(wallet)).toThrow("terminal");
  expect(() => transaction.reject("INSUFFICIENT_FUNDS")).toThrow("terminal");
  expect(() => transaction.fail("INFRASTRUCTURE_RETRY_EXHAUSTED")).toThrow(
    "terminal",
  );
});

test("BET debita uma vez e nao permite reaplicar uma transacao terminal", () => {
  const { wallet, transaction } = fixture();
  expect(transaction.status).toBe("PENDING");
  expect(transaction.applyBet(wallet)?.direction).toBe("DEBIT");
  expect(transaction.status).toBe("PROCESSED");
  expect(wallet.balance.toJSON().amount).toBe("20.00");
  expect(wallet.version).toBe(2);
  expect(() => transaction.applyBet(wallet)).toThrow("terminal");
  expect(wallet.balance.toJSON().amount).toBe("20.00");
});

test.each([
  { amount: "150.00", currency: "BRL", code: "INSUFFICIENT_FUNDS" },
  { amount: "80.00", currency: "USD", code: "CURRENCY_MISMATCH" },
  { amount: "0.00", currency: "BRL", code: "INVALID_AMOUNT" },
])(
  "BET rejeitada por $code nao altera carteira nem gera ledger",
  ({ amount, currency, code }) => {
    const { wallet, transaction } = fixture(amount, currency);
    expect(transaction.applyBet(wallet)).toBeUndefined();
    expect(transaction.status).toBe("REJECTED");
    expect(transaction.failureCode).toBe(code);
    expect(wallet.balance.toJSON().amount).toBe("100.00");
    expect(wallet.version).toBe(1);
    expect(() => transaction.applyBet(wallet)).toThrow("terminal");
  },
);

test("BET de outro jogador e rejeitada", () => {
  const { wallet, identity } = fixture();
  const transaction = WagerTransaction.create({
    ...identity,
    playerId: crypto.randomUUID(),
  });
  expect(transaction.applyBet(wallet)).toBeUndefined();
  expect(transaction.failureCode).toBe("PLAYER_MISMATCH");
  expect(wallet.version).toBe(1);
});

test("rehydrate preserva estado terminal e protege a data", () => {
  const { identity, wallet } = fixture();
  const at = new Date("2026-10-16T12:00:00Z");
  const transaction = WagerTransaction.rehydrate(identity, {
    status: "PROCESSED",
    processedAt: at,
  });
  at.setFullYear(2000);
  transaction.processedAt?.setFullYear(2001);
  expect(transaction.processedAt?.getUTCFullYear()).toBe(2026);
  expect(() => transaction.applyBet(wallet)).toThrow("terminal");
  expect(isTerminalStatus("FAILED")).toBe(true);
  expect(isTerminalStatus("PENDING_REFERENCE")).toBe(false);
});

test("hash canonico ignora ordem das chaves e distingue valores de negocio", () => {
  const { identity } = fixture();
  const input = transactionInputSchema.parse({
    providerId: identity.providerId,
    externalTransactionId: identity.externalTransactionId,
    playerId: identity.playerId,
    walletId: identity.walletId,
    roundId: identity.roundId,
    gameId: identity.gameId,
    kind: "BET",
    money: { amount: "080.00", currency: "BRL" },
  });
  const reordered = {
    ...Object.fromEntries(Object.entries(input).reverse()),
    money: { currency: "BRL", amount: "80.00" },
  };
  expect(hashTransactionPayload(input)).toBe(
    hashTransactionPayload(transactionInputSchema.parse(reordered)),
  );
  expect(hashTransactionPayload(input)).not.toBe(
    hashTransactionPayload({ ...input, roundId: "other" }),
  );
});

test("LOSS registra a perda sem descontar novamente a aposta", () => {
  const { wallet, transaction, identity } = fixture();

  transaction.applyBet(wallet);

  const loss = WagerTransaction.create({
    ...identity,
    id: crypto.randomUUID(),
    externalTransactionId: "loss-1",
    idempotencyKey: "provider-a:loss-1",
    kind: "LOSS",
  });

  expect(() => loss.applyBet(wallet)).toThrow("Expected BET");

  expect(loss.applyLoss(wallet)).toBeUndefined();
  expect(loss.status).toBe("PROCESSED");
  expect(loss.processedAt).toBeInstanceOf(Date);

  expect(wallet.balance.toJSON().amount).toBe("20.00");
  expect(wallet.version).toBe(2);

  expect(() => loss.applyLoss(wallet)).toThrow("terminal");
});

test("LOSS em outra moeda é rejeitada sem alterar a carteira", () => {
  const { wallet, identity } = fixture("80.00", "USD");

  const loss = WagerTransaction.create({
    ...identity,
    kind: "LOSS",
  });

  loss.applyLoss(wallet);

  expect(loss.status).toBe("REJECTED");
  expect(loss.failureCode).toBe("CURRENCY_MISMATCH");
  expect(loss.processedAt).toBeUndefined();
  expect(wallet.balance.toJSON().amount).toBe("100.00");
  expect(wallet.version).toBe(1);
});

test("WIN credita o prêmio e produz lançamento de crédito", () => {
  const { wallet, transaction, identity } = fixture();

  transaction.applyBet(wallet);

  const win = WagerTransaction.create({
    ...identity,
    id: crypto.randomUUID(),
    externalTransactionId: "win-1",
    idempotencyKey: "provider-a:win-1",
    kind: "WIN",
    money: Money.from({ amount: "150.00", currency: "BRL" }),
  });

  const entry = win.applyWin(wallet);

  expect(win.status).toBe("PROCESSED");
  expect(entry?.direction).toBe("CREDIT");
  expect(entry?.balanceBefore.toJSON().amount).toBe("20.00");
  expect(entry?.balanceAfter.toJSON().amount).toBe("170.00");
  expect(wallet.balance.toJSON().amount).toBe("170.00");
  expect(wallet.version).toBe(3);

  expect(() => win.applyWin(wallet)).toThrow("terminal");
});

test("WIN acima do limite não altera a carteira", () => {
  const { wallet, identity } = fixture();

  const win = WagerTransaction.create({
    ...identity,
    kind: "WIN",
    money: Money.from({
      amount: "999999999999999999.99",
      currency: "BRL",
    }),
  });

  expect(win.applyWin(wallet)).toBeUndefined();
  expect(win.status).toBe("REJECTED");
  expect(win.failureCode).toBe("BALANCE_LIMIT_EXCEEDED");
  expect(wallet.balance.toJSON().amount).toBe("100.00");
  expect(wallet.version).toBe(1);
});
