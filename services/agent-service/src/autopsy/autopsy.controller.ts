import { Controller, Get, Param } from '@nestjs/common';
import { ParseUuidAllPipe } from '../common/parse-uuid-all.pipe';
import { AutopsyService } from './autopsy.service';

@Controller()
export class AutopsyController {
  constructor(private readonly autopsy: AutopsyService) {}

  /** GET /v1/agents/:id/autopsy — why this agent performed the way it did. */
  @Get('v1/agents/:id/autopsy')
  get(@Param('id', ParseUuidAllPipe) id: string) {
    return this.autopsy.getAutopsy(id);
  }
}
