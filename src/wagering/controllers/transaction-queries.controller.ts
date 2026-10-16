import { ProviderAuthGuard } from "../../auth/provider-auth.guard";
import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  UseFilters,
  UseGuards,
} from "@nestjs/common";
import { DatabaseService } from "../../database/database.service";
import { WagerTransactionRepository } from "../repositories/wager-transaction.repository";
import type { WagerTransactionRecord } from "../schemas/wager-transaction.schema";
import { DatabaseHttpFilter } from "../../database/filters/database-http.filter";

function toTransactionResponse(record: WagerTransactionRecord | null) {
  if (!record)
    throw new NotFoundException({
      code: "TRANSACTION_NOT_FOUND",
      message: "Transaction not found",
    });
  return {
    transactionId: record.id,
    providerId: record.providerId,
    externalTransactionId: record.externalTransactionId,
    walletId: record.walletId,
    playerId: record.playerId,
    roundId: record.roundId,
    gameId: record.gameId,
    kind: record.kind,
    status: record.status,
    money: { amount: record.amount, currency: record.currency },
    failureCode: record.failureCode,
    referenceTransactionId: record.referenceTransactionId,
    referenceExternalTransactionId: record.referenceExternalTransactionId,
    createdAt: record.createdAt.toISOString(),
    processedAt: record.processedAt?.toISOString() ?? null,
    result: record.response,
  };
}

@Controller()
@UseFilters(DatabaseHttpFilter)
@UseGuards(ProviderAuthGuard)
export class TransactionQueriesController {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}

  @Get("wagering/transactions/:transactionId")
  async byId(@Param("transactionId", new ParseUUIDPipe()) id: string) {
    const transactions = new WagerTransactionRepository(
      this.database.createEntityManager(),
    );
    const transaction = await transactions.findById(id);
    return toTransactionResponse(transaction);
  }

  @Get("providers/:providerId/wagering/transactions/:externalTransactionId")
  async byProvider(
    @Param("providerId") providerId: string,
    @Param("externalTransactionId") externalTransactionId: string,
  ) {
    if (providerId.length > 200 || externalTransactionId.length > 200)
      throw new BadRequestException({ code: "INVALID_QUERY" });
    const transactions = new WagerTransactionRepository(
      this.database.createEntityManager(),
    );
    const transaction = await transactions.findByExternalId(providerId, externalTransactionId);
    return toTransactionResponse(transaction);
  }
}
