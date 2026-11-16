-- Automatic enrichment: a summary plus people and concepts found by the LLM, refreshed after edits settle.
ALTER TABLE entities DROP CONSTRAINT entities_kind_check;
ALTER TABLE entities ADD CONSTRAINT entities_kind_check CHECK (kind IN ('person', 'concept'));

-- 'text' = written as @Name in the note; 'ai' = found by the model. Re-running one never touches the other.
ALTER TABLE note_entities ADD COLUMN source text NOT NULL DEFAULT 'text' CHECK (source IN ('text', 'ai'));

ALTER TABLE notes ADD COLUMN enrich_status text NOT NULL DEFAULT 'none'
  CHECK (enrich_status IN ('none', 'pending', 'done', 'failed'));
ALTER TABLE notes ADD COLUMN enriched_version integer;
