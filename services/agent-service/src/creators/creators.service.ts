import { Injectable, NotFoundException } from '@nestjs/common';
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

  create(dto: CreateCreatorDto): Promise<Creator> {
    const creator = this.creators.create({
      handle: dto.handle,
      walletAddress: dto.walletAddress ?? null,
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

  async update(id: string, dto: UpdateCreatorDto): Promise<Creator> {
    const creator = await this.findOne(id);
    Object.assign(creator, dto);
    return this.creators.save(creator);
  }
}
