import { MikroORM } from "@mikro-orm/postgresql";
import config from "./orm.config";

async function main(): Promise<void> {
  const direction = process.argv[2];

  if (direction !== "up" && direction !== "down") {
    throw new Error("Use: migrate.ts up | down");
  }

  const orm = await MikroORM.init(config);

  try {
    if (direction == "up") {
      await orm.migrator.up();
    } else {
      await orm.migrator.down();
    }
  } finally {
    await orm.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
