import { MikroORM } from "@mikro-orm/postgresql";
import config from "../src/database/orm.config";

// Credenciais apenas do Compose local. Execute como dono do schema, apos migrations.
const orm = await MikroORM.init(config);
try {
  await orm.em.transactional(async em => {
    const sql = (query: string) => em.getConnection().execute(query);
    await sql(`DO $$ BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'wager_app') THEN
        CREATE ROLE wager_app LOGIN PASSWORD 'wager_app_local'
          NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
      END IF;
    END $$`);
    await sql('GRANT USAGE ON SCHEMA public TO wager_app');
    await sql('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM wager_app');
    await sql('GRANT SELECT, INSERT, UPDATE ON wallets, wager_transactions, inbox_messages, outbox_messages TO wager_app');
    await sql('GRANT SELECT, INSERT ON wallet_ledger_entries, dead_letter_messages TO wager_app');
    await sql('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO wager_app');
  });
  console.log('Runtime role configured');
} finally {
  await orm.close();
}
