import { expect, test } from "bun:test";
import { Money } from "../../../wallets/domain/money";
import { Wallet } from "../../../wallets/domain/wallet";
import {
  WagerTransaction,
  type TransactionReference,
  type WagerTransactionKind,
} from "../../domain/wager-transaction";
import {
  transactionInputSchema,
  hashTransactionPayload,
} from "../../contracts/transaction-input";
import { nextReferenceAttempt } from "../../use-cases/reference-retry-policy";

function createReferenceScenario(kind: WagerTransactionKind = "REFUND", balance = "20.00") {
  const wallet = Wallet.open({
    id: crypto.randomUUID(),
    playerId: crypto.randomUUID(),
    initialBalance: Money.from({ amount: balance, currency: "BRL" }),
  });
  const identity = {
    id: crypto.randomUUID(),
    walletId: wallet.id,
    playerId: wallet.playerId,
    providerId: "provider-a",
    externalTransactionId: "reversal-1",
    idempotencyKey: "key-1",
    payloadHash: "hash",
    roundId: "round-1",
    gameId: "game-1",
    kind,
    money: Money.from({ amount: "80.00", currency: "BRL" }),
    referenceExternalTransactionId: "bet-1",
  };
  const reference: TransactionReference = {
    id: crypto.randomUUID(),
    providerId: identity.providerId,
    externalTransactionId: "bet-1",
    walletId: wallet.id,
    playerId: wallet.playerId,
    roundId: identity.roundId,
    kind: "BET",
    status: "PROCESSED",
    money: identity.money,
  };
  return {
    wallet,
    identity,
    reference,
    transaction: WagerTransaction.create(identity),
  };
}

test.each(["REFUND", "ROLLBACK"] as const)(
  "%s devolve o valor da aposta para a carteira",
  (kind) => {
    const { wallet, transaction, reference } = createReferenceScenario(kind);
    expect(transaction.apply(wallet, reference)?.direction).toBe("CREDIT");
    expect(wallet.balance.toJSON().amount).toBe("100.00");
    expect(transaction.referenceTransactionId).toBe(reference.id);
    expect(transaction.status).toBe("PROCESSED");
    expect(() => transaction.reject("REFERENCE_NOT_FOUND")).toThrow("terminal");
  },
);

test.each(["WIN", "REFUND"] as const)("ROLLBACK de %s desconta o crédito recebido", (kind) => {
  const { wallet, transaction, reference } = createReferenceScenario("ROLLBACK", "100.00");
  expect(transaction.apply(wallet, { ...reference, kind })?.direction).toBe(
    "DEBIT",
  );
  expect(wallet.balance.toJSON().amount).toBe("20.00");
});

test("reverter um crédito já gasto retorna uma rejeição própria", () => {
  const { wallet, transaction, reference } = createReferenceScenario("ROLLBACK");
  expect(
    transaction.apply(wallet, { ...reference, kind: "WIN" }),
  ).toBeUndefined();
  expect(transaction.failureCode).toBe("REVERSAL_INSUFFICIENT_FUNDS");
  expect(wallet.balance.toJSON().amount).toBe("20.00");
  expect(wallet.version).toBe(1);
});

test.each([
  "providerId",
  "externalTransactionId",
  "playerId",
  "walletId",
  "roundId",
] as const)("rejeita uma referência com %s diferente da operação", (field) => {
  const { wallet, transaction, reference } = createReferenceScenario();
  transaction.apply(wallet, { ...reference, [field]: "other" });
  expect(transaction.failureCode).toBe("REFERENCE_MISMATCH");
  expect(wallet.version).toBe(1);
});

test("referencia em outra moeda e rejeitada", () => {
  const { wallet, transaction, reference } = createReferenceScenario();
  transaction.apply(wallet, {
    ...reference,
    money: Money.from({ amount: "80.00", currency: "USD" }),
  });
  expect(transaction.failureCode).toBe("REFERENCE_MISMATCH");
});

test("reversao parcial e duplicidade sao rejeitadas", () => {
  const { wallet, transaction, reference, identity } = createReferenceScenario();
  transaction.apply(wallet, {
    ...reference,
    money: Money.from({ amount: "40.00", currency: "BRL" }),
  });
  expect(transaction.failureCode).toBe("REFERENCE_AMOUNT_MISMATCH");
  const duplicate = WagerTransaction.create(identity);
  duplicate.apply(wallet, reference, true);
  expect(duplicate.failureCode).toBe("REFERENCE_ALREADY_REVERSED");
  expect(wallet.version).toBe(1);
});

test.each(["WIN", "REFUND", "LOSS", "ROLLBACK", "OPENING"] as const)(
  "REFUND nao referencia %s",
  (kind) => {
    const { wallet, transaction, reference } = createReferenceScenario();
    transaction.apply(wallet, { ...reference, kind });
    expect(transaction.failureCode).toBe("REFERENCE_KIND_INVALID");
  },
);

test.each(["LOSS", "ROLLBACK", "OPENING"] as const)(
  "ROLLBACK nao referencia %s",
  (kind) => {
    const { wallet, transaction, reference } = createReferenceScenario("ROLLBACK");
    transaction.apply(wallet, { ...reference, kind });
    expect(transaction.failureCode).toBe("REFERENCE_KIND_INVALID");
  },
);

test.each(["REJECTED", "FAILED"] as const)(
  "referencia %s nao pode ser revertida",
  (status) => {
    const { wallet, transaction, reference } = createReferenceScenario();
    transaction.apply(wallet, { ...reference, status });
    expect(transaction.failureCode).toBe("REFERENCE_NOT_PROCESSED");
  },
);

test("referencia ausente ou pendente aguarda e depois pode concluir", () => {
  const { wallet, transaction, reference } = createReferenceScenario();
  transaction.apply(wallet);
  expect(transaction.status).toBe("PENDING_REFERENCE");
  transaction.apply(wallet, { ...reference, status: "PENDING_REFERENCE" });
  expect(transaction.status).toBe("PENDING_REFERENCE");
  expect(wallet.version).toBe(1);
  transaction.apply(wallet, reference);
  expect(transaction.status).toBe("PROCESSED");
  expect(wallet.balance.toJSON().amount).toBe("100.00");
});

test("WIN referenciada exige BET mas seu premio pode ter outro valor", () => {
  const { wallet, identity, reference } = createReferenceScenario("WIN");
  const win = WagerTransaction.create({
    ...identity,
    money: Money.from({ amount: "150.00", currency: "BRL" }),
  });
  win.apply(wallet, reference);
  expect(wallet.balance.toJSON().amount).toBe("170.00");
  expect(win.status).toBe("PROCESSED");
});

test("entrada exige referencia para reversoes e inclui a referencia no hash", () => {
  const { identity } = createReferenceScenario();
  const input = {
    providerId: identity.providerId,
    externalTransactionId: identity.externalTransactionId,
    playerId: identity.playerId,
    walletId: identity.walletId,
    roundId: identity.roundId,
    gameId: identity.gameId,
    kind: identity.kind,
    money: identity.money.toJSON(),
    referenceExternalTransactionId: "bet-1",
  };
  expect(
    transactionInputSchema.safeParse({
      ...input,
      referenceExternalTransactionId: undefined,
    }).success,
  ).toBe(false);
  expect(
    transactionInputSchema.safeParse({
      ...input,
      referenceExternalTransactionId: identity.externalTransactionId,
    }).success,
  ).toBe(false);
  expect(
    transactionInputSchema.safeParse({ ...input, kind: "LOSS" }).success,
  ).toBe(false);
  expect(hashTransactionPayload(transactionInputSchema.parse(input))).not.toBe(
    hashTransactionPayload(
      transactionInputSchema.parse({
        ...input,
        referenceExternalTransactionId: "bet-2",
      }),
    ),
  );
  expect(() =>
    WagerTransaction.create({
      ...identity,
      referenceExternalTransactionId: undefined,
    }),
  ).toThrow("required");
});

test("backoff cresce exponencialmente ate o teto de um minuto", () => {
  const now = new Date("2026-10-16T12:00:00Z");
  expect(nextReferenceAttempt(now, 1).getTime() - now.getTime()).toBe(1000);
  expect(nextReferenceAttempt(now, 2).getTime() - now.getTime()).toBe(2000);
  expect(nextReferenceAttempt(now, 9).getTime() - now.getTime()).toBe(60000);
});
