PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS lessons (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  source_language TEXT NOT NULL DEFAULT 'ar',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS live_sessions (
  id TEXT PRIMARY KEY,
  lesson_id TEXT NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  visitor_id TEXT NOT NULL,
  target_language TEXT NOT NULL,
  assemblyai_session_id TEXT,
  status TEXT NOT NULL DEFAULT 'connecting',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ended_at TEXT
);

CREATE TABLE IF NOT EXISTS transcript_segments (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES live_sessions(id) ON DELETE CASCADE,
  lesson_id TEXT NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  turn_order INTEGER NOT NULL,
  source_language TEXT NOT NULL DEFAULT 'ar',
  text TEXT NOT NULL,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(session_id, turn_order)
);

CREATE TABLE IF NOT EXISTS translations (
  id TEXT PRIMARY KEY,
  segment_id TEXT NOT NULL REFERENCES transcript_segments(id) ON DELETE CASCADE,
  target_language TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(segment_id, target_language)
);

CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  visitor_id TEXT NOT NULL,
  lesson_id TEXT NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  note_date TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'note',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_sessions_lesson ON live_sessions(lesson_id, created_at);
CREATE INDEX IF NOT EXISTS idx_segments_lesson ON transcript_segments(lesson_id, created_at);
CREATE INDEX IF NOT EXISTS idx_translations_segment ON translations(segment_id, target_language);
CREATE INDEX IF NOT EXISTS idx_notes_visitor_lesson ON notes(visitor_id, lesson_id, updated_at);

INSERT OR IGNORE INTO lessons (id, title) VALUES
  ('h1', 'شرح كتاب التوحيد'),
  ('h2', 'تفسير جزء عمّ'),
  ('h3', 'أحكام العمرة للمعتمرين'),
  ('h4', 'حلقة تصحيح التلاوة للكبار'),
  ('h5', 'شرح الأربعين النووية'),
  ('n1', 'شرح صحيح البخاري — كتاب العلم'),
  ('n2', 'دروس في السيرة النبوية'),
  ('n3', 'آداب زيارة المسجد النبوي'),
  ('n4', 'متن الآجرومية في النحو'),
  ('n5', 'فقه الأسرة للنساء');
