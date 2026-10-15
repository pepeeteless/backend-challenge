import { Migration } from "@mikro-orm/migrations";

export class Migration202610140001 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      CREATE TABLE wallets (
        id uuid PRIMARY KEY,
        player_id uuid NOT NULL,
        currency varchar(3) NOT NULL,
        balance numeric(20, 2) NOT NULL,
        version integer NOT NULL DEFAULT 1,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),

        CONSTRAINT wallets_player_currency_unique
          UNIQUE (player_id, currency),

        CONSTRAINT wallets_balance_range
          CHECK (
            balance BETWEEN 0.00 AND 999999999999999999.99
          ),

        CONSTRAINT wallets_version_positive
          CHECK (version >= 1),

        CONSTRAINT wallets_currency_format
          CHECK (currency ~ '^[A-Z]{3}$')
      );
    `);
  }

  override async down(): Promise<void> {
    this.addSql("DROP TABLE wallets;");
  }
}
