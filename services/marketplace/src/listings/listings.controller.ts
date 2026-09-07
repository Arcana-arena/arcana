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
}
