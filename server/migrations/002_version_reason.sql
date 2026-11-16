-- History now stores saved states (not "the state before an edit"); the reason tells
-- which entries an editing burst may keep updating (only manual creations and edits).
ALTER TABLE note_versions ADD COLUMN reason text NOT NULL DEFAULT 'edit'
  CHECK (reason IN ('create', 'edit', 'restore', 'import'));

-- Notes created before this migration get their current state as a starting entry.
INSERT INTO note_versions (note_id, version, title, content, edited_by, reason, created_at)
SELECT n.id, n.version, n.title, n.content, n.owner_id, 'edit', n.updated_at
  FROM notes n
 WHERE NOT EXISTS (SELECT 1 FROM note_versions v WHERE v.note_id = n.id AND v.version = n.version);
