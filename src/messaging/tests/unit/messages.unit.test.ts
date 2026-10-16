import { expect, test } from "bun:test";
import { WagerTransactionProcessed } from "../../events/integration-event";
import { OutboxMessage } from "../../domain/outbox-message";
import { InboxMessage } from "../../domain/inbox-message";

test("tentar publicar novamente mantém o ID e um evento publicado não volta à fila", () => {
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

test("uma mensagem recebida só pode ser concluída uma vez", () => {
  const message = InboxMessage.receive("consumer", "id", "hash");
  const response = {
    transactionId: "t",
    status: "PROCESSED" as const,
    balance: { amount: "20.00", currency: "BRL" },
    idempotentReplay: false,
  };
  message.markProcessed(response);
  const record = message.toRecord();
  if (!record.response) throw new Error("Expected a saved response");
  record.response.balance.amount = "99.00";
  expect(message.toRecord().response?.balance.amount).toBe("20.00");
  expect(() => message.markProcessed(response)).toThrow();
});
