import { nanoid } from 'nanoid';

export function id(prefix: string): string {
  return `${prefix}_${nanoid(14)}`;
}
