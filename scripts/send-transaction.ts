import { createSqsClient, findQueues, sendJson } from "../src/messaging/sqs";
import { transactionInputSchema, idempotencyKeySchema } from "../src/wagering/transaction-input";
const path = process.argv[2];
if (!path) throw new Error("Uso: bun run sqs:send caminho-do-envelope.json");
const envelope = JSON.parse((await Bun.file(path).text()).replace(/^\uFEFF/, ""));
const { idempotencyKey, ...body } = envelope.data;
const input = transactionInputSchema.parse(body);
idempotencyKeySchema.parse(idempotencyKey);
if (typeof envelope.messageId !== "string" || !envelope.messageId) throw new Error("messageId required");
const client = createSqsClient();
try {
  const queues = await findQueues(client);
  await sendJson(client, queues.transactions, envelope, input.walletId, crypto.randomUUID());
  console.log("Mensagem enviada; consulte o saldo pela API.");
} finally { client.destroy(); }
