import { SQSClient, CreateQueueCommand, GetQueueAttributesCommand, GetQueueUrlCommand, SendMessageCommand } from "@aws-sdk/client-sqs";

export interface QueueUrls { transactions: string; deadLetters: string; events: string }
export function createSqsClient() {
  return new SQSClient({
    endpoint: process.env.SQS_ENDPOINT ?? "http://127.0.0.1:4566",
    region: process.env.AWS_REGION ?? "us-east-1",
    credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "test", secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "test" },
    useQueueUrlAsEndpoint: false,
    maxAttempts: 2,
    requestHandler: { connectionTimeout: 2000, requestTimeout: 10000 },
  });
}

export function queueNames(prefix = "wager") {
  return { transactions: `${prefix}-transactions.fifo`, deadLetters: `${prefix}-transactions-dlq.fifo`, events: `${prefix}-events.fifo` };
}

export async function findQueues(client: SQSClient, prefix = process.env.SQS_QUEUE_PREFIX ?? "wager", abortSignal?: AbortSignal): Promise<QueueUrls> {
  const names = queueNames(prefix);
  const get = async (QueueName: string) => {
    const { QueueUrl } = await client.send(new GetQueueUrlCommand({ QueueName }), { abortSignal });
    if (!QueueUrl) throw new Error("Queue URL missing");
    return QueueUrl;
  };
  return { transactions: await get(names.transactions), deadLetters: await get(names.deadLetters), events: await get(names.events) };
}

export async function setupQueues(client: SQSClient, prefix = process.env.SQS_QUEUE_PREFIX ?? "wager"): Promise<QueueUrls> {
  const names = queueNames(prefix);
  const create = async (QueueName: string, attributes: Record<string, string> = {}) => {
    const { QueueUrl } = await client.send(new CreateQueueCommand({ QueueName,
      Attributes: { FifoQueue: "true", VisibilityTimeout: "30", ...attributes } }));
    if (!QueueUrl) throw new Error("Queue URL missing");
    return QueueUrl;
  };
  const deadLetters = await create(names.deadLetters, { MessageRetentionPeriod: "1209600" });
  const { Attributes } = await client.send(new GetQueueAttributesCommand({ QueueUrl: deadLetters, AttributeNames: ["QueueArn"] }));
  const transactions = await create(names.transactions, { RedrivePolicy: JSON.stringify({ deadLetterTargetArn: Attributes?.QueueArn, maxReceiveCount: 5 }) });
  return { transactions, deadLetters, events: await create(names.events) };
}

export async function sendJson(client: SQSClient, queueUrl: string, payload: unknown, groupId: string, deduplicationId: string) {
  await client.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: JSON.stringify(payload),
    MessageGroupId: groupId, MessageDeduplicationId: deduplicationId }));
}
