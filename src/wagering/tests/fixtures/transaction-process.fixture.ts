import { MikroORM } from "@mikro-orm/postgresql";
import config from "../../../database/orm.config";
import { ProcessTransaction } from "../../use-cases/process-transaction";

const [dbName, body, key] = process.argv.slice(2);
if (!/^wager_test_[a-f0-9]{32}$/.test(dbName ?? "") || !body || !key) {
  throw new Error("This fixture requires a generated test database and a BET");
}
const orm = await MikroORM.init({ ...config, dbName });
try {
  console.log("READY");
  await Bun.stdin.text();
  const result = await new ProcessTransaction(orm.em.fork()).execute(
    JSON.parse(body),
    key,
  );
  console.log(JSON.stringify(result));
} finally {
  await orm.close();
}
