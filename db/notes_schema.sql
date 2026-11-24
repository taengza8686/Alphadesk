-- 07 시황 및 기업펀더멘털 분석: 노트(페이지) 저장소 (Cloudflare D1)
CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
  parent_id TEXT,
  title TEXT NOT NULL DEFAULT '',
  icon TEXT,
  cover TEXT,
  sort REAL NOT NULL DEFAULT 0,
  html TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL DEFAULT '',
  notion_id TEXT,
  notion_edited TEXT,
  source TEXT NOT NULL DEFAULT 'app',
  rev INTEGER NOT NULL DEFAULT 1,
  created_at TEXT,
  updated_at TEXT,
  updated_by TEXT,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_nodes_parent ON nodes(parent_id, sort);
CREATE INDEX IF NOT EXISTS idx_nodes_notion ON nodes(notion_id);
CREATE TABLE IF NOT EXISTS revisions (
  page_id TEXT NOT NULL,
  rev INTEGER NOT NULL,
  title TEXT,
  html TEXT,
  saved_at TEXT,
  saved_by TEXT,
  PRIMARY KEY (page_id, rev)
);
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  mime TEXT,
  name TEXT,
  size INTEGER,
  data BLOB,
  notion_src TEXT,
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
