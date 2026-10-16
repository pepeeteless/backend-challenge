import { createHash } from "node:crypto";
import { z } from "zod";
import { Money } from "../wallets/money";

const identifier = z.string().min(1).max(200);
const uuid = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());

export const transactionInputSchema = z
  .object({
    providerId: identifier,
    externalTransactionId: identifier,
    playerId: uuid,
    walletId: uuid,
    roundId: identifier,
    gameId: identifier,
    kind: z.enum(["BET", "LOSS", "WIN", "REFUND", "ROLLBACK"]),
    referenceExternalTransactionId: identifier.optional(),
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
  .strict()
  .superRefine((input, ctx) => {
    const reference = input.referenceExternalTransactionId;
    if ((input.kind === "REFUND" || input.kind === "ROLLBACK") && !reference) {
      ctx.addIssue({ code: "custom", path: ["referenceExternalTransactionId"], message: "Reference is required" });
    }
    if (reference && (input.kind === "BET" || input.kind === "LOSS")) {
      ctx.addIssue({ code: "custom", path: ["referenceExternalTransactionId"], message: "Reference not supported for this kind" });
    }
    if (reference === input.externalTransactionId) {
      ctx.addIssue({ code: "custom", path: ["referenceExternalTransactionId"], message: "Cannot reference itself" });
    }
  });

export const idempotencyKeySchema = identifier;
export type TransactionInput = z.infer<typeof transactionInputSchema>;

function canonicalJson(value: unknown): string {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .filter((key) => object[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function hashTransactionPayload(input: TransactionInput): string {
  return createHash("sha256").update(canonicalJson(input)).digest("hex");
}
