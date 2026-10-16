import { expect, spyOn, test } from "bun:test";
import { errorCode, logEvent, type LogFields } from "../../logger";

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
