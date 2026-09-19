import { IsOptional, IsString, IsUUID, Length } from 'class-validator';

export class CreateArticleDto {
  @IsString()
  @Length(3, 200)
  title: string;

  @IsString()
  @Length(1, 50000)
  body: string;

  /** Optional. An article without one is ordinary writing, which is fine. */
  @IsOptional()
  @IsUUID('4')
  thesis_id?: string;
}

export class UpdateArticleDto {
  @IsOptional()
  @IsString()
  @Length(3, 200)
  title?: string;

  @IsOptional()
  @IsString()
  @Length(1, 50000)
  body?: string;

  // thesis_id is absent on purpose. The binding is fixed once set, refused by
  // the database (0052) as well as by the absence of a field here: an article
  // re-pointed at a thesis that happened to resolve well would be a forecast
  // claimed after the fact.
}
