import { MikroORM } from "@mikro-orm/postgresql";
import config from "../../database/orm.config";
import { createSqsClient, type QueueUrls } from "../sqs";
import { SqsConsumer } from "../sqs.consumer";

const [dbName, urls] = process.argv.slice(2);
if (!/^messaging_test_[a-f0-9]{32}$/.test(dbName ?? "") || !urls)
  throw new Error("Test arguments required");
const orm = await MikroORM.init({ ...config, dbName });
const client = createSqsClient();
const consumer = new SqsConsumer(
  orm.em.fork(),
  client,
  JSON.parse(urls) as QueueUrls,
);
try {
  const message = await consumer.receive();
  if (!message) throw new Error("Expected message");
  await consumer.process(message);
  console.log(
    JSON.stringify({ committed: true, receipt: message.ReceiptHandle }),
  );
  await Bun.stdin.text();
  await consumer.acknowledge(message);
} finally {
  await orm.close();
  client.destroy();
}
