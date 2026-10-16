// Executado somente pelo teste que verifica tres processos Bun independentes.
import { MikroORM } from "@mikro-orm/postgresql";
import config from "../database/orm.config";
import { ProcessBet } from "./process-bet";

const [dbName, body, key] = process.argv.slice(2);
if (!/^wager_test_[a-f0-9]{32}$/.test(dbName ?? "") || !body || !key) {
  throw new Error("This fixture requires a generated test database and a BET");
}
const orm = await MikroORM.init({ ...config, dbName });
try {
  // O pai libera os tres filhos juntos, depois de todos conectarem ao PostgreSQL.
  console.log("READY");
  await Bun.stdin.text();
  const result = await new ProcessBet(orm.em.fork()).execute(JSON.parse(body), key);
  console.log(JSON.stringify(result));
} finally {
  await orm.close();
}
