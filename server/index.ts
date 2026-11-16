import { loadConfig } from './config.ts';
import { buildApp } from './app.ts';

const config = loadConfig();
const { app } = await buildApp(config);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    app.log.info({ sig }, 'shutting down');
    app.close().then(() => process.exit(0), () => process.exit(1));
  });
}

await app.listen({ host: config.HOST, port: config.PORT });
if (!config.ANTHROPIC_API_KEY) app.log.warn('ANTHROPIC_API_KEY not set: the assistant is disabled; summaries fall back to extractive mode');
