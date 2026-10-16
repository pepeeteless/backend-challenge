import { createHash } from "node:crypto";
import { z } from "zod";
import { Money } from "../wallets/money";

const identifier = z.string().min(1).max(200);
const uuid = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());

export const betInputSchema = z
  .object({
    providerId: identifier,
    externalTransactionId: identifier,
    playerId: uuid,
    walletId: uuid,
    roundId: identifier,
    gameId: identifier,
    kind: z.literal("BET"),
    money: z
      .object({
        amount: z.string(),
        currency: z.string().regex(/^[A-Z]{3}$/),
      })
      .strict()
      .refine(
        (value) => {
          try {
            Money.from(value);
            return true;
          } catch {
            return false;
          }
        },
        { message: "Invalid monetary amount" },
      )
      .transform((value) => Money.from(value).toJSON()),
  })
  .strict();

export const idempotencyKeySchema = identifier;
export type BetInput = z.infer<typeof betInputSchema>;

function canonicalJson(value: unknown): string {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
      .join(",")}}`;
  }
  // BetInput contem apenas objetos e strings; nao inclui metadados HTTP/SQS.
  return JSON.stringify(value);
}

export function hashBetPayload(input: BetInput): string {
  return createHash("sha256").update(canonicalJson(input)).digest("hex");
}
