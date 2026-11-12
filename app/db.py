"""SQLite 数据层：建表、连接管理、常用查询。"""
import os
import sqlite3
import threading
from contextlib import contextmanager
from datetime import datetime

import config

_init_lock = threading.Lock()
_initialized = False

SCHEMA = """
PRAGMA journal_mode=WAL;

CREATE TABLE IF NOT EXISTS elders (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  display       TEXT,
  age           INTEGER,
  address       TEXT,
  blood_type    TEXT,
  conditions    TEXT,
  allergies     TEXT,
  community     TEXT,
  device_status TEXT DEFAULT 'online',
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  role       TEXT NOT NULL CHECK (role IN ('elder','family','community','admin')),
  name       TEXT NOT NULL,
  phone      TEXT NOT NULL UNIQUE,
  pwd_hash   TEXT NOT NULL,
  pwd_salt   TEXT NOT NULL,
  elder_id   INTEGER REFERENCES elders(id),
  relation   TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS meds (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  elder_id   INTEGER NOT NULL REFERENCES elders(id),
  name       TEXT NOT NULL,
  dose       TEXT,
  time_hhmm  TEXT NOT NULL,
  meal       TEXT,
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_meds_elder ON meds(elder_id, active);

CREATE TABLE IF NOT EXISTS med_logs (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  med_id    INTEGER NOT NULL REFERENCES meds(id),
  elder_id  INTEGER NOT NULL,
  day       TEXT NOT NULL,
  status    TEXT NOT NULL,
  at        TEXT NOT NULL,
  source    TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_medlog_uniq ON med_logs(med_id, day);

CREATE TABLE IF NOT EXISTS vitals (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  elder_id    INTEGER NOT NULL,
  sys         INTEGER NOT NULL,
  dia         INTEGER NOT NULL,
  pulse       INTEGER,
  measured_at TEXT NOT NULL,
  source      TEXT
);
CREATE INDEX IF NOT EXISTS idx_vitals_elder ON vitals(elder_id, measured_at DESC);

CREATE TABLE IF NOT EXISTS alerts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  elder_id      INTEGER NOT NULL,
  level         TEXT NOT NULL,
  title         TEXT NOT NULL,
  detail        TEXT,
  source        TEXT,
  status        TEXT NOT NULL DEFAULT 'pending',
  raised_at     TEXT NOT NULL,
  accepted_at   TEXT,
  arrived_at    TEXT,
  closed_at     TEXT,
  assignee_id   INTEGER,
  assignee_name TEXT,
  escalated     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_alerts_status ON alerts(status, raised_at DESC);

CREATE TABLE IF NOT EXISTS alert_events (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  alert_id INTEGER NOT NULL REFERENCES alerts(id),
  at       TEXT NOT NULL,
  actor    TEXT,
  text     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_alert ON alert_events(alert_id, id);

CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  elder_id   INTEGER NOT NULL,
  from_user  INTEGER,
  from_name  TEXT,
  text       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  read_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_msg_elder ON messages(elder_id, created_at DESC);

CREATE TABLE IF NOT EXISTS consents (
  elder_id     INTEGER PRIMARY KEY REFERENCES elders(id),
  share_health INTEGER NOT NULL DEFAULT 1,
  radar        INTEGER NOT NULL DEFAULT 1,
  location     INTEGER NOT NULL DEFAULT 0,
  updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chats (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  elder_id   INTEGER NOT NULL,
  role       TEXT NOT NULL,
  text       TEXT NOT NULL,
  ai_mode    TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chats_elder ON chats(elder_id, id DESC);

CREATE TABLE IF NOT EXISTS duty_runs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  alert_id   INTEGER NOT NULL,
  mode       TEXT,
  risk       TEXT,
  plan       TEXT,
  actions    TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_duty_alert ON duty_runs(alert_id, id DESC);

CREATE TABLE IF NOT EXISTS symptoms (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  elder_id INTEGER NOT NULL,
  text     TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'normal',
  alert_id INTEGER,
  at       TEXT NOT NULL,
  source   TEXT
);
CREATE INDEX IF NOT EXISTS idx_symptoms_elder ON symptoms(elder_id, at DESC);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS notify_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  alert_id   INTEGER,
  channel    TEXT,
  target     TEXT,
  ok         INTEGER,
  status     TEXT,
  message    TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notify_time ON notify_logs(created_at DESC);

CREATE TABLE IF NOT EXISTS heartbeats (
  elder_id INTEGER PRIMARY KEY,
  last_seen TEXT NOT NULL,
  last_path TEXT,
  ip        TEXT
);

/* 图形验证码：发短信前必须先过人机校验，防短信轰炸 */
CREATE TABLE IF NOT EXISTS captchas (
  token      TEXT PRIMARY KEY,
  answer     TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

/* 短信验证码：只存哈希，一次有效，错 5 次作废 */
CREATE TABLE IF NOT EXISTS sms_codes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  phone      TEXT NOT NULL,
  scene      TEXT NOT NULL,
  code_hash  TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  used_at    TEXT,
  ip         TEXT
);
CREATE INDEX IF NOT EXISTS idx_sms_codes ON sms_codes(phone, scene, id DESC);
CREATE INDEX IF NOT EXISTS idx_sms_codes_ip ON sms_codes(ip, created_at DESC);

/* 每一条下发记录都留痕，配错模板时能立刻看出来 */
CREATE TABLE IF NOT EXISTS sms_sends (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  phone      TEXT,
  scene      TEXT,
  channel    TEXT,
  ok         INTEGER,
  status     TEXT,
  message    TEXT,
  ip         TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sms_send_time ON sms_sends(created_at DESC);

/* 紧急联系人：谁先被联系、谁可以被电话叫醒 */
CREATE TABLE IF NOT EXISTS elder_contacts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  elder_id   INTEGER NOT NULL REFERENCES elders(id),
  name       TEXT NOT NULL,
  relation   TEXT,
  phone      TEXT NOT NULL,
  priority   INTEGER NOT NULL DEFAULT 1,
  can_call   INTEGER NOT NULL DEFAULT 1,
  note       TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_contacts_elder ON elder_contacts(elder_id, priority);

/* 逐级外呼留痕：第几级、打给谁、通没通 */
CREATE TABLE IF NOT EXISTS call_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  alert_id   INTEGER,
  elder_id   INTEGER,
  phone      TEXT,
  name       TEXT,
  stage      INTEGER,
  ok         INTEGER,
  status     TEXT,
  message    TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_call_alert ON call_logs(alert_id, id DESC);

/* 家属绑定码：社区为老人建档后发放，家属凭码绑定，避免随便认领别人的老人 */
CREATE TABLE IF NOT EXISTS bind_codes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  elder_id   INTEGER NOT NULL REFERENCES elders(id),
  code       TEXT NOT NULL,
  role       TEXT,
  expires_at TEXT NOT NULL,
  used_at    TEXT,
  used_by    INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bind_code ON bind_codes(code);
"""

# 老表补列（SQLite 不支持 IF NOT EXISTS 的 ADD COLUMN）
MIGRATIONS = [
    ("elders", "watch", "INTEGER NOT NULL DEFAULT 0"),
    ("elders", "last_seen", "TEXT"),
    ("alerts", "call_stage", "INTEGER NOT NULL DEFAULT 0"),
    ("alerts", "last_call_at", "TEXT"),
    ("users", "verified", "INTEGER NOT NULL DEFAULT 0"),
    ("users", "verified_at", "TEXT"),
]


def now():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def today():
    return datetime.now().strftime("%Y-%m-%d")


def init():
    global _initialized
    if _initialized:
        return
    with _init_lock:
        if _initialized:
            return
        path = config.db_path()
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with sqlite3.connect(path) as conn:
            conn.executescript(SCHEMA)
            conn.commit()
        with sqlite3.connect(path) as conn:
            for table, col, decl in MIGRATIONS:
                cols = [r[1] for r in conn.execute("PRAGMA table_info(%s)" % table)]
                if col not in cols:
                    conn.execute("ALTER TABLE %s ADD COLUMN %s %s" % (table, col, decl))
            conn.commit()
        _initialized = True
        print("[db] 就绪：%s" % path)


@contextmanager
def conn():
    init()
    c = sqlite3.connect(config.db_path(), timeout=15)
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA foreign_keys=ON")
    try:
        yield c
        c.commit()
    except Exception:
        c.rollback()
        raise
    finally:
        c.close()


def q(sql, args=()):
    with conn() as c:
        return [dict(r) for r in c.execute(sql, args).fetchall()]


def q1(sql, args=()):
    with conn() as c:
        r = c.execute(sql, args).fetchone()
        return dict(r) if r else None


def ex(sql, args=()):
    with conn() as c:
        cur = c.execute(sql, args)
        return cur.lastrowid


def setting_get(key, default=None):
    r = q1("SELECT value FROM settings WHERE key=?", (key,))
    return r["value"] if r else default


def setting_set(key, value):
    with conn() as c:
        c.execute(
            "INSERT INTO settings(key, value) VALUES(?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, value),
        )


def has_users():
    r = q1("SELECT COUNT(*) AS n FROM users")
    return bool(r and r["n"] > 0)
