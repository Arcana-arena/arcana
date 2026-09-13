import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { CurrentWallet, JwtAuthGuard, RateLimit } from '@arcana/auth';
import { IsBoolean } from 'class-validator';
import { DataSource } from 'typeorm';
import { ParseUuidAllPipe } from '../common/parse-uuid-all.pipe';
import { OwnershipService } from '../auth/ownership.service';
import { IntelligenceService } from './intelligence.service';
import { intelligenceBlock } from './intelligence';

/** Making an agent public cannot be undone, so the request has to say it means it. */
export class DiscloseAgentDto {
  @IsBoolean()
  confirm: boolean;
}

function decisionIdOf(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new BadRequestException({
      code: 'invalid_decision_id',
      message: `decisionId must be a positive integer. Got '${raw.slice(0, 20)}'.`,
    });
  }
  return n;
}

/**
 * PRIVATE AGENT. PUBLIC PROOF. — the endpoints that open intelligence, and the
 * public record of every time it was opened.
 *
 * Declared in its own controller rather than inside AgentsController: these are
 * the only routes that change what a private agent reveals, and keeping them in
 * one place keeps them reviewable as a set.
 */
@Controller('v1/agents')
export class IntelligenceController {
  constructor(
    private readonly intelligence: IntelligenceService,
    private readonly ownership: OwnershipService,
    @InjectDataSource() private readonly db: DataSource,
  ) {}

  /**
   * 🌐 Every disclosure this agent's creator has made: who opened what, and when.
   * Public for every agent, because a record of what was opened is part of the
   * record.
   */
  @Get(':id/disclosures')
  disclosures(@Param('id', ParseUuidAllPipe) id: string) {
    return this.intelligence.disclosures(id);
  }

  /**
   * 🔒 The owner's own view of the intelligence a private agent withholds — the
   * mandate and risk rules the dashboard edits. Never public.
   */
  @Get(':id/intelligence')
  @UseGuards(JwtAuthGuard)
  async ownerView(@Param('id', ParseUuidAllPipe) id: string, @CurrentWallet() wallet: string) {
    await this.ownership.assertOwnsAgent(wallet, id);
    const rows = await this.db.query(
      `SELECT a.visibility, a.strategy_type, a.mandate, a.mandate_template, a.mandate_params,
              a.mandate_source, a.risk_profile, d.disclosed_at
         FROM agents a
         LEFT JOIN intelligence_disclosures d ON d.agent_id = a.id AND d.scope = 'agent'
        WHERE a.id = $1`,
      [id],
    );
    if (rows.length === 0) throw new NotFoundException(`Agent ${id} not found`);
    const r = rows[0];
    return {
      agent_id: id,
      intelligence: intelligenceBlock(r.visibility, r.disclosed_at ? new Date(r.disclosed_at).toISOString() : null),
      strategy_type: r.strategy_type ?? null,
      mandate: r.mandate ?? null,
      mandate_template: r.mandate_template ?? null,
      mandate_params: r.mandate_params ?? null,
      mandate_source: r.mandate_source ?? null,
      risk_profile: r.risk_profile ?? null,
      note: 'Only you can read this. For a private agent none of it appears on any public surface.',
    };
  }

  /**
   * 🔒 Make a private agent public — permanently, and on its public record.
   *
   * `confirm: true` is required. There is no way back: the database refuses a
   * public agent becoming private (migration 0047).
   */
  @Post(':id/disclose')
  @HttpCode(200)
  @RateLimit({ limit: 5, windowSeconds: 3600, byWallet: true })
  @UseGuards(JwtAuthGuard)
  async disclose(
    @Param('id', ParseUuidAllPipe) id: string,
    @Body() dto: DiscloseAgentDto,
    @CurrentWallet() wallet: string,
  ) {
    await this.ownership.assertOwnsAgent(wallet, id);
    if (dto.confirm !== true) {
      throw new BadRequestException({
        code: 'confirmation_required',
        message:
          'Making an agent public cannot be undone. Send {"confirm": true} to publish its mandate, risk ' +
          'rules and the evidence behind every decision it has made.',
      });
    }
    return this.intelligence.discloseAgent(id, wallet);
  }

  /**
   * 🔒 Open the intelligence behind one decision of a private agent — its
   * manifest, prompt, raw response, model and thesis — permanently, and on the
   * public record. Anyone can then check it against the commitment written
   * when the decision was made.
   */
  @Post(':id/decisions/:decisionId/reveal')
  @HttpCode(200)
  @RateLimit({ limit: 60, windowSeconds: 3600, byWallet: true })
  @UseGuards(JwtAuthGuard)
  async reveal(
    @Param('id', ParseUuidAllPipe) id: string,
    @Param('decisionId') decisionId: string,
    @CurrentWallet() wallet: string,
  ) {
    await this.ownership.assertOwnsAgent(wallet, id);
    return this.intelligence.revealDecision(id, decisionIdOf(decisionId), wallet);
  }
}
