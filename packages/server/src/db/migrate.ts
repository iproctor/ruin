import { pool } from './client.js';

export async function ensureSchema(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        username    TEXT NOT NULL UNIQUE,
        email       TEXT UNIQUE,
        password_hash TEXT,
        created_at  TIMESTAMP NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS games (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        state       JSONB NOT NULL,
        round       INTEGER NOT NULL DEFAULT 0,
        phase       TEXT NOT NULL DEFAULT 'world',
        created_by  UUID NOT NULL REFERENCES users(id),
        created_at  TIMESTAMP NOT NULL DEFAULT now(),
        updated_at  TIMESTAMP NOT NULL DEFAULT now(),
        is_complete BOOLEAN NOT NULL DEFAULT false
      );

      CREATE TABLE IF NOT EXISTS game_players (
        game_id     UUID NOT NULL REFERENCES games(id),
        power       TEXT NOT NULL,
        user_id     UUID REFERENCES users(id),
        player_type TEXT NOT NULL DEFAULT 'human',
        guest_email TEXT,
        PRIMARY KEY (game_id, power)
      );

      CREATE TABLE IF NOT EXISTS invitations (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        game_id     UUID NOT NULL REFERENCES games(id),
        email       TEXT NOT NULL,
        power       TEXT NOT NULL,
        created_at  TIMESTAMP NOT NULL DEFAULT now(),
        accepted    BOOLEAN NOT NULL DEFAULT false
      );

      DROP TABLE IF EXISTS magic_links;
    `);

    // Additive migrations — safe to re-run
    await client.query(`
      ALTER TABLE games ADD COLUMN IF NOT EXISTS event_log JSONB NOT NULL DEFAULT '[]'::jsonb;

      CREATE TABLE IF NOT EXISTS chat_messages (
        id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        game_id    UUID NOT NULL REFERENCES games(id),
        power      TEXT,
        username   TEXT NOT NULL,
        message    TEXT NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS idx_chat_messages_game_id ON chat_messages(game_id, created_at);

      CREATE TABLE IF NOT EXISTS game_events (
        id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        game_id    UUID NOT NULL REFERENCES games(id),
        seq        INTEGER NOT NULL,
        event      JSONB NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS idx_game_events_game_id_seq ON game_events(game_id, seq);
    `);

    // Lobby system migration
    await client.query(`
      ALTER TABLE games ADD COLUMN IF NOT EXISTS name TEXT;
      ALTER TABLE games ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';
      ALTER TABLE games ADD COLUMN IF NOT EXISTS is_public BOOLEAN NOT NULL DEFAULT false;

      UPDATE games SET status = 'complete' WHERE is_complete = true AND status = 'active';

      ALTER TABLE invitations ADD COLUMN IF NOT EXISTS invitation_status TEXT NOT NULL DEFAULT 'pending';
      ALTER TABLE invitations ADD COLUMN IF NOT EXISTS username TEXT;
      ALTER TABLE invitations ALTER COLUMN email DROP NOT NULL;

      CREATE TABLE IF NOT EXISTS lobby_players (
        game_id    UUID NOT NULL REFERENCES games(id),
        user_id    UUID NOT NULL REFERENCES users(id),
        power      TEXT,
        is_creator BOOLEAN NOT NULL DEFAULT false,
        joined_at  TIMESTAMP NOT NULL DEFAULT now(),
        PRIMARY KEY (game_id, user_id)
      );
    `);

    // Joiner can self-pick a power until creator overrides with a lock.
    await client.query(`
      ALTER TABLE lobby_players ADD COLUMN IF NOT EXISTS locked BOOLEAN NOT NULL DEFAULT false;
      ALTER TABLE games ADD COLUMN IF NOT EXISTS ai_slots JSONB NOT NULL DEFAULT '[]'::jsonb;
    `);

    // Global multiplayer lobby chat
    await client.query(`
      CREATE TABLE IF NOT EXISTS lobby_chat_messages (
        id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id    UUID NOT NULL REFERENCES users(id),
        username   TEXT NOT NULL,
        message    TEXT NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS idx_lobby_chat_created_at ON lobby_chat_messages(created_at DESC);
    `);

    console.log('Database schema verified/created.');
  } finally {
    client.release();
  }
}
