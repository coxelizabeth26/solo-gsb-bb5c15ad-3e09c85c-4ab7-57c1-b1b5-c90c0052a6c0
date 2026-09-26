'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'coordinator.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS devices (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    name      TEXT    NOT NULL,
    frequency REAL    NOT NULL,           -- MHz
    guard     REAL    NOT NULL DEFAULT 0.25, -- 保护间隔 MHz
    locked    INTEGER NOT NULL DEFAULT 0,
    position  INTEGER NOT NULL            -- 录入顺序
  );

  CREATE TABLE IF NOT EXISTS plans (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    name           TEXT NOT NULL,
    params         TEXT NOT NULL,         -- JSON：协调参数（频段/步进/最大偏移/现场占用区间）
    assignments    TEXT NOT NULL,         -- JSON：各频道分配结果
    total_offset   REAL NOT NULL DEFAULT 0, -- 总偏移 MHz
    solved         INTEGER NOT NULL DEFAULT 1,
    created_at     TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
  );
`);

module.exports = db;
