import { DecimalType, EntitySchema } from "@mikro-orm/core";

export interface WalletRecord {
  id: string;
  playerId: string;
  currency: string;
  balance: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export const WalletSchema = new EntitySchema<WalletRecord>({
  name: "WalletRecord",
  tableName: "wallets",

  properties: {
    id: { type: "uuid", primary: true },
    playerId: { type: "uuid", fieldName: "player_id" },
    currency: { type: "string", length: 3 },
    balance: {
      type: new DecimalType("string"),
      precision: 20,
      scale: 2,
    },
    version: { type: "integer", default: 1 },
    createdAt: {
      type: Date,
      fieldName: "created_at",
      columnType: "timestamptz",
      defaultRaw: "now()",
    },
    updatedAt: {
      type: Date,
      fieldName: "updated_at",
      columnType: "timestamptz",
      defaultRaw: "now()",
    },
  },

  uniques: [
    {
      name: "wallets_player_currency_unique",
      properties: ["playerId", "currency"],
    },
  ],

  checks: [
    {
      name: "wallets_balance_range",
      expression: "balance BETWEEN 0.00 AND 999999999999999999.99",
    },
    {
      name: "wallets_version_positive",
      expression: "version >= 1",
    },
    {
      name: "wallets_currency_format",
      expression: "currency ~ '^[A-Z]{3}$'",
    },
  ],
});
