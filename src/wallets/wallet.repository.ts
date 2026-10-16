import { LockMode } from "@mikro-orm/core";
import { EntityManager } from "@mikro-orm/postgresql";
import { Money } from "./money";
import { Wallet } from "./wallet";
import { WalletSchema, type WalletRecord } from "./wallet.schema";

export class WalletRepository {
  constructor(private readonly em: EntityManager) {}

  async findById(id: string): Promise<Wallet | null> {
    const record = await this.em.findOne(WalletSchema, { id });
    return record ? this.toDomain(record) : null;
  }

  async findForUpdate(id: string): Promise<Wallet | null> {
    await this.em.execute("SET LOCAL lock_timeout = '5s'");
    const record = await this.em.findOne(WalletSchema, { id }, {
      lockMode: LockMode.PESSIMISTIC_WRITE,
      refresh: true,
    });
    return record ? this.toDomain(record) : null;
  }

  async insert(wallet: Wallet): Promise<void> {
    const record = this.em.create(WalletSchema, {
      id: wallet.id, playerId: wallet.playerId, currency: wallet.currency,
      balance: wallet.balance.toJSON().amount, version: wallet.version,
      createdAt: wallet.createdAt, updatedAt: wallet.updatedAt,
    });
    this.em.persist(record);
    await this.em.flush();
  }

  async save(wallet: Wallet): Promise<void> {
    const record = await this.em.findOneOrFail(WalletSchema, { id: wallet.id });
    record.balance = wallet.balance.toJSON().amount;
    record.version = wallet.version;
    record.updatedAt = wallet.updatedAt;
    await this.em.flush();
  }

  private toDomain(record: WalletRecord): Wallet {
    return Wallet.rehydrate({
      ...record,
      balance: Money.from({ amount: record.balance, currency: record.currency }),
    });
  }
}
