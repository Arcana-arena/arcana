import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';
import { validate as isUuid } from 'uuid';

/**
 * Validates a path param is a well-formed UUID of ANY version.
 * (Nest's ParseUUIDPipe only accepts v3/v4/v5/v7; seed rows use all-zero UUIDs.)
 */
@Injectable()
export class ParseUuidAllPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    if (!isUuid(value)) {
      throw new BadRequestException(`Invalid UUID: ${value}`);
    }
    return value;
  }
}
