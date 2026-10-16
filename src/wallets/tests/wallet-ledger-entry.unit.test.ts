import { expect, test } from "bun:test";
import { Money } from "../money";
import { WalletLedgerEntry } from "../wallet-ledger-entry";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });

const debit = {
  id: "entry-1",
  walletId: "wallet-1",
  transactionId: "transaction-1",
  direction: "DEBIT" as const,
  money: brl("80.00"),
  balanceBefore: brl("100.00"),
  balanceAfter: brl("20.00"),
};

test("registra débito com aritmética correta e objeto congelado", () => {
  const entry = WalletLedgerEntry.create(debit);

  expect(entry.isBalanced()).toBe(true);
  expect(Object.isFrozen(entry)).toBe(true);
});

test("rejeita lançamento cuja conta não fecha", () => {
  expect(() =>
    WalletLedgerEntry.create({
      ...debit,
      balanceAfter: brl("30.00"),
    }),
  ).toThrow();
});

test("registra crédito com aritmética correta", () => {
  const entry = WalletLedgerEntry.create({
    ...debit,
    direction: "CREDIT",
    balanceAfter: brl("180.00"),
  });

  expect(entry.isBalanced()).toBe(true);
});

test("rejeita lançamento com saldo final negativo", () => {
  expect(() =>
    WalletLedgerEntry.create({
      ...debit,
      money: brl("120.00"),
      balanceAfter: brl("20.00").negate(),
    }),
  ).toThrow();
});
