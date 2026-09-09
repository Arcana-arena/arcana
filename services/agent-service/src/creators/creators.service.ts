import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Creator } from './creator.entity';
import { CreateCreatorDto } from './dto/create-creator.dto';
import { UpdateCreatorDto } from './dto/update-creator.dto';

@Injectable()
export class CreatorsService {
  constructor(
    @InjectRepository(Creator)
    private readonly creators: Repository<Creator>,
  ) {}

  /**
   * Register a creator profile for a wallet that has just proven itself.
   *
   * `wallet` is a parameter, not a body field — see CreateCreatorDto. The row
   * is stamped `origin='siwe'` and `wallet_verified_at=now()`, which is what
   * separates it from the frozen pre-auth rows: every ownership check requires
   * a non-NULL `wallet_verified_at`.
   */
  async create(dto: CreateCreatorDto, wallet: string): Promise<Creator> {
    const address = wallet.toLowerCase();

    const existing = await this.creators.findOne({
      where: { walletAddress: address },
    });
    if (existing) {
      throw new ConflictException(
        `This wallet already has the creator profile '${existing.handle}'.`,
      );
    }

    const creator = this.creators.create({
      handle: dto.handle,
      walletAddress: address,
      walletVerifiedAt: new Date(),
      origin: 'siwe',
    });
    return this.creators.save(creator);
  }

  findAll(): Promise<Creator[]> {
    return this.creators.find({ order: { createdAt: 'DESC' } });
  }

  async findOne(id: string): Promise<Creator> {
    const creator = await this.creators.findOne({ where: { id } });
    if (!creator) {
      throw new NotFoundException(`Creator ${id} not found`);
    }
    return creator;
  }

  /** Rename only. Ownership and moderation are not editable here — see the DTO. */
  async update(id: string, dto: UpdateCreatorDto): Promise<Creator> {
    const creator = await this.findOne(id);
    if (dto.handle !== undefined) creator.handle = dto.handle;
    return this.creators.save(creator);
  }
}
