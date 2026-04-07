import { describe, expect, it } from 'vitest';
import { createTestApp } from '../helpers/test-app.js';

describe('gateway replay store', () => {
  it('returns ordered events since sequence marker', async () => {
    const { context, close } = await createTestApp();

    const firstSeq = context.db
      .prepare('INSERT INTO gateway_events (event_id, type, payload, created_at) VALUES (?, ?, ?, ?)')
      .run('evt_1', 'MESSAGE_CREATE', JSON.stringify({ a: 1 }), new Date().toISOString());

    context.db
      .prepare('INSERT INTO gateway_events (event_id, type, payload, created_at) VALUES (?, ?, ?, ?)')
      .run('evt_2', 'MESSAGE_UPDATE', JSON.stringify({ b: 2 }), new Date().toISOString());

    const events = context.db
      .prepare('SELECT seq, event_id FROM gateway_events WHERE seq > ? ORDER BY seq ASC')
      .all(firstSeq.lastInsertRowid as number) as Array<{ seq: number; event_id: string }>;

    expect(events.length).toBe(1);
    expect(events[0].event_id).toBe('evt_2');

    await close();
  });
});
