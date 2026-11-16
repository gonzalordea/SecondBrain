-- Original files behind imported documents (PDF, Markdown, text), so they can be downloaded again.
-- ponytail: bytes live in Postgres (one volume to back up, works the same on PGlite); move to object storage if files grow past the 10 MB upload cap.
CREATE TABLE note_files (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  note_id    uuid NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  owner_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  filename   text NOT NULL,
  mime       text NOT NULL,
  size       integer NOT NULL CHECK (size >= 0),
  sha256     text NOT NULL,
  data       bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX note_files_note_idx ON note_files (note_id);
