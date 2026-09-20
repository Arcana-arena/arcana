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

  /**
   * Optional, and independent of thesis_id: an article may name one of the
   * author's agents without making any claim about it.
   *
   * SEPARATE FROM THE THESIS BINDING ON PURPOSE. Before 0056 the only way to
   * show an agent beside an article was to publish a forecast about it, which
   * pushed people into inventing claims to get a card — the exact failure 0052
   * avoided by making thesis_id optional in the first place.
   */
  @IsOptional()
  @IsUUID('4')
  agent_id?: string;
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

  /**
   * agent_id IS accepted here, and only ever as a first setting.
   *
   * The difference from thesis_id is deliberate and narrow. NULL -> agent is an
   * author adding context they forgot, which nothing is judged on. agent ->
   * another agent is claiming a track record the article never discussed, and
   * the trigger in 0056 refuses it regardless of what is sent here — this field
   * exists so the forgetful case works, not so the binding is editable.
   */
  @IsOptional()
  @IsUUID('4')
  agent_id?: string;
}
