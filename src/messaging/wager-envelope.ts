import { z } from "zod";
import { WagerRequestError } from "../wagering/process-transaction";

const envelopeSchema = z.object({
  messageId: z.string().min(1).max(200), type: z.literal("WagerTransactionRequested"),
  occurredAt: z.string().datetime({ offset: true }), data: z.record(z.string(), z.unknown()),
}).strict();

export function parseWagerEnvelope(body: string | undefined) {
  try { return envelopeSchema.parse(JSON.parse(body ?? "")); }
  catch { throw new WagerRequestError("INVALID_ENVELOPE", 400); }
}
