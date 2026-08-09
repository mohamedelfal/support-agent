-- ============================================================
-- قاعدة بيانات الوكيل الذكي
-- ============================================================

-- جدول المحادثات
CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    message TEXT NOT NULL,
    response TEXT NOT NULL,
    created_at TEXT NOT NULL
);

-- مؤشر للبحث السريع
CREATE INDEX IF NOT EXISTS idx_conversations_created ON conversations(created_at);
