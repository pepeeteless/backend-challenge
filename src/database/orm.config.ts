import { defineConfig } from "@mikro-orm/postgresql";
import { WalletSchema } from "../wallets/wallet.schema";
import { Migrator } from "@mikro-orm/migrations";
import { Migration202610140001 } from "./migrations/Migration202610140001";
import { Migration202610140002 } from "./migrations/Migration202610140002";
import { Migration202610150001 } from "./migrations/Migration202610150001";
import { Migration202610160001 } from "./migrations/Migration202610160001";

export default defineConfig({
  host: "127.0.0.1",
  port: 5432,
  user: "pepe",
  password: "pepe_local",
  dbName: "pepe",
  entities: [WalletSchema],
  extensions: [Migrator],
  migrations: {
    migrationsList: [
      Migration202610140001,
      Migration202610140002,
      Migration202610150001,
      Migration202610160001,
    ],
    transactional: true,
    allOrNothing: true,
  },
});
