import { ProviderAuthGuard } from "../../auth/provider-auth.guard";
import { z } from "zod";
import { Money } from "../domain/money";
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Inject,
  Post,
  Get,
  Param,
  ParseUUIDPipe,
  NotFoundException,
  Query,
  HttpCode,
  UseFilters,
  UseGuards,
} from "@nestjs/common";
import { DatabaseService } from "../../database/database.service";
import { OpenWallet } from "../use-cases/open-wallet";
import { UniqueConstraintViolationException } from "@mikro-orm/core";
import { WalletRepository } from "../repositories/wallet.repository";
import { LedgerRepository } from "../repositories/ledger.repository";
import { InvalidLedgerCursor } from "../repositories/ledger-cursor";
import { reconciliationMetrics } from "../../observability/metrics";
import { DatabaseHttpFilter } from "../../database/filters/database-http.filter";
import { logEvent } from "../../observability/logger";

const openWalletSchema = z.object({
  playerId: z.string().uuid(),
  initialBalance: z
    .object({
      amount: z.string(),
      currency: z.literal("BRL"),
    })
    .refine(
      (value) => {
        try {
          Money.from(value);
          return true;
        } catch {
          return false;
        }
      },
      { message: "Invalid monetary amount" },
    ),
});

const ledgerQuerySchema = z
  .object({
    limit: z
      .string()
      .regex(/^[1-9]\d{0,2}$/)
      .transform(Number)
      .refine((limit) => limit <= 100)
      .optional(),
    cursor: z.string().min(1).max(512).optional(),
  })
  .strict();

@Controller("wallets")
@UseFilters(DatabaseHttpFilter)
@UseGuards(ProviderAuthGuard)
export class WalletsController {
  constructor(
    @Inject(DatabaseService)
    private readonly database: DatabaseService,
  ) {}

  @Get(":walletId/ledger")
  async ledger(
    @Param("walletId", new ParseUUIDPipe()) id: string,
    @Query() query: unknown,
  ) {
    const parsed = ledgerQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new BadRequestException({
        code: "INVALID_QUERY",
        message: "Use limit 1..100 and a cursor returned by this endpoint",
      });
    }
    const walletId = id.toLowerCase();
    const em = this.database.createEntityManager();
    const wallet = await new WalletRepository(em).findById(walletId);
    if (!wallet) {
      throw new NotFoundException({ code: "WALLET_NOT_FOUND" });
    }
    const ledger = new LedgerRepository(em);
    const { limit = 50, cursor } = parsed.data;
    try {
      return await ledger.page(walletId, limit, cursor);
    } catch (error) {
      if (error instanceof InvalidLedgerCursor) {
        throw new BadRequestException({ code: "INVALID_CURSOR" });
      }
      throw error;
    }
  }

  @Post(":walletId/reconciliation")
  @HttpCode(200)
  async reconcile(@Param("walletId", new ParseUUIDPipe()) walletId: string) {
    const ledger = new LedgerRepository(this.database.createEntityManager());
    const result = await ledger.reconcile(walletId);
    if (!result) {
      throw new NotFoundException({ code: "WALLET_NOT_FOUND" });
    }
    reconciliationMetrics.record(result.consistent);
    if (!result.consistent) {
      logEvent(
        "reconciliation_divergence",
        {
          walletId: result.walletId,
          transactionId: null,
          messageId: null,
          providerId: null,
          checkedEntries: result.checkedEntries,
        },
        "error",
      );
    }
    return result;
  }

  @Post()
  async open(@Body() body: unknown) {
    const parsed = openWalletSchema.safeParse(body);

    if (!parsed.success) {
      throw new BadRequestException({
        code: "INVALID_PAYLOAD",
        message: "Invalid wallet payload",
      });
    }

    try {
      const em = this.database.createEntityManager();
      const useCase = new OpenWallet(em);
      const wallet = await useCase.execute(parsed.data);

      return {
        id: wallet.id,
        playerId: wallet.playerId,
        balance: wallet.balance,
        version: wallet.version,
      };
    } catch (error) {
      if (error instanceof UniqueConstraintViolationException) {
        throw new ConflictException({
          code: "WALLET_CONFLICT",
          message: "Wallet creation conflicts with an existing record",
        });
      }

      throw error;
    }
  }

  @Get(":walletId")
  async findOne(@Param("walletId", new ParseUUIDPipe()) walletId: string) {
    const em = this.database.createEntityManager();
    const wallet = await new WalletRepository(em).findById(walletId);

    if (!wallet) {
      throw new NotFoundException({
        code: "WALLET_NOT_FOUND",
        message: "Wallet not found",
      });
    }

    return {
      id: wallet.id,
      playerId: wallet.playerId,
      balance: wallet.balance.toJSON(),
      version: wallet.version,
    };
  }
}
