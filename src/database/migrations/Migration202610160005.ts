import { Migration } from "@mikro-orm/migrations";

export class Migration202610160005 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`CREATE TABLE dead_letter_messages (
      message_id varchar(100) PRIMARY KEY, queue_url text NOT NULL, body text NOT NULL,
      outcome varchar(50) NOT NULL, transaction_id uuid REFERENCES wager_transactions(id),
      archived_at timestamptz NOT NULL
    );`);
    this.addSql(`CREATE FUNCTION reject_dead_letter_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Dead letter archives are immutable'; END; $$;`);
    this.addSql(`CREATE TRIGGER dead_letter_immutable BEFORE UPDATE OR DELETE ON dead_letter_messages
      FOR EACH ROW EXECUTE FUNCTION reject_dead_letter_mutation();`);
  }
  override async down(): Promise<void> {
    this.addSql("DROP TABLE dead_letter_messages;");
    this.addSql("DROP FUNCTION reject_dead_letter_mutation();");
  }
}
