import { expect, spyOn, test } from "bun:test";
import { errorCode, logEvent, type LogFields } from "../logger";
import { operationalMetrics } from "../metrics";

test("logger seleciona somente campos permitidos e nao inclui valores, headers ou erros brutos", () => {
  const output = spyOn(console, "log").mockImplementation(() => {});
  try {
    const fields = {
      transactionId: "tx",
      walletId: "wallet",
      providerId: "provider",
      messageId: "message",
      amount: "123.45",
      authorization: "secret",
      payload: { money: "99.00" },
      error: new Error("sensitive"),
    };
    logEvent("test", fields as LogFields);
    const line = output.mock.calls[0]![0] as string;
    const record = JSON.parse(line);
    expect(record).toMatchObject({
      correlationId: "tx",
      transactionId: "tx",
      walletId: "wallet",
      providerId: "provider",
      messageId: "message",
      level: "info",
    });
    for (const secret of [
      "123.45",
      "secret",
      "99.00",
      "sensitive",
      "authorization",
      "payload",
    ])
      expect(line).not.toContain(secret);
    expect(Number.isNaN(Date.parse(record.timestamp))).toBe(false);
    expect(errorCode({ code: "55P03" })).toBe("55P03");
    expect(errorCode({ code: "query with sensitive data" })).toBe("UNKNOWN");
  } finally {
    output.mockRestore();
  }
});

test("histograma e cumulativo e erro de lock nao e contado duas vezes em camadas diferentes", () => {
  const before = operationalMetrics.lockConflicts;
  const error = { code: "55P03" };
  operationalMetrics.databaseError(error);
  operationalMetrics.databaseError(error);
  expect(operationalMetrics.lockConflicts).toBe(before + 1);
  operationalMetrics.observe("http", 0.02);
  const output = operationalMetrics.render();
  const value = (le: string) =>
    Number(
      output.match(
        new RegExp(
          `transaction_processing_seconds_bucket\\{source="http",le="${le}"\\} (\\d+)`,
        ),
      )?.[1],
    );
  expect(value("0.025")).toBeGreaterThanOrEqual(value("0.01"));
  expect(value("0.5")).toBeGreaterThanOrEqual(value("0.025"));
  expect(output).not.toContain("walletId");
});
