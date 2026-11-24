import { DatabaseSync } from 'node:sqlite';

export function openDatabase(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  runMigrations(db);
  return db;
}

function runMigrations(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key         TEXT PRIMARY KEY,
      value_json  TEXT NOT NULL,
      updated_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tracked_sources (
      id                   TEXT PRIMARY KEY,
      source_type          TEXT NOT NULL CHECK (source_type IN ('channel', 'playlist', 'album')),
      source_key           TEXT NOT NULL UNIQUE,
      title                TEXT NOT NULL,
      url                  TEXT NOT NULL,
      thumbnail_url        TEXT,
      channel_tabs_json    TEXT,
      preset_options_json  TEXT NOT NULL,
      total_synced_count   INTEGER NOT NULL DEFAULT 0,
      last_synced_at       INTEGER,
      created_at           INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS batches (
      id                   TEXT PRIMARY KEY,
      source_type          TEXT NOT NULL CHECK (source_type IN ('single', 'playlist', 'album', 'channel')),
      tracked_source_id    TEXT REFERENCES tracked_sources(id) ON DELETE SET NULL,
      source_url           TEXT NOT NULL,
      title                TEXT NOT NULL,
      output_dir           TEXT NOT NULL,
      options_json         TEXT NOT NULL,
      total_items          INTEGER NOT NULL DEFAULT 0,
      completed_items      INTEGER NOT NULL DEFAULT 0,
      failed_items         INTEGER NOT NULL DEFAULT 0,
      skipped_items        INTEGER NOT NULL DEFAULT 0,
      status               TEXT NOT NULL CHECK (status IN ('queued', 'running', 'paused', 'completed', 'partial', 'cancelled')),
      created_at           INTEGER NOT NULL,
      updated_at           INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS download_tasks (
      id                   TEXT PRIMARY KEY,
      batch_id             TEXT NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
      video_id             TEXT NOT NULL,
      url                  TEXT NOT NULL,
      title                TEXT NOT NULL,
      uploader             TEXT,
      album                TEXT,
      thumbnail_url        TEXT,
      duration_sec         INTEGER,
      playlist_index       INTEGER,
      mode                 TEXT NOT NULL CHECK (mode IN ('video', 'audio')),
      format_spec          TEXT NOT NULL,
      container            TEXT NOT NULL,
      options_json         TEXT NOT NULL,
      status               TEXT NOT NULL CHECK (status IN (
                             'queued', 'downloading', 'merging', 'postprocessing',
                             'paused', 'completed', 'failed', 'cancelled', 'skipped'
                           )),
      phase                TEXT,
      progress_pct         REAL NOT NULL DEFAULT 0,
      speed_bps            INTEGER,
      eta_sec              INTEGER,
      downloaded_bytes     INTEGER NOT NULL DEFAULT 0,
      total_bytes          INTEGER,
      output_path          TEXT,
      error_code           TEXT,
      error_message        TEXT,
      retry_count          INTEGER NOT NULL DEFAULT 0,
      priority             INTEGER NOT NULL DEFAULT 0,
      created_at           INTEGER NOT NULL,
      updated_at           INTEGER NOT NULL,
      completed_at         INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_status_priority
      ON download_tasks(status, priority DESC, created_at ASC);
    CREATE INDEX IF NOT EXISTS idx_tasks_batch_id
      ON download_tasks(batch_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_video_id
      ON download_tasks(video_id);

    CREATE TABLE IF NOT EXISTS downloaded_archive (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      video_id             TEXT NOT NULL,
      mode                 TEXT NOT NULL CHECK (mode IN ('video', 'audio')),
      source_key           TEXT,
      title                TEXT,
      output_path          TEXT,
      file_size_bytes      INTEGER,
      downloaded_at        INTEGER NOT NULL,
      UNIQUE(video_id, mode)
    );

    CREATE INDEX IF NOT EXISTS idx_archive_source_key
      ON downloaded_archive(source_key);
  `);

  // Recover any tasks stuck in active states from an abrupt shutdown
  const now = Date.now();
  db.prepare(
    `UPDATE download_tasks
     SET status = 'paused', phase = NULL, speed_bps = NULL, eta_sec = NULL, updated_at = ?
     WHERE status IN ('downloading', 'merging', 'postprocessing')`
  ).run(now);
}
