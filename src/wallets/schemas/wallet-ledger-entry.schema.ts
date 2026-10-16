import {
  BigIntType,
  DecimalType,
  EntitySchema,
  type Opt,
} from "@mikro-orm/core";
import type { LedgerDirection } from "../domain/wallet-ledger-entry";

export interface WalletLedgerEntryRecord {
  sequence: Opt<string>;
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  currency: string;
  amount: string;
  balanceBefore: string;
  balanceAfter: string;
  createdAt: Date;
}

export const WalletLedgerEntrySchema =
  new EntitySchema<WalletLedgerEntryRecord>({
    name: "WalletLedgerEntryRecord",
    tableName: "wallet_ledger_entries",
    properties: {
      sequence: {
        type: new BigIntType("string"),
        defaultRaw: "nextval('wallet_ledger_entries_sequence_seq')",
      },
      id: { type: "uuid", primary: true },
      walletId: { type: "uuid", fieldName: "wallet_id" },
      transactionId: { type: "uuid", fieldName: "transaction_id" },
      direction: { type: "string", length: 6 },
      currency: { type: "string", length: 3 },
      amount: { type: new DecimalType("string"), precision: 20, scale: 2 },
      balanceBefore: {
        type: new DecimalType("string"),
        precision: 20,
        scale: 2,
        fieldName: "balance_before",
      },
      balanceAfter: {
        type: new DecimalType("string"),
        precision: 20,
        scale: 2,
        fieldName: "balance_after",
      },
      createdAt: {
        type: Date,
        columnType: "timestamptz",
        fieldName: "created_at",
        defaultRaw: "now()",
      },
    },
    uniques: [
      {
        name: "ledger_transaction_wallet_unique",
        properties: ["transactionId", "walletId"],
      },
    ],
  });
