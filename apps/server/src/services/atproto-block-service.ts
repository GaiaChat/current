import type { CurrentUser, Message, MessageModeration } from '@current/types';

type AtprotoRelationship = {
  did?: string;
  actor?: string;
  notFound?: boolean;
  blocking?: string;
  blockedBy?: string;
  blockingByList?: string;
  blockedByList?: string;
};

type AtprotoRelationshipsResponse = {
  actor?: string;
  relationships?: AtprotoRelationship[];
};

type MessageBlockState = {
  viewerDid: string;
  authorDid: string;
  viewerBlockedAuthor: boolean;
  authorBlockedViewer: boolean;
  viewerBlockedAuthorByList: boolean;
  authorBlockedViewerByList: boolean;
};

type CachedMessageBlockState = MessageBlockState & {
  expiresAt: number;
};

const ATPROTO_RELATIONSHIPS_ENDPOINT =
  'https://public.api.bsky.app/xrpc/app.bsky.graph.getRelationships';
const RELATIONSHIP_CACHE_TTL_MS = 60_000;
const RELATIONSHIP_FETCH_TIMEOUT_MS = 1_500;
const MAX_RELATIONSHIP_TARGETS_PER_REQUEST = 30;
const MAX_RELATIONSHIP_CACHE_ENTRIES = 10_000;

function isAtprotoDid(did: string | undefined): did is string {
  return Boolean(did && (did.startsWith('did:plc:') || did.startsWith('did:web:')));
}

function normalizeDid(did: string): string {
  return did.trim().toLowerCase();
}

function hasBlockingValue(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

export class AtprotoBlockService {
  private readonly relationshipCache = new Map<string, CachedMessageBlockState>();

  async applyMessageBlocksForViewer(viewer: CurrentUser, message: Message): Promise<Message> {
    const state = await this.getMessageBlockState(viewer, message);
    return this.applyBlockState(message, state);
  }

  async applyMessagesBlocksForViewer(viewer: CurrentUser, messages: Message[]): Promise<Message[]> {
    await this.prefetchMessagesForViewer(viewer, messages);
    return messages.map((message) => this.applyMessageBlocksForViewerSync(viewer, message));
  }

  applyMessageBlocksForViewerSync(viewer: CurrentUser, message: Message): Message {
    return this.applyBlockState(message, this.getCachedMessageBlockState(viewer, message));
  }

  async shouldHideMessageForViewer(viewer: CurrentUser, message: Message): Promise<boolean> {
    const state = await this.getMessageBlockState(viewer, message);
    return Boolean(state && (state.viewerBlockedAuthor || state.authorBlockedViewer));
  }

  shouldHideMessageForViewerSync(viewer: CurrentUser, message: Message): boolean {
    const state = this.getCachedMessageBlockState(viewer, message);
    return Boolean(state && (state.viewerBlockedAuthor || state.authorBlockedViewer));
  }

  async prefetchMessagesForViewer(viewer: CurrentUser, messages: Message[]): Promise<void> {
    const viewerDid = this.normalizeAtprotoDid(viewer.did);
    if (!viewerDid) {
      return;
    }

    const authorDids = new Set<string>();
    for (const message of messages) {
      const authorDid = this.resolveAuthorDid(message);
      if (!authorDid || authorDid === viewerDid || this.getCachedState(viewerDid, authorDid)) {
        continue;
      }
      authorDids.add(authorDid);
    }

    if (authorDids.size === 0) {
      return;
    }

    const relationships = await this.fetchRelationships(viewerDid, [...authorDids]);
    const now = Date.now();
    for (const authorDid of authorDids) {
      const relationship = relationships.get(authorDid);
      this.cacheState(this.stateFromViewerRelationship(viewerDid, authorDid, relationship), now);
    }
  }

  async prefetchMessageForViewers(message: Message, viewers: CurrentUser[]): Promise<void> {
    const authorDid = this.resolveAuthorDid(message);
    if (!authorDid) {
      return;
    }

    const viewerDids = new Set<string>();
    for (const viewer of viewers) {
      const viewerDid = this.normalizeAtprotoDid(viewer.did);
      if (!viewerDid || viewerDid === authorDid || this.getCachedState(viewerDid, authorDid)) {
        continue;
      }
      viewerDids.add(viewerDid);
    }

    if (viewerDids.size === 0) {
      return;
    }

    const relationships = await this.fetchRelationships(authorDid, [...viewerDids]);
    const now = Date.now();
    for (const viewerDid of viewerDids) {
      const relationship = relationships.get(viewerDid);
      this.cacheState(this.stateFromAuthorRelationship(authorDid, viewerDid, relationship), now);
    }
  }

  private async getMessageBlockState(viewer: CurrentUser, message: Message): Promise<MessageBlockState | null> {
    const viewerDid = this.normalizeAtprotoDid(viewer.did);
    const authorDid = this.resolveAuthorDid(message);
    if (!viewerDid || !authorDid || viewerDid === authorDid) {
      return null;
    }

    const cached = this.getCachedState(viewerDid, authorDid);
    if (cached) {
      return cached;
    }

    const relationships = await this.fetchRelationships(viewerDid, [authorDid]);
    const state = this.stateFromViewerRelationship(viewerDid, authorDid, relationships.get(authorDid));
    this.cacheState(state, Date.now());
    return state;
  }

  private getCachedMessageBlockState(viewer: CurrentUser, message: Message): MessageBlockState | null {
    const viewerDid = this.normalizeAtprotoDid(viewer.did);
    const authorDid = this.resolveAuthorDid(message);
    if (!viewerDid || !authorDid || viewerDid === authorDid) {
      return null;
    }

    return this.getCachedState(viewerDid, authorDid);
  }

  private applyBlockState(message: Message, state: MessageBlockState | null): Message {
    if (!state || (!state.viewerBlockedAuthor && !state.authorBlockedViewer)) {
      return message;
    }

    return {
      ...message,
      content: '',
      encryptedContent: undefined,
      gifUrl: undefined,
      attachments: [],
      reactions: [],
      moderation: this.toMessageModeration(state),
    };
  }

  private toMessageModeration(state: MessageBlockState): MessageModeration {
    const viewerBlockedAuthor = state.viewerBlockedAuthor;
    const authorBlockedViewer = state.authorBlockedViewer;
    const reason =
      viewerBlockedAuthor && authorBlockedViewer
        ? 'mutual_block'
        : viewerBlockedAuthor
          ? 'viewer_blocked_author'
          : 'author_blocked_viewer';
    const disclaimer =
      reason === 'mutual_block'
        ? 'This message is hidden because you and this account blocked each other on Bluesky.'
        : reason === 'viewer_blocked_author'
          ? 'This message is hidden because you blocked this account on Bluesky.'
          : 'This message is hidden because this account blocked you on Bluesky.';

    return {
      source: 'atproto',
      hidden: true,
      reason,
      disclaimer,
      viewerBlockedAuthor,
      authorBlockedViewer,
      viewerBlockedAuthorByList: state.viewerBlockedAuthorByList || undefined,
      authorBlockedViewerByList: state.authorBlockedViewerByList || undefined,
    };
  }

  private async fetchRelationships(actorDid: string, targetDids: string[]): Promise<Map<string, AtprotoRelationship>> {
    const relationships = new Map<string, AtprotoRelationship>();
    const uniqueTargetDids = [...new Set(targetDids.map((did) => normalizeDid(did)).filter((did) => did !== actorDid))];

    for (const targetChunk of chunk(uniqueTargetDids, MAX_RELATIONSHIP_TARGETS_PER_REQUEST)) {
      if (targetChunk.length === 0) {
        continue;
      }

      try {
        const url = new URL(ATPROTO_RELATIONSHIPS_ENDPOINT);
        url.searchParams.set('actor', actorDid);
        for (const targetDid of targetChunk) {
          url.searchParams.append('others', targetDid);
        }

        const response = await fetch(url, {
          signal: AbortSignal.timeout(RELATIONSHIP_FETCH_TIMEOUT_MS),
        });
        if (!response.ok) {
          continue;
        }

        const payload = (await response.json()) as AtprotoRelationshipsResponse;
        for (const relationship of payload.relationships ?? []) {
          const did = this.relationshipDid(relationship);
          if (did) {
            relationships.set(did, relationship);
          }
        }
      } catch {
        continue;
      }
    }

    return relationships;
  }

  private relationshipDid(relationship: AtprotoRelationship): string | null {
    const did = relationship.did ?? relationship.actor;
    return isAtprotoDid(did) ? normalizeDid(did) : null;
  }

  private stateFromViewerRelationship(
    viewerDid: string,
    authorDid: string,
    relationship: AtprotoRelationship | undefined,
  ): MessageBlockState {
    return {
      viewerDid,
      authorDid,
      viewerBlockedAuthor:
        hasBlockingValue(relationship?.blocking) || hasBlockingValue(relationship?.blockingByList),
      authorBlockedViewer:
        hasBlockingValue(relationship?.blockedBy) || hasBlockingValue(relationship?.blockedByList),
      viewerBlockedAuthorByList: hasBlockingValue(relationship?.blockingByList),
      authorBlockedViewerByList: hasBlockingValue(relationship?.blockedByList),
    };
  }

  private stateFromAuthorRelationship(
    authorDid: string,
    viewerDid: string,
    relationship: AtprotoRelationship | undefined,
  ): MessageBlockState {
    return {
      viewerDid,
      authorDid,
      viewerBlockedAuthor:
        hasBlockingValue(relationship?.blockedBy) || hasBlockingValue(relationship?.blockedByList),
      authorBlockedViewer:
        hasBlockingValue(relationship?.blocking) || hasBlockingValue(relationship?.blockingByList),
      viewerBlockedAuthorByList: hasBlockingValue(relationship?.blockedByList),
      authorBlockedViewerByList: hasBlockingValue(relationship?.blockingByList),
    };
  }

  private cacheState(state: MessageBlockState, now: number): void {
    if (this.relationshipCache.size > MAX_RELATIONSHIP_CACHE_ENTRIES) {
      for (const [key, cached] of this.relationshipCache) {
        if (cached.expiresAt <= now || this.relationshipCache.size > MAX_RELATIONSHIP_CACHE_ENTRIES) {
          this.relationshipCache.delete(key);
        }
      }
    }

    this.relationshipCache.set(this.cacheKey(state.viewerDid, state.authorDid), {
      ...state,
      expiresAt: now + RELATIONSHIP_CACHE_TTL_MS,
    });
  }

  private getCachedState(viewerDid: string, authorDid: string): MessageBlockState | null {
    const cached = this.relationshipCache.get(this.cacheKey(viewerDid, authorDid));
    if (!cached) {
      return null;
    }

    if (cached.expiresAt <= Date.now()) {
      this.relationshipCache.delete(this.cacheKey(viewerDid, authorDid));
      return null;
    }

    return cached;
  }

  private cacheKey(viewerDid: string, authorDid: string): string {
    return `${viewerDid}\0${authorDid}`;
  }

  private resolveAuthorDid(message: Message): string | null {
    return this.normalizeAtprotoDid(message.author?.did);
  }

  private normalizeAtprotoDid(did: string | undefined): string | null {
    return isAtprotoDid(did) ? normalizeDid(did) : null;
  }
}
