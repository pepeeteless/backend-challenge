import { Migration } from "@mikro-orm/migrations";

export class Migration202610150001 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      CREATE TABLE wager_transactions (
        id uuid PRIMARY KEY,
        wallet_id uuid NOT NULL,
        currency varchar(3) NOT NULL,
        amount numeric(20, 2) NOT NULL,
        kind varchar(10) NOT NULL,
        status varchar(20) NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        processed_at timestamptz,

        CONSTRAINT transactions_wallet_currency_fk
          FOREIGN KEY (wallet_id, currency)
          REFERENCES wallets (id, currency),

        CONSTRAINT transactions_amount_valid
          CHECK (
            amount BETWEEN 0 AND 999999999999999999.99
          ),

        CONSTRAINT transactions_kind_valid
          CHECK (
            kind IN ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')
          ),

        CONSTRAINT transactions_status_valid
          CHECK (
            status IN (
              'PENDING', 'PENDING_REFERENCE',
              'PROCESSED', 'REJECTED', 'FAILED'
            )
          ),

        CONSTRAINT transactions_processed_at_valid
          CHECK (
            (status = 'PROCESSED' AND processed_at IS NOT NULL)
            OR
            (status <> 'PROCESSED' AND processed_at IS NULL)
          ),

        CONSTRAINT transactions_ledger_identity_unique
          UNIQUE (id, wallet_id, currency, amount)
      );

      CREATE UNIQUE INDEX transactions_one_opening_per_wallet
      ON wager_transactions (wallet_id)
      WHERE kind = 'OPENING';

      ALTER TABLE wallet_ledger_entries
      ADD CONSTRAINT ledger_transaction_fk
      FOREIGN KEY (transaction_id, wallet_id, currency, amount)
      REFERENCES wager_transactions (id, wallet_id, currency, amount);
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      ALTER TABLE wallet_ledger_entries
      DROP CONSTRAINT ledger_transaction_fk;

      DROP TABLE wager_transactions;
    `);
  }
}
