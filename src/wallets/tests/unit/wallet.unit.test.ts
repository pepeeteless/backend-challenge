import { expect, test } from "bun:test";
import { Money } from "../../domain/money";
import { Wallet } from "../../domain/wallet";

function createWallet(amount = "100.00") {
  return Wallet.open({
    id: "wallet-1",
    playerId: "player-1",
    initialBalance: Money.from({ amount, currency: "BRL" }),
  });
}

function movement(amount: string, currency = "BRL") {
  return {
    entryId: "entry-1",
    transactionId: "transaction-1",
    money: Money.from({ amount, currency }),
  };
}

test.each(["100.00", "0.00"])(
  "abre carteira com saldo %s e versão 1",
  (amount) => {
    const wallet = createWallet(amount);

    expect(wallet.balance.toJSON()).toEqual({ amount, currency: "BRL" });
    expect(wallet.version).toBe(1);
  },
);

test("não abre carteira com saldo negativo", () => {
  expect(() =>
    Wallet.open({
      id: "wallet-1",
      playerId: "player-1",
      initialBalance: Money.from({ amount: "10.00", currency: "BRL" }).negate(),
    }),
  ).toThrow("Initial balance cannot be negative");
});

test("desconta 80 de 100 e registra o movimento", () => {
  const wallet = createWallet();

  const entry = wallet.debit(movement("80.00"));

  expect(wallet.balance.toJSON().amount).toBe("20.00");
  expect(wallet.version).toBe(2);
  expect(entry.direction).toBe("DEBIT");
  expect(entry.balanceBefore.toJSON().amount).toBe("100.00");
  expect(entry.balanceAfter.toJSON().amount).toBe("20.00");

  expect(() => wallet.debit(movement("80.00"))).toThrow("Insufficient funds");
  expect(wallet.balance.toJSON().amount).toBe("20.00");
  expect(wallet.version).toBe(2);
});

test("adiciona 50 a uma carteira com 20", () => {
  const wallet = createWallet("20.00");

  const entry = wallet.credit(movement("50.00"));

  expect(wallet.balance.toJSON().amount).toBe("70.00");
  expect(wallet.version).toBe(2);
  expect(entry.direction).toBe("CREDIT");
  expect(entry.balanceBefore.toJSON().amount).toBe("20.00");
  expect(entry.balanceAfter.toJSON().amount).toBe("70.00");
});

test.each(["debit", "credit"] as const)(
  "%s não aceita outra moeda",
  (operation) => {
    const wallet = createWallet();

    expect(() => wallet[operation](movement("50.00", "USD"))).toThrow(
      "Currency mismatch",
    );
    expect(wallet.balance.toJSON().amount).toBe("100.00");
    expect(wallet.version).toBe(1);
  },
);

test("crédito acima do limite não altera saldo nem versão", () => {
  const maximum = "999999999999999999.99";
  const wallet = createWallet(maximum);

  expect(() => wallet.credit(movement("0.01"))).toThrow();
  expect(wallet.balance.toJSON().amount).toBe(maximum);
  expect(wallet.version).toBe(1);
});

test("reconstrói a carteira com os dados salvos", () => {
  const createdAt = new Date("2026-01-01T12:00:00Z");
  const updatedAt = new Date("2026-01-02T12:00:00Z");
  const wallet = Wallet.rehydrate({
    id: "wallet-1",
    playerId: "player-1",
    currency: "BRL",
    balance: Money.from({ amount: "20.00", currency: "BRL" }),
    version: 7,
    createdAt,
    updatedAt,
  });

  expect(wallet.balance.toJSON().amount).toBe("20.00");
  expect(wallet.version).toBe(7);
  expect(wallet.createdAt).toEqual(createdAt);
  expect(wallet.updatedAt).toEqual(updatedAt);
});
