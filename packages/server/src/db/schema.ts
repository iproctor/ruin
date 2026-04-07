import {
  pgTable,
  uuid,
  text,
  boolean,
  timestamp,
  integer,
  jsonb,
} from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  username: text('username').unique().notNull(),
  email: text('email').unique(),
  passwordHash: text('password_hash'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const games = pgTable('games', {
  id: uuid('id').primaryKey().defaultRandom(),
  state: jsonb('state').notNull(),
  eventLog: jsonb('event_log').notNull().default([]),
  round: integer('round').notNull().default(0),
  phase: text('phase').notNull().default('world'),
  createdBy: uuid('created_by')
    .notNull()
    .references(() => users.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
  isComplete: boolean('is_complete').notNull().default(false),
});

export const gamePlayers = pgTable('game_players', {
  gameId: uuid('game_id')
    .notNull()
    .references(() => games.id),
  power: text('power').notNull(), // 'xarm'|'gormen'|'tenzen'|'lasha'
  userId: uuid('user_id').references(() => users.id),
  playerType: text('player_type').notNull().default('human'), // 'human'|'ai'|'guest'
  guestEmail: text('guest_email'),
});

export const magicLinks = pgTable('magic_links', {
  token: uuid('token').primaryKey().defaultRandom(),
  email: text('email').notNull(),
  gameId: uuid('game_id'),
  expiresAt: timestamp('expires_at').notNull(),
  used: boolean('used').notNull().default(false),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const invitations = pgTable('invitations', {
  id: uuid('id').primaryKey().defaultRandom(),
  gameId: uuid('game_id')
    .notNull()
    .references(() => games.id),
  email: text('email').notNull(),
  power: text('power').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  accepted: boolean('accepted').notNull().default(false),
});

export const chatMessages = pgTable('chat_messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  gameId: uuid('game_id').notNull().references(() => games.id),
  power: text('power'),          // null = spectator/system
  username: text('username').notNull(),
  message: text('message').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});
