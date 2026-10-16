import { expect, test } from "bun:test";
import { WagerTransactionProcessed } from "../integration-event";
import { OutboxMessage } from "../outbox-message";
import { InboxMessage } from "../inbox-message";

test("evento copia e congela os dados monetarios e serializa datas", () => {
  const money = { amount: "1.00", currency: "BRL" };
  const date = new Date("2026-01-01T00:00:00Z");
  const event = WagerTransactionProcessed.create(
    {
      transactionId: "t",
      walletId: "w",
      kind: "BET",
      status: "PROCESSED",
      money,
    },
    { aggregateId: "w", correlationId: "t", occurredAt: date },
  );
  money.amount = "9.00";
  date.setFullYear(2030);
  expect(event.toJSON().occurredAt).toBe("2026-01-01T00:00:00.000Z");
  expect(event.data.money.amount).toBe("1.00");
  expect(Object.isFrozen(event.data.money)).toBe(true);
  expect(event.toJSON().version).toBe(1);
});

test("outbox preserva identidade no retry e impede transicao apos publicacao", () => {
  const now = new Date();
  const event = WagerTransactionProcessed.create(
    {
      transactionId: "t",
      walletId: "w",
      kind: "LOSS",
      status: "PROCESSED",
      money: { amount: "0.00", currency: "BRL" },
    },
    { aggregateId: "w", correlationId: "t", occurredAt: now },
  );
  const message = OutboxMessage.enqueue(event);
  expect(message.isDue(now)).toBe(true);
  message.scheduleRetry(now);
  expect(message.isDue(now)).toBe(false);
  expect(message.toRecord().attempts).toBe(1);
  expect(message.toRecord().id).toBe(event.eventId);
  expect(message.toRecord().nextAttemptAt.getTime() - now.getTime()).toBe(2000);
  const restored = OutboxMessage.rehydrate(message.toRecord());
  restored.markPublished(now);
  expect(restored.isPending()).toBe(false);
  expect(() => restored.scheduleRetry(now)).toThrow();
});

test("inbox marca conclusao uma vez e nao expoe estado mutavel", () => {
  const message = InboxMessage.receive("consumer", "id", "hash");
  message.markProcessed({
    transactionId: "t",
    status: "PROCESSED",
    balance: { amount: "20.00", currency: "BRL" },
    idempotentReplay: false,
  });
  const record = message.toRecord();
  record.response!.balance.amount = "99.00";
  expect(message.toRecord().response?.balance.amount).toBe("20.00");
  expect(() => message.markProcessed(record.response!)).toThrow();
});
