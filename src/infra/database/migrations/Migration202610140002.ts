import { Migration } from "@mikro-orm/migrations";

export class Migration202610140002 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      ALTER TABLE wallets
      ADD CONSTRAINT wallets_id_currency_unique UNIQUE (id, currency);

      CREATE TABLE wallet_ledger_entries (
        id uuid PRIMARY KEY,
        wallet_id uuid NOT NULL,
        transaction_id uuid NOT NULL,
        direction varchar(6) NOT NULL,
        currency varchar(3) NOT NULL,
        amount numeric(20, 2) NOT NULL,
        balance_before numeric(20, 2) NOT NULL,
        balance_after numeric(20, 2) NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),

        CONSTRAINT ledger_wallet_currency_fk
          FOREIGN KEY (wallet_id, currency)
          REFERENCES wallets (id, currency),

        CONSTRAINT ledger_transaction_wallet_unique
          UNIQUE (transaction_id, wallet_id),

        CONSTRAINT ledger_direction_valid
          CHECK (direction IN ('DEBIT', 'CREDIT')),

        CONSTRAINT ledger_amount_valid
          CHECK (
            amount > 0
            AND amount <= 999999999999999999.99
          ),

        CONSTRAINT ledger_balances_valid
          CHECK (
            balance_before BETWEEN 0 AND 999999999999999999.99
            AND balance_after BETWEEN 0 AND 999999999999999999.99
          ),

        CONSTRAINT ledger_arithmetic_valid
          CHECK (
            (direction = 'DEBIT'
              AND balance_after = balance_before - amount)
            OR
            (direction = 'CREDIT'
              AND balance_after = balance_before + amount)
          )
      );

      CREATE FUNCTION reject_ledger_mutation()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        RAISE EXCEPTION 'Ledger entries are immutable';
      END;
      $$;

      CREATE TRIGGER ledger_immutable
      BEFORE UPDATE OR DELETE ON wallet_ledger_entries
      FOR EACH ROW
      EXECUTE FUNCTION reject_ledger_mutation();
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      DROP TABLE wallet_ledger_entries;
      DROP FUNCTION reject_ledger_mutation();

      ALTER TABLE wallets
      DROP CONSTRAINT wallets_id_currency_unique;
    `);
  }
}
