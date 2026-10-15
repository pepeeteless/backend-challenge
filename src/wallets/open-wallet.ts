import { EntityManager } from "@mikro-orm/postgresql";
import { Money, type MoneyProps } from "./money";
import { Wallet } from "./wallet";
import { WalletLedgerEntry } from "./wallet-ledger-entry";
import { WalletSchema } from "./wallet.schema";

interface OpenWalletInput {
  playerId: string;
  initialBalance: MoneyProps;
}

export class OpenWallet {
  constructor(private readonly em: EntityManager) {}

  async execute(input: OpenWalletInput): Promise<Wallet> {
    // Primeiro construimos os objetos em memoria; isso ainda nao grava no banco.
    const money = Money.from(input.initialBalance);
    const wallet = Wallet.open({
      id: crypto.randomUUID(),
      playerId: input.playerId,
      initialBalance: money,
    });

    // Todas as gravacoes usam este em: sucesso confirma; erro desfaz a transacao.
    return this.em.transactional(async (em) => {
      const record = em.create(WalletSchema, {
        id: wallet.id,
        playerId: wallet.playerId,
        currency: wallet.currency,
        balance: wallet.balance.toJSON().amount,
        version: wallet.version,
        createdAt: wallet.createdAt,
        updatedAt: wallet.updatedAt,
      });

      em.persist(record);
      // Insere a carteira antes das referencias, mas ainda nao faz commit.
      await em.flush();

      if (money.isPositive()) {
        // A abertura ja definiu o saldo e a versao 1; nao devemos creditar novamente.
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

        await em.execute(
          `INSERT INTO wager_transactions (
             id, wallet_id, currency, amount,
             kind, status, created_at, processed_at
           )
           VALUES (?, ?, ?, ?, 'OPENING', 'PROCESSED', ?, ?)`,
          [
            transactionId,
            wallet.id,
            wallet.currency,
            money.toJSON().amount,
            wallet.createdAt,
            wallet.createdAt,
          ],
        );

        await em.execute(
          `INSERT INTO wallet_ledger_entries (
             id, wallet_id, transaction_id, direction, currency,
             amount, balance_before, balance_after, created_at
           )
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            entry.id,
            entry.walletId,
            entry.transactionId,
            entry.direction,
            entry.money.currency,
            entry.money.toJSON().amount,
            entry.balanceBefore.toJSON().amount,
            entry.balanceAfter.toJSON().amount,
            wallet.createdAt,
          ],
        );
      }

      return wallet;
    });
  }
}
