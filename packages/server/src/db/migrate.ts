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

      CREATE TABLE IF NOT EXISTS magic_links (
        token       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email       TEXT NOT NULL,
        game_id     UUID,
        expires_at  TIMESTAMP NOT NULL,
        used        BOOLEAN NOT NULL DEFAULT false,
        created_at  TIMESTAMP NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS invitations (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        game_id     UUID NOT NULL REFERENCES games(id),
        email       TEXT NOT NULL,
        power       TEXT NOT NULL,
        created_at  TIMESTAMP NOT NULL DEFAULT now(),
        accepted    BOOLEAN NOT NULL DEFAULT false
      );
    `);
    console.log('Database schema verified/created.');
  } finally {
    client.release();
  }
}
