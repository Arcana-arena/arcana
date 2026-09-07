import {
  ArrayNotEmpty,
  IsArray,
  IsIn,
  IsUUID,
  ArrayUnique,
} from 'class-validator';

export class CreateCompetitionDto {
  @IsUUID('4')
  seasonId: string;

  @IsIn(['ai_vs_ai', 'human_vs_ai', 'challenge'])
  type: string;

  @IsArray()
  @ArrayNotEmpty()
  @ArrayUnique()
  @IsUUID('4', { each: true })
  participantIds: string[];
}
