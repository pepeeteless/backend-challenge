export interface LogFields {
  correlationId?: string | null;
  messageId?: string | null;
  transactionId?: string | null;
  walletId?: string | null;
  providerId?: string | null;
  eventId?: string | null;
  code?: string;
  status?: string;
  attempts?: number;
  checkedEntries?: number;
  replay?: boolean;
}

export function logEvent(event: string, fields: LogFields = {}, level: "info" | "error" = "info") {
  // Lista explicita: nunca serializar Error, request, headers ou payload financeiro.
  const safe: Record<string, unknown> = {};
  for (const key of ["correlationId", "messageId", "transactionId", "walletId", "providerId", "eventId", "code", "status"] as const) {
    const value = fields[key];
    safe[key] = typeof value === "string" ? value.slice(0, 200) : null;
  }
  for (const key of ["attempts", "checkedEntries", "replay"] as const) {
    if (typeof fields[key] === "number" || typeof fields[key] === "boolean") safe[key] = fields[key];
  }
  safe.correlationId ??= safe.transactionId ?? safe.messageId ?? crypto.randomUUID();
  const line = JSON.stringify({ timestamp: new Date().toISOString(), level, event, ...safe });
  if (level === "error") console.error(line); else console.log(line);
}

export function errorCode(error: unknown): string {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  return typeof code === "string" && /^[A-Za-z0-9_]{1,64}$/.test(code) ? code : "UNKNOWN";
}
