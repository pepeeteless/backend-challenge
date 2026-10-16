import { Migration } from "@mikro-orm/migrations";

export class Migration202610160004 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      "ALTER TABLE wallet_ledger_entries ADD COLUMN sequence bigserial NOT NULL;",
    );
    this.addSql(
      "CREATE UNIQUE INDEX ledger_wallet_sequence ON wallet_ledger_entries(wallet_id, sequence);",
    );
  }
  override async down(): Promise<void> {
    this.addSql("DROP INDEX ledger_wallet_sequence;");
    this.addSql("ALTER TABLE wallet_ledger_entries DROP COLUMN sequence;");
  }
}
