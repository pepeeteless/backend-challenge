import { DecimalType, EntitySchema } from "@mikro-orm/core";
import type { TransactionResult } from "./transaction-result";
import type { WagerTransactionStatus } from "./wager-transaction";

export interface WagerTransactionRecord {
  id: string;
  walletId: string;
  currency: string;
  amount: string;
  kind: "OPENING" | "BET" | "WIN" | "LOSS" | "REFUND" | "ROLLBACK";
  status: WagerTransactionStatus;
  createdAt: Date;
  processedAt: Date | null;

  providerId: string | null;
  externalTransactionId: string | null;
  idempotencyKey: string | null;
  payloadHash: string | null;
  playerId: string | null;
  roundId: string | null;
  gameId: string | null;
  failureCode: string | null;
  response: TransactionResult | null;
  referenceExternalTransactionId: string | null;
  referenceTransactionId: string | null;
  referenceAttempts: number;
  nextReferenceAttemptAt: Date | null;
}

export const WagerTransactionSchema = new EntitySchema<WagerTransactionRecord>({
  name: "WagerTransactionRecord",
  tableName: "wager_transactions",

  properties: {
    referenceExternalTransactionId: {
      type: "string",
      fieldName: "reference_external_transaction_id",
      length: 200,
      nullable: true,
    },
    referenceTransactionId: {
      type: "uuid",
      fieldName: "reference_transaction_id",
      nullable: true,
    },
    referenceAttempts: {
      type: "integer",
      fieldName: "reference_attempts",
      default: 0,
    },
    nextReferenceAttemptAt: {
      type: Date,
      columnType: "timestamptz",
      fieldName: "next_reference_attempt_at",
      nullable: true,
    },
    id: { type: "uuid", primary: true },
    walletId: { type: "uuid", fieldName: "wallet_id" },
    currency: { type: "string", length: 3 },

    amount: {
      type: new DecimalType("string"),
      precision: 20,
      scale: 2,
    },

    kind: { type: "string", length: 10 },
    status: { type: "string", length: 20 },

    createdAt: {
      type: Date,
      fieldName: "created_at",
      columnType: "timestamptz",
      defaultRaw: "now()",
    },

    processedAt: {
      type: Date,
      fieldName: "processed_at",
      columnType: "timestamptz",
      nullable: true,
    },

    providerId: {
      type: "string",
      fieldName: "provider_id",
      length: 200,
      nullable: true,
    },

    externalTransactionId: {
      type: "string",
      fieldName: "external_transaction_id",
      length: 200,
      nullable: true,
    },

    idempotencyKey: {
      type: "string",
      fieldName: "idempotency_key",
      length: 200,
      nullable: true,
    },

    payloadHash: {
      type: "string",
      fieldName: "payload_hash",
      length: 64,
      nullable: true,
    },

    playerId: {
      type: "uuid",
      fieldName: "player_id",
      nullable: true,
    },

    roundId: {
      type: "string",
      fieldName: "round_id",
      length: 200,
      nullable: true,
    },

    gameId: {
      type: "string",
      fieldName: "game_id",
      length: 200,
      nullable: true,
    },

    failureCode: {
      type: "string",
      fieldName: "failure_code",
      length: 50,
      nullable: true,
    },

    response: {
      type: "json",
      columnType: "jsonb",
      nullable: true,
    },
  },
});
