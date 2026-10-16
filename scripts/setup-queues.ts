import { createSqsClient, setupQueues } from "../src/messaging/sqs";
const client = createSqsClient();
try { console.log(await setupQueues(client)); }
finally { client.destroy(); }
