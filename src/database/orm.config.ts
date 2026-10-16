import { defineConfig } from "@mikro-orm/postgresql";
import { WalletSchema } from "../wallets/wallet.schema";
import { WalletLedgerEntrySchema } from "../wallets/wallet-ledger-entry.schema";
import { WagerTransactionSchema } from "../wagering/wager-transaction.schema";
import { Migrator } from "@mikro-orm/migrations";
import { Migration202610140001 } from "./migrations/Migration202610140001";
import { Migration202610140002 } from "./migrations/Migration202610140002";
import { Migration202610150001 } from "./migrations/Migration202610150001";
import { Migration202610160001 } from "./migrations/Migration202610160001";
import { Migration202610160002 } from "./migrations/Migration202610160002";
import { Migration202610160003 } from "./migrations/Migration202610160003";
import { Migration202610160004 } from "./migrations/Migration202610160004";
import { Migration202610160005 } from "./migrations/Migration202610160005";
import { DeadLetterSchema } from "../messaging/dead-letter.schema";
import { InboxSchema, OutboxSchema } from "../messaging/message.schema";

export default defineConfig({
  host: process.env.DB_HOST ?? "127.0.0.1",
  port: 5432,
  user: process.env.DB_USER ?? "pepe",
  password: process.env.DB_PASSWORD ?? "pepe_local",
  dbName: process.env.DB_NAME ?? "pepe",
  driverOptions: { connectionTimeoutMillis: 2500 },
  entities: [WalletSchema, WagerTransactionSchema, WalletLedgerEntrySchema, InboxSchema, OutboxSchema, DeadLetterSchema],
  extensions: [Migrator],
  migrations: {
    migrationsList: [
      Migration202610140001,
      Migration202610140002,
      Migration202610150001,
      Migration202610160001,
      Migration202610160002,
      Migration202610160003,
      Migration202610160004,
      Migration202610160005,
    ],
    transactional: true,
    allOrNothing: true,
  },
});
