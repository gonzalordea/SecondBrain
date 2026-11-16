// Downloads the embedding model into MODEL_CACHE_DIR (used at Docker build time so containers start offline).
import { loadConfig } from '../server/config.ts';
import { localEmbedder } from '../server/processing.ts';

const config = loadConfig();
const [v] = await localEmbedder(config.EMBEDDING_MODEL, config.MODEL_CACHE_DIR).embed(['hola']);
console.log(`model ready (${v.length} dims) in ${config.MODEL_CACHE_DIR}`);
