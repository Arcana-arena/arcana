import { Body, Controller, Post } from '@nestjs/common';
import { CreateDepositDto, DepositAddressesService } from './deposit-addresses.service';

@Controller('v1/arca')
export class ArcaController {
  constructor(private readonly deposits: DepositAddressesService) {}

  /** Generate a unique HD deposit address for (user, listing). */
  @Post('deposit-address')
  async createDeposit(@Body() dto: CreateDepositDto) {
    const result = await this.deposits.generate(dto.userWallet, dto.listingId);
    return result;
  }
}
