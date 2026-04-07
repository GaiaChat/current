import type { DatabaseSync } from 'node:sqlite';

export function runMigrations(db: DatabaseSync): void {
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA foreign_keys=ON;

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS servers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      registration_mode TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      did TEXT NOT NULL UNIQUE,
      handle TEXT NOT NULL,
      display_name TEXT NOT NULL,
      avatar_url TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS user_ip_activity (
      user_id TEXT NOT NULL,
      ip_address TEXT NOT NULL,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      hit_count INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (user_id, ip_address),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS oauth_states (
      state TEXT PRIMARY KEY,
      code_verifier TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS roles (
      id TEXT PRIMARY KEY,
      server_id TEXT NOT NULL,
      name TEXT NOT NULL,
      color TEXT NOT NULL,
      position INTEGER NOT NULL,
      permissions TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (server_id) REFERENCES servers(id)
    );

    CREATE TABLE IF NOT EXISTS user_roles (
      user_id TEXT NOT NULL,
      role_id TEXT NOT NULL,
      PRIMARY KEY (user_id, role_id),
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (role_id) REFERENCES roles(id)
    );

    CREATE TABLE IF NOT EXISTS channels (
      id TEXT PRIMARY KEY,
      server_id TEXT NOT NULL,
      category_id TEXT,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      topic TEXT,
      slowmode_seconds INTEGER NOT NULL DEFAULT 0,
      locked INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY (server_id) REFERENCES servers(id)
    );

    CREATE TABLE IF NOT EXISTS channel_overwrites (
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      allow_permissions TEXT NOT NULL,
      deny_permissions TEXT NOT NULL,
      FOREIGN KEY (channel_id) REFERENCES channels(id)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      author_id TEXT NOT NULL,
      content TEXT NOT NULL,
      parent_message_id TEXT,
      gif_url TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT,
      deleted_at TEXT,
      FOREIGN KEY (channel_id) REFERENCES channels(id),
      FOREIGN KEY (author_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS attachments (
      id TEXT PRIMARY KEY,
      message_id TEXT,
      file_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      byte_size INTEGER NOT NULL,
      path TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (message_id) REFERENCES messages(id)
    );

    CREATE TABLE IF NOT EXISTS reactions (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      emoji TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (message_id) REFERENCES messages(id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS invites (
      code TEXT PRIMARY KEY,
      server_id TEXT NOT NULL,
      channel_id TEXT,
      max_uses INTEGER,
      used_count INTEGER NOT NULL DEFAULT 0,
      expires_at TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      revoked INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (server_id) REFERENCES servers(id),
      FOREIGN KEY (created_by) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS automod_rules (
      id TEXT PRIMARY KEY,
      server_id TEXT NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      enabled INTEGER NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (server_id) REFERENCES servers(id)
    );

    CREATE TABLE IF NOT EXISTS moderation_actions (
      id TEXT PRIMARY KEY,
      server_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      target_user_id TEXT NOT NULL,
      type TEXT NOT NULL,
      reason TEXT,
      expires_at TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (server_id) REFERENCES servers(id)
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      server_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      action TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (server_id) REFERENCES servers(id)
    );

    CREATE TABLE IF NOT EXISTS voice_states (
      user_id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      muted INTEGER NOT NULL DEFAULT 0,
      deafened INTEGER NOT NULL DEFAULT 0,
      push_to_talk INTEGER NOT NULL DEFAULT 0,
      speaking INTEGER NOT NULL DEFAULT 0,
      connected_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (channel_id) REFERENCES channels(id)
    );

    CREATE TABLE IF NOT EXISTS gateway_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_messages_channel_created ON messages(channel_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_gateway_events_seq ON gateway_events(seq);
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_user_ip_address ON user_ip_activity(ip_address, last_seen_at DESC);
  `);
}
