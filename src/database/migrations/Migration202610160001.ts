import { Migration } from "@mikro-orm/migrations";

export class Migration202610160001 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      ALTER TABLE wager_transactions
        ADD COLUMN provider_id varchar(200),
        ADD COLUMN external_transaction_id varchar(200),
        ADD COLUMN idempotency_key varchar(200),
        ADD COLUMN payload_hash varchar(64),
        ADD COLUMN player_id uuid,
        ADD COLUMN round_id varchar(200),
        ADD COLUMN game_id varchar(200),
        ADD COLUMN failure_code varchar(50),
        ADD COLUMN response jsonb,
        ADD CONSTRAINT transactions_idempotency_unique UNIQUE (idempotency_key),
        ADD CONSTRAINT transactions_external_unique UNIQUE (provider_id, external_transaction_id),
        ADD CONSTRAINT transactions_external_fields CHECK (
          kind = 'OPENING' OR (
            provider_id IS NOT NULL AND length(provider_id) > 0
            AND external_transaction_id IS NOT NULL AND length(external_transaction_id) > 0
            AND idempotency_key IS NOT NULL AND length(idempotency_key) > 0
            AND payload_hash IS NOT NULL AND payload_hash ~ '^[a-f0-9]{64}$'
            AND player_id IS NOT NULL AND round_id IS NOT NULL AND game_id IS NOT NULL
          )
        ),
        ADD CONSTRAINT transactions_rejection_code CHECK (
          kind = 'OPENING' OR ((status IN ('REJECTED', 'FAILED')) = (failure_code IS NOT NULL))
        ),
        ADD CONSTRAINT transactions_terminal_response CHECK (
          kind = 'OPENING' OR status NOT IN ('PROCESSED', 'REJECTED', 'FAILED')
          OR (response IS NOT NULL AND jsonb_typeof(response) = 'object')
        );

      ALTER TABLE wager_transactions DROP CONSTRAINT transactions_wallet_currency_fk;
      ALTER TABLE wager_transactions ADD CONSTRAINT transactions_wallet_fk
        FOREIGN KEY (wallet_id) REFERENCES wallets(id);

      CREATE FUNCTION protect_wager_transaction() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP IN ('UPDATE', 'DELETE') THEN
          IF OLD.status IN ('PROCESSED', 'REJECTED', 'FAILED') THEN
            RAISE EXCEPTION 'Terminal transactions are immutable';
          END IF;
        END IF;
        IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
        IF NEW.status = 'PROCESSED' AND NOT EXISTS (
          SELECT 1 FROM wallets WHERE id = NEW.wallet_id AND currency = NEW.currency
        ) THEN
          RAISE EXCEPTION 'Processed transaction currency must match wallet';
        END IF;
        RETURN NEW;
      END;
      $$;

      CREATE TRIGGER wager_transaction_protection
        BEFORE INSERT OR UPDATE OR DELETE ON wager_transactions
        FOR EACH ROW EXECUTE FUNCTION protect_wager_transaction();
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      DROP TRIGGER wager_transaction_protection ON wager_transactions;
      DROP FUNCTION protect_wager_transaction();
      ALTER TABLE wager_transactions DROP CONSTRAINT transactions_wallet_fk;
      ALTER TABLE wager_transactions ADD CONSTRAINT transactions_wallet_currency_fk
        FOREIGN KEY (wallet_id, currency) REFERENCES wallets(id, currency);
      ALTER TABLE wager_transactions
        DROP COLUMN provider_id, DROP COLUMN external_transaction_id,
        DROP COLUMN idempotency_key, DROP COLUMN payload_hash,
        DROP COLUMN player_id, DROP COLUMN round_id, DROP COLUMN game_id,
        DROP COLUMN failure_code, DROP COLUMN response;
    `);
  }
}
