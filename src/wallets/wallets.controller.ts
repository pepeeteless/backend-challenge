import { z } from "zod";
import { Money } from "./money";
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Inject,
  Post,
} from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import { OpenWallet } from "./open-wallet";
import { UniqueConstraintViolationException } from "@mikro-orm/core";

const inputSchema = z.object({
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

@Controller("wallets")
export class WalletsController {
  constructor(
    @Inject(DatabaseService)
    private readonly database: DatabaseService,
  ) {}

  @Post()
  async open(@Body() body: unknown) {
    const parsed = inputSchema.safeParse(body);

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
}
