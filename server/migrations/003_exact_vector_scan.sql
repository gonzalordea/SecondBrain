-- A global HNSW index is filtered by owner only AFTER the approximate search returns its candidates,
-- so in a multi-user database a user's relevant chunks can be crowded out by other users' chunks and
-- RAG would wrongly answer "no information". Retrieval now does an exact scan over the user's own
-- chunks (chunks_owner_idx), which is correct by construction and fast at personal-library scale.
DROP INDEX IF EXISTS chunks_embedding_idx;
