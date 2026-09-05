import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

/** NNTP (usenet) providers configured by the user. */
export const providers = pgTable("providers", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  host: text("host").notNull(),
  port: integer("port").notNull().default(563),
  ssl: boolean("ssl").notNull().default(true),
  username: text("username"),
  password: text("password"),
  connections: integer("connections").notNull().default(8),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * A streaming session = one NZB + the provider used to stream it.
 * The raw NZB XML is persisted so any serverless instance can rebuild the
 * in-memory session (segment map, archive layout) on demand.
 */
export const sessions = pgTable("sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: text("title").notNull(),
  source: text("source").notNull(), // url | upload | indexer | paste
  sourceRef: text("source_ref"),
  providerId: integer("provider_id").references(() => providers.id, { onDelete: "set null" }),
  nzbXml: text("nzb_xml").notNull(),
  itemsJson: text("items_json"), // cached analysis result
  totalBytes: integer("total_bytes"),
  fileCount: integer("file_count").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastPlayedAt: timestamp("last_played_at", { withTimezone: true }),
});

/** Generic key/value settings (e.g. newznab indexer URL + key override). */
export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export type Provider = typeof providers.$inferSelect;
export type NewProvider = typeof providers.$inferInsert;
export type SessionRow = typeof sessions.$inferSelect;
