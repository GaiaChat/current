import { describe, expect, it } from 'vitest';
import { evaluateAutomod } from '../../apps/server/src/moderation/automod.js';

describe('automod evaluator', () => {
  it('blocks keyword and mention spam', () => {
    const result = evaluateAutomod(
      [
        {
          id: 'rule_1',
          serverId: 'srv',
          name: 'Banned terms',
          type: 'keyword',
          enabled: true,
          payload: {
            keywords: ['forbidden'],
          },
          createdAt: new Date().toISOString(),
        },
      ],
      {
        message: 'this is forbidden <@abc> <@def> <@ghi>',
        mentionCount: 3,
        containsLink: false,
        isMemberTrusted: false,
      },
      {
        maxMentionsPerMessage: 2,
        linkPolicy: 'members_only',
      },
    );

    expect(result.blocked).toBe(true);
    expect(result.reasons.some((reason) => reason.includes('keyword'))).toBe(true);
    expect(result.reasons.some((reason) => reason.includes('mention_spam'))).toBe(true);
  });
});
