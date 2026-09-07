import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ListingsService } from './listings.service';
import {
  CreateListingDto,
  UpdateListingDto,
} from './dto/listing.dto';
import { ParseUuidAllPipe } from '../common/parse-uuid-all.pipe';
import { IsString, Matches } from 'class-validator';

export class SubscribeDto {
  @IsString()
  @Matches(/^0x[a-fA-F0-9]{40}$/, { message: 'userWallet must be an EVM address' })
  userWallet!: string;
}

@Controller('v1/marketplace')
export class ListingsController {
  constructor(private readonly listings: ListingsService) {}

  @Post('listings')
  create(@Body() dto: CreateListingDto) {
    return this.listings.create(dto);
  }

  @Get('listings')
  findAll() {
    return this.listings.findAll();
  }

  @Get('agents')
  discover(
    @Query('universe') universe?: string,
    @Query('sort') sort?: string,
  ) {
    return this.listings.discover({ universe, sort });
  }

  @Get('listings/:id')
  findOne(@Param('id', ParseUuidAllPipe) id: string) {
    return this.listings.findOne(id);
  }

  @Patch('listings/:id')
  update(
    @Param('id', ParseUuidAllPipe) id: string,
    @Body() dto: UpdateListingDto,
  ) {
    return this.listings.update(id, dto);
  }

  /** Subscribe: generate a deposit address via arca-service (no direct grant). */
  @Post('listings/:id/subscribe')
  subscribe(
    @Param('id', ParseUuidAllPipe) id: string,
    @Body() dto: SubscribeDto,
  ) {
    return this.listings.subscribe(id, dto.userWallet);
  }

  /** Entitlement check: does this user have an active sub for this listing? */
  @Get('listings/:id/access')
  async hasAccess(
    @Param('id', ParseUuidAllPipe) id: string,
    @Query('userWallet') userWallet?: string,
  ) {
    if (!userWallet) {
      return { access: false, reason: 'userWallet query param required' };
    }
    const access = await this.listings.hasAccess(id, userWallet);
    return { access };
  }
}
