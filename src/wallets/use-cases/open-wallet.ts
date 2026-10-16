import { EntityManager } from "@mikro-orm/postgresql";
import { Money, type MoneyProps } from "../domain/money";
import { Wallet } from "../domain/wallet";
import { WalletLedgerEntry } from "../domain/wallet-ledger-entry";
import { WalletRepository } from "../repositories/wallet.repository";
import { LedgerRepository } from "../repositories/ledger.repository";
import { WagerTransactionRepository } from "../../wagering/repositories/wager-transaction.repository";
import { MessageRepository } from "../../messaging/repositories/message.repository";
import {
  WalletBalanceChanged,
  WagerTransactionProcessed,
} from "../../messaging/events/integration-event";

interface OpenWalletInput {
  playerId: string;
  initialBalance: MoneyProps;
}

export class OpenWallet {
  constructor(private readonly em: EntityManager) {}

  async execute(input: OpenWalletInput): Promise<Wallet> {
    const money = Money.from(input.initialBalance);
    const wallet = Wallet.open({
      id: crypto.randomUUID(),
      playerId: input.playerId,
      initialBalance: money,
    });

    return this.em.transactional(async (em) => {
      const wallets = new WalletRepository(em);
      const transactions = new WagerTransactionRepository(em);
      const ledger = new LedgerRepository(em);

      await wallets.insert(wallet);
      if (money.isPositive()) {
        const transactionId = crypto.randomUUID();
        const entry = WalletLedgerEntry.create({
          id: crypto.randomUUID(),
          walletId: wallet.id,
          transactionId,
          direction: "CREDIT",
          money,
          balanceBefore: Money.zero(wallet.currency),
          balanceAfter: wallet.balance,
        });
        await transactions.insertOpening(transactionId, wallet);
        await ledger.append(entry, wallet.createdAt);
        const messages = new MessageRepository(em);
        const context = {
          aggregateId: wallet.id,
          correlationId: transactionId,
          occurredAt: wallet.createdAt,
        };
        await messages.enqueue(
          WagerTransactionProcessed.create(
            {
              transactionId,
              walletId: wallet.id,
              kind: "OPENING",
              status: "PROCESSED",
              money: money.toJSON(),
            },
            context,
          ),
        );
        await messages.enqueue(
          WalletBalanceChanged.create(
            {
              transactionId,
              walletId: wallet.id,
              direction: entry.direction,
              money: money.toJSON(),
              balanceBefore: entry.balanceBefore.toJSON(),
              balanceAfter: entry.balanceAfter.toJSON(),
              walletVersion: wallet.version,
            },
            context,
          ),
        );
      }
      return wallet;
    });
  }
}
