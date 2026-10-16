import type { MoneyProps } from "../../wallets/domain/money";

function freezeDeep<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

export interface EventContext {
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: Date;
}

export abstract class IntegrationEvent<T> {
  abstract readonly eventType: string;
  readonly version = 1;
  readonly eventId = crypto.randomUUID();
  readonly data: Readonly<T>;
  private readonly context: Readonly<
    Omit<EventContext, "occurredAt"> & { occurredAt: string }
  >;

  protected constructor(data: T, context: EventContext) {
    this.data = freezeDeep(structuredClone(data));
    this.context = Object.freeze({
      ...context,
      occurredAt: context.occurredAt.toISOString(),
    });
  }

  toJSON() {
    return {
      ...this.context,
      eventId: this.eventId,
      eventType: this.eventType,
      version: this.version,
      data: this.data,
    };
  }
}

export interface TransactionEventData {
  transactionId: string;
  walletId: string;
  kind: string;
  status: string;
  money: MoneyProps;
  failureCode?: string;
}

export class WagerTransactionProcessed extends IntegrationEvent<TransactionEventData> {
  readonly eventType = "WagerTransactionProcessed";
  static create(data: TransactionEventData, context: EventContext) {
    return freezeDeep(new WagerTransactionProcessed(data, context));
  }
}
export class WagerTransactionRejected extends IntegrationEvent<TransactionEventData> {
  readonly eventType = "WagerTransactionRejected";
  static create(data: TransactionEventData, context: EventContext) {
    return freezeDeep(new WagerTransactionRejected(data, context));
  }
}
export class WagerTransactionFailed extends IntegrationEvent<TransactionEventData> {
  readonly eventType = "WagerTransactionFailed";
  static create(data: TransactionEventData, context: EventContext) {
    return freezeDeep(new WagerTransactionFailed(data, context));
  }
}
export class WagerTransactionPendingReference extends IntegrationEvent<TransactionEventData> {
  readonly eventType = "WagerTransactionPendingReference";
  static create(data: TransactionEventData, context: EventContext) {
    return freezeDeep(new WagerTransactionPendingReference(data, context));
  }
}
export interface BalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: string;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}
export class WalletBalanceChanged extends IntegrationEvent<BalanceChangedData> {
  readonly eventType = "WalletBalanceChanged";
  static create(data: BalanceChangedData, context: EventContext) {
    return freezeDeep(new WalletBalanceChanged(data, context));
  }
}
