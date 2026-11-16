CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL,
  password_hash text NOT NULL,
  display_name  text NOT NULL,
  role          text NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  disabled      boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_key ON users (lower(email));

CREATE TABLE sessions (
  token_hash   text PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token   text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

CREATE TABLE notes (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type             text NOT NULL DEFAULT 'note' CHECK (type IN ('note', 'document', 'task')),
  title            text NOT NULL,
  content          text NOT NULL DEFAULT '',
  summary          text,
  summary_method   text CHECK (summary_method IN ('llm', 'extractive')),
  category         text,
  status           text CHECK (status IN ('todo', 'doing', 'done')),
  due_date         date,
  version          integer NOT NULL DEFAULT 1,
  source           text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'import', 'upload')),
  embedding        vector(384),
  embedding_status text NOT NULL DEFAULT 'pending' CHECK (embedding_status IN ('pending', 'ready', 'failed')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz,
  tsv tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(content, '')), 'B')
  ) STORED
);
CREATE INDEX notes_owner_idx ON notes (owner_id, deleted_at, updated_at DESC);
CREATE INDEX notes_tsv_idx ON notes USING gin (tsv);

CREATE TABLE note_versions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  note_id    uuid NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  version    integer NOT NULL,
  title      text NOT NULL,
  content    text NOT NULL,
  edited_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (note_id, version)
);

CREATE TABLE tags (
  id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name     text NOT NULL
);
CREATE UNIQUE INDEX tags_owner_name_key ON tags (owner_id, lower(name));

CREATE TABLE note_tags (
  note_id uuid NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  tag_id  uuid NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  source  text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'text')),
  PRIMARY KEY (note_id, tag_id)
);

CREATE TABLE entities (
  id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind     text NOT NULL CHECK (kind IN ('person')),
  name     text NOT NULL
);
CREATE UNIQUE INDEX entities_owner_kind_name_key ON entities (owner_id, kind, lower(name));

CREATE TABLE note_entities (
  note_id   uuid NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  entity_id uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  PRIMARY KEY (note_id, entity_id)
);

CREATE TABLE note_links (
  source_id  uuid NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  target_id  uuid NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  kind       text NOT NULL CHECK (kind IN ('manual', 'wikilink')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_id, target_id, kind),
  CHECK (source_id <> target_id)
);
CREATE INDEX note_links_target_idx ON note_links (target_id);

CREATE TABLE chunks (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  note_id   uuid NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  owner_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  idx       integer NOT NULL,
  content   text NOT NULL,
  embedding vector(384) NOT NULL
);
CREATE INDEX chunks_note_idx ON chunks (note_id);
CREATE INDEX chunks_owner_idx ON chunks (owner_id);
CREATE INDEX chunks_embedding_idx ON chunks USING hnsw (embedding vector_cosine_ops);

CREATE TABLE note_shares (
  note_id    uuid NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       text NOT NULL CHECK (role IN ('viewer', 'editor')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (note_id, user_id)
);
CREATE INDEX note_shares_user_idx ON note_shares (user_id);

CREATE TABLE conversations (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title      text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX conversations_owner_idx ON conversations (owner_id, updated_at DESC);

CREATE TABLE messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            text NOT NULL CHECK (role IN ('user', 'assistant')),
  content         text NOT NULL,
  citations       jsonb NOT NULL DEFAULT '[]',
  grounded        boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX messages_conv_idx ON messages (conversation_id, created_at);
