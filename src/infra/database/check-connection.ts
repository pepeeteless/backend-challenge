import { MikroORM } from "@mikro-orm/postgresql";
import { WalletSchema } from "./wallet.schema";
import config from "./orm.config";

async function main(): Promise<void> {
  const orm = await MikroORM.init(config);

  try {
    const em = orm.em.fork();
    const wallets = await em.find(WalletSchema, {});

    console.log(wallets);
  } finally {
    await orm.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
