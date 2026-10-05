import { BadRequestException, Body, Controller, Delete, Get, Headers, Param, Put, Query, UseGuards } from '@nestjs/common';
import { CurrentWallet, JwtAuthGuard, RateLimit } from '@arcana/auth';
import { ParseUuidAllPipe } from '../common/parse-uuid-all.pipe';
import { VERIFICATION_HEADER, provenanceFrom } from '../common/verification';
import { CreditMarketService } from './credit-market.service';
import { IndicationDto } from './dto/indication.dto';

/**
 * AGENT CREDIT MARKETS, first step (architecture.md §19).
 *
 * The read is public: the agents and their capital records already are, and
 * the interest recorded beside them is a count and a sum with no wallet in it.
 * Writing an indication needs a session and nothing else — a capital provider
 * is a wallet, and is not asked for a creator profile.
 *
 * NO ROUTE HERE MOVES MONEY, and none calls the engine or the signer.
 */
@Controller('v1/credit-market')
export class CreditMarketController {
  constructor(private readonly market: CreditMarketService) {}

  /**
   * 🌐 The market. `provenance=verification` lists the rows a verification run
   * made, which the public page never asks for.
   */
  @Get()
  list(@Query('provenance') provenance?: string) {
    if (provenance !== undefined && provenance !== 'live' && provenance !== 'verification') {
      throw new BadRequestException({
        code: 'invalid_provenance',
        message: `provenance is 'live' or 'verification'. Got '${provenance.slice(0, 20)}'.`,
      });
    }
    return this.market.market(provenance === 'verification' ? 'verification' : 'live');
  }

  /** 🔒 This wallet's own indications. */
  @Get('indications/mine')
  @UseGuards(JwtAuthGuard)
  mine(@CurrentWallet() wallet: string) {
    return this.market.mine(wallet);
  }

  /** 🔒 Record or change what this wallet would supply to one agent. */
  @Put('agents/:id/indication')
  @RateLimit({ limit: 30, windowSeconds: 3600, byWallet: true })
  @UseGuards(JwtAuthGuard)
  indicate(
    @Param('id', ParseUuidAllPipe) id: string,
    @Body() dto: IndicationDto,
    @CurrentWallet() wallet: string,
    @Headers(VERIFICATION_HEADER) verification?: string,
  ) {
    return this.market.indicate(wallet, id, dto, provenanceFrom(verification));
  }

  /** 🔒 Take it back. */
  @Delete('agents/:id/indication')
  @UseGuards(JwtAuthGuard)
  withdraw(@Param('id', ParseUuidAllPipe) id: string, @CurrentWallet() wallet: string) {
    return this.market.withdraw(wallet, id);
  }
}
