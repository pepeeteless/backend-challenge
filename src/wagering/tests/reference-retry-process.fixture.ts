import { MikroORM } from "@mikro-orm/postgresql";
import config from "../../database/orm.config";
import { ProcessTransaction } from "../process-transaction";

const [dbName, transactionId, at] = process.argv.slice(2);
if (!/^wager_test_[a-f0-9]{32}$/.test(dbName ?? "") || !transactionId || !at) {
  throw new Error(
    "Expected disposable test database, transaction id and retry date",
  );
}
const orm = await MikroORM.init({ ...config, dbName });
try {
  const result = await new ProcessTransaction(orm.em.fork()).retryPending(
    transactionId,
    new Date(at),
  );
  console.log(JSON.stringify(result));
} finally {
  await orm.close();
}
