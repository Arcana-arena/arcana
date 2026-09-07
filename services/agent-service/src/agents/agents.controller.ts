import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { AgentsService } from './agents.service';
import { CreateAgentDto } from './dto/create-agent.dto';
import { EvolveAgentDto } from './dto/evolve-agent.dto';
import { UpdateAgentDto } from './dto/update-agent.dto';

@Controller('v1/agents')
export class AgentsController {
  constructor(private readonly agents: AgentsService) {}

  @Post()
  create(@Body() dto: CreateAgentDto) {
    return this.agents.create(dto);
  }

  @Get()
  findAll() {
    return this.agents.findAll();
  }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.agents.findOne(id);
  }

  @Patch(':id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateAgentDto) {
    return this.agents.update(id, dto);
  }

  @Post(':id/activate')
  activate(@Param('id', ParseUUIDPipe) id: string) {
    return this.agents.activate(id);
  }

  @Post(':id/evolve')
  evolve(@Param('id', ParseUUIDPipe) id: string, @Body() dto: EvolveAgentDto) {
    return this.agents.evolve(id, dto);
  }
}
