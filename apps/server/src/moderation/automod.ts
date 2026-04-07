import type { AutomodRule } from '@current/types';

export interface AutomodContext {
  message: string;
  mentionCount: number;
  containsLink: boolean;
  isMemberTrusted: boolean;
}

export interface AutomodEvaluation {
  blocked: boolean;
  reasons: string[];
}

export function evaluateAutomod(
  rules: AutomodRule[],
  context: AutomodContext,
  defaults: { maxMentionsPerMessage: number; linkPolicy: 'allow' | 'members_only' | 'deny' },
): AutomodEvaluation {
  const reasons: string[] = [];
  const lower = context.message.toLowerCase();

  if (context.mentionCount > defaults.maxMentionsPerMessage) {
    reasons.push(`mention_spam:${context.mentionCount}`);
  }

  if (defaults.linkPolicy === 'deny' && context.containsLink) {
    reasons.push('link_policy:deny');
  }

  if (defaults.linkPolicy === 'members_only' && context.containsLink && !context.isMemberTrusted) {
    reasons.push('link_policy:members_only');
  }

  for (const rule of rules) {
    if (!rule.enabled) {
      continue;
    }

    if (rule.type === 'keyword') {
      const keywords = (rule.payload.keywords as string[] | undefined) ?? [];
      if (keywords.some((keyword) => lower.includes(keyword.toLowerCase()))) {
        reasons.push(`keyword:${rule.name}`);
      }
      continue;
    }

    if (rule.type === 'regex') {
      const pattern = rule.payload.pattern as string | undefined;
      if (!pattern) {
        continue;
      }
      try {
        const regex = new RegExp(pattern, 'i');
        if (regex.test(context.message)) {
          reasons.push(`regex:${rule.name}`);
        }
      } catch {
        reasons.push(`regex_invalid:${rule.name}`);
      }
      continue;
    }

    if (rule.type === 'mention_spam') {
      const threshold = Number(rule.payload.threshold ?? defaults.maxMentionsPerMessage);
      if (context.mentionCount > threshold) {
        reasons.push(`mention_spam_rule:${rule.name}`);
      }
      continue;
    }

    if (rule.type === 'link_policy') {
      const mode = (rule.payload.mode as 'allow' | 'members_only' | 'deny' | undefined) ?? 'members_only';
      if (mode === 'deny' && context.containsLink) {
        reasons.push(`link_rule:${rule.name}`);
      }
      if (mode === 'members_only' && context.containsLink && !context.isMemberTrusted) {
        reasons.push(`link_rule:${rule.name}`);
      }
    }
  }

  return {
    blocked: reasons.length > 0,
    reasons,
  };
}

export function extractMentionCount(message: string): number {
  return (message.match(/<@[a-zA-Z0-9_:-]+>/g) ?? []).length;
}

export function containsLink(message: string): boolean {
  return /(https?:\/\/|www\.)/i.test(message);
}
