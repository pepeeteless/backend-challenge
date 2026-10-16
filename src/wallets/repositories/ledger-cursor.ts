import { z } from "zod";

const sequence = z
  .string()
  .regex(/^[1-9]\d{0,18}$/)
  .refine((value) => BigInt(value) <= 9223372036854775807n);
const cursorSchema = z
  .object({
    version: z.literal(1),
    walletId: z.string().uuid(),
    after: sequence,
    through: sequence,
  })
  .strict()
  .refine((value) => BigInt(value.after) <= BigInt(value.through));
export type LedgerCursor = z.infer<typeof cursorSchema>;
export class InvalidLedgerCursor extends Error {}

export function encodeLedgerCursor(cursor: LedgerCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}
export function decodeLedgerCursor(
  token: string,
  walletId: string,
): LedgerCursor {
  try {
    if (token.length > 512 || !/^[A-Za-z0-9_-]+$/.test(token))
      throw new Error();
    const cursor = cursorSchema.parse(
      JSON.parse(Buffer.from(token, "base64url").toString("utf8")),
    );
    if (cursor.walletId !== walletId) throw new Error();
    return cursor;
  } catch {
    throw new InvalidLedgerCursor("INVALID_CURSOR");
  }
}
