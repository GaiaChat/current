import type { DatabaseSync } from 'node:sqlite';

export abstract class BaseRepository {
  constructor(protected readonly db: DatabaseSync) {}

  protected json<T>(value: string): T {
    return JSON.parse(value) as T;
  }
}
