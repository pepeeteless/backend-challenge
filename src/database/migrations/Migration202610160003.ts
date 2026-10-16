import { Migration } from "@mikro-orm/migrations";

export class Migration202610160003 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`CREATE TABLE inbox_messages (
      consumer_name varchar(100) NOT NULL, message_id varchar(200) NOT NULL,
      payload_hash varchar(64) NOT NULL, received_at timestamptz NOT NULL,
      processed_at timestamptz, response jsonb,
      PRIMARY KEY (consumer_name, message_id),
      CHECK ((processed_at IS NULL) = (response IS NULL))
    );`);
    this.addSql(`CREATE TABLE outbox_messages (
      id uuid PRIMARY KEY, aggregate_id uuid NOT NULL, event_type varchar(100) NOT NULL,
      payload jsonb NOT NULL, occurred_at timestamptz NOT NULL,
      attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      next_attempt_at timestamptz NOT NULL, published_at timestamptz,
      CHECK (payload->>'eventId' = id::text),
      CHECK (payload->>'eventType' = event_type)
    );`);
    this.addSql(
      `CREATE INDEX outbox_due ON outbox_messages(next_attempt_at, id) WHERE published_at IS NULL;`,
    );
  }
  override async down(): Promise<void> {
    this.addSql("DROP TABLE outbox_messages;");
    this.addSql("DROP TABLE inbox_messages;");
  }
}
