import { Migration } from "@mikro-orm/migrations";

export class Migration202610160002 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      ALTER TABLE wager_transactions
        ADD COLUMN reference_external_transaction_id varchar(200),
        ADD COLUMN reference_transaction_id uuid REFERENCES wager_transactions(id),
        ADD COLUMN reference_attempts integer NOT NULL DEFAULT 0,
        ADD COLUMN next_reference_attempt_at timestamptz,
        ADD CONSTRAINT transactions_reference_required CHECK (
          kind NOT IN ('REFUND', 'ROLLBACK') OR reference_external_transaction_id IS NOT NULL
        ),
        ADD CONSTRAINT transactions_reference_allowed CHECK (
          reference_external_transaction_id IS NULL OR (
            kind IN ('WIN', 'REFUND', 'ROLLBACK')
            AND length(reference_external_transaction_id) > 0
            AND reference_external_transaction_id <> external_transaction_id
          )
        ),
        ADD CONSTRAINT transactions_reference_resolved CHECK (
          status <> 'PROCESSED' OR reference_external_transaction_id IS NULL OR reference_transaction_id IS NOT NULL
        ),
        ADD CONSTRAINT transactions_reference_attempts CHECK (reference_attempts >= 0),
        ADD CONSTRAINT transactions_reference_schedule CHECK (
          (status = 'PENDING_REFERENCE') = (next_reference_attempt_at IS NOT NULL)
        );

      CREATE UNIQUE INDEX transactions_one_reversal_per_kind
        ON wager_transactions(reference_transaction_id, kind)
        WHERE status = 'PROCESSED' AND kind IN ('REFUND', 'ROLLBACK');
      CREATE INDEX transactions_pending_reference_due
        ON wager_transactions(next_reference_attempt_at, id)
        WHERE status = 'PENDING_REFERENCE';

      CREATE FUNCTION validate_processed_reference() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE ref wager_transactions%ROWTYPE;
      BEGIN
        IF NEW.status <> 'PROCESSED' OR NEW.reference_external_transaction_id IS NULL THEN
          RETURN NEW;
        END IF;
        SELECT * INTO ref FROM wager_transactions WHERE id = NEW.reference_transaction_id;
        IF NOT FOUND OR ref.status <> 'PROCESSED'
          OR ref.provider_id IS DISTINCT FROM NEW.provider_id
          OR ref.external_transaction_id IS DISTINCT FROM NEW.reference_external_transaction_id
          OR ref.wallet_id IS DISTINCT FROM NEW.wallet_id
          OR ref.player_id IS DISTINCT FROM NEW.player_id
          OR ref.currency IS DISTINCT FROM NEW.currency
          OR ref.round_id IS DISTINCT FROM NEW.round_id THEN
          RAISE EXCEPTION 'Invalid processed reference context';
        END IF;
        IF (NEW.kind IN ('WIN', 'REFUND') AND ref.kind <> 'BET')
          OR (NEW.kind = 'ROLLBACK' AND ref.kind NOT IN ('BET', 'WIN', 'REFUND')) THEN
          RAISE EXCEPTION 'Invalid processed reference kind';
        END IF;
        IF NEW.kind IN ('REFUND', 'ROLLBACK') AND NEW.amount <> ref.amount THEN
          RAISE EXCEPTION 'Reversal amount must match reference';
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER wager_reference_validation BEFORE INSERT OR UPDATE ON wager_transactions
        FOR EACH ROW EXECUTE FUNCTION validate_processed_reference();
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      DROP TRIGGER wager_reference_validation ON wager_transactions;
      DROP FUNCTION validate_processed_reference();
      DROP INDEX transactions_one_reversal_per_kind;
      DROP INDEX transactions_pending_reference_due;
      ALTER TABLE wager_transactions
        DROP COLUMN reference_external_transaction_id,
        DROP COLUMN reference_transaction_id,
        DROP COLUMN reference_attempts,
        DROP COLUMN next_reference_attempt_at;
    `);
  }
}
