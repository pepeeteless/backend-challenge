import { expect, test } from "bun:test";
import { Money } from "../money";
import { Wallet } from "../wallet";

test("abre carteira com saldo informado e versão 1", () => {
  const wallet = Wallet.open({
    id: "wallet-1",
    playerId: "player-1",
    initialBalance: Money.from({
      amount: "100.00",
      currency: "BRL",
    }),
  });

  expect(wallet.id).toBe("wallet-1");
  expect(wallet.playerId).toBe("player-1");
  expect(wallet.currency).toBe("BRL");
  expect(wallet.balance.toJSON().amount).toBe("100.00");
  expect(wallet.version).toBe(1);
});

test("permite abrir carteira com saldo zero", () => {
  const wallet = Wallet.open({
    id: "wallet-1",
    playerId: "player-1",
    initialBalance: Money.zero("BRL"),
  });

  expect(wallet.balance.isZero()).toBe(true);
  expect(wallet.version).toBe(1);
});

test("rejeita abertura com saldo negativo", () => {
  const negativo = Money.from({
    amount: "10.00",
    currency: "BRL",
  }).negate();

  expect(() =>
    Wallet.open({
      id: "wallet-1",
      playerId: "player-1",
      initialBalance: negativo,
    }),
  ).toThrow();
});

test("debita, incrementa versão e produz o lançamento correspondente", () => {
  const wallet = Wallet.open({
    id: "wallet-1",
    playerId: "player-1",
    initialBalance: Money.from({ amount: "100.00", currency: "BRL" }),
  });

  const entry = wallet.debit({
    entryId: "entry-1",
    transactionId: "bet-1",
    money: Money.from({ amount: "80.00", currency: "BRL" }),
  });

  expect(wallet.balance.toJSON().amount).toBe("20.00");
  expect(wallet.version).toBe(2);
  expect(entry.walletId).toBe(wallet.id);
  expect(entry.transactionId).toBe("bet-1");
  expect(entry.direction).toBe("DEBIT");
  expect(entry.money.toJSON().amount).toBe("80.00");
  expect(entry.balanceBefore.toJSON().amount).toBe("100.00");
  expect(entry.balanceAfter.equals(wallet.balance)).toBe(true);

  expect(() =>
    wallet.debit({
      entryId: "entry-2",
      transactionId: "bet-2",
      money: Money.from({ amount: "80.00", currency: "BRL" }),
    }),
  ).toThrow("Insufficient funds");

  expect(wallet.balance.toJSON().amount).toBe("20.00");
  expect(wallet.version).toBe(2);
});

test("rejeita débito em outra moeda sem alterar a carteira", () => {
  const wallet = Wallet.open({
    id: "wallet-1",
    playerId: "player-1",
    initialBalance: Money.from({ amount: "100.00", currency: "BRL" }),
  });

  expect(() =>
    wallet.debit({
      entryId: "entry-1",
      transactionId: "bet-1",
      money: Money.from({ amount: "80.00", currency: "USD" }),
    }),
  ).toThrow();

  expect(wallet.balance.toJSON().amount).toBe("100.00");
  expect(wallet.version).toBe(1);
});

test("credita e produz o lançamento correspondente", () => {
  const wallet = Wallet.open({
    id: "wallet-1",
    playerId: "player-1",
    initialBalance: Money.from({ amount: "20.00", currency: "BRL" }),
  });

  const entry = wallet.credit({
    entryId: "entry-1",
    transactionId: "win-1",
    money: Money.from({ amount: "50.00", currency: "BRL" }),
  });

  expect(wallet.balance.toJSON().amount).toBe("70.00");
  expect(wallet.version).toBe(2);
  expect(entry.direction).toBe("CREDIT");
  expect(entry.transactionId).toBe("win-1");
  expect(entry.money.toJSON().amount).toBe("50.00");
  expect(entry.balanceBefore.toJSON().amount).toBe("20.00");
  expect(entry.balanceAfter.equals(wallet.balance)).toBe(true);
});

test("mantém saldo e versão quando o crédito ultrapassa o limite", () => {
  const wallet = Wallet.open({
    id: "wallet-1",
    playerId: "player-1",
    initialBalance: Money.from({
      amount: "999999999999999999.99",
      currency: "BRL",
    }),
  });

  expect(() =>
    wallet.credit({
      entryId: "entry-1",
      transactionId: "win-1",
      money: Money.from({ amount: "0.01", currency: "BRL" }),
    }),
  ).toThrow();

  expect(wallet.balance.toJSON().amount).toBe("999999999999999999.99");
  expect(wallet.version).toBe(1);
});

test("rejeita crédito em outra moeda sem alterar a carteira", () => {
  const wallet = Wallet.open({
    id: "wallet-1",
    playerId: "player-1",
    initialBalance: Money.zero("BRL"),
  });

  expect(() =>
    wallet.credit({
      entryId: "entry-1",
      transactionId: "win-1",
      money: Money.from({ amount: "50.00", currency: "USD" }),
    }),
  ).toThrow("Currency mismatch");

  expect(wallet.balance.isZero()).toBe(true);
  expect(wallet.version).toBe(1);
});

test("reidrata carteira preservando saldo e versão", () => {
  const wallet = Wallet.rehydrate({
    id: "wallet-1",
    playerId: "player-1",
    currency: "BRL",
    balance: Money.from({ amount: "20.00", currency: "BRL" }),
    version: 7,
    createdAt: new Date("2026-01-01T12:00:00.000Z"),
    updatedAt: new Date("2026-01-02T12:00:00.000Z"),
  });
  expect(wallet.createdAt.toISOString()).toBe("2026-01-01T12:00:00.000Z");
  expect(wallet.updatedAt.toISOString()).toBe("2026-01-02T12:00:00.000Z");
  expect(wallet.balance.toJSON().amount).toBe("20.00");
  expect(wallet.version).toBe(7);

  wallet.credit({
    entryId: "entry-1",
    transactionId: "win-1",
    money: Money.from({ amount: "10.00", currency: "BRL" }),
  });

  expect(wallet.balance.toJSON().amount).toBe("30.00");
  expect(wallet.version).toBe(8);
  expect(wallet.createdAt.toISOString()).toBe("2026-01-01T12:00:00.000Z");
  expect(wallet.updatedAt.getTime()).toBeGreaterThan(
    new Date("2026-01-02T12:00:00.000Z").getTime(),
  );
});
