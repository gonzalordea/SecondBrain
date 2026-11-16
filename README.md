# SecondBrain

Gestor de conocimiento personal: notas, documentos y tareas conectados por etiquetas, personas y enlaces; búsqueda semántica; un asistente que responde **solo** con tus notas y cita las fuentes; grafo de conocimiento; versiones, papelera, importación/exportación y panel de estadísticas.

- Diseño y decisiones: [docs/DESIGN.md](docs/DESIGN.md)
- API: [docs/API.md](docs/API.md)
- Seguridad (amenazas y pruebas): [docs/SECURITY.md](docs/SECURITY.md)
- Limitaciones y estado de verificación: [docs/LIMITATIONS.md](docs/LIMITATIONS.md)

## Requisitos

- Node.js **24+** (el servidor ejecuta TypeScript directamente con *type stripping*).
- Opcional: Docker (para PostgreSQL + pgvector en producción).
- Opcional: `ANTHROPIC_API_KEY` para el asistente y los resúmenes con IA.

La primera vez se descarga el modelo de embeddings (~120 MB) a `./.models`.

## Desarrollo rápido (sin instalar base de datos)

Sin `DATABASE_URL`, el servidor usa **PGlite**: PostgreSQL real (con pgvector) compilado a WASM, guardado en `./data/pglite`.

```bash
npm install
```

```bash
npm run build
```

```bash
npm start
```

Abre http://localhost:3000 y crea una cuenta. Para desarrollo del frontend con recarga en caliente: `npm start` en una terminal y `npm run dev:web` en otra (http://localhost:5173, con proxy a la API).

Para hacer administrador a un usuario:

```bash
npm run make-admin -- tu@email.com
```

## Producción con Docker

```bash
cp .env.example .env
```

Edita `.env` (como mínimo `POSTGRES_PASSWORD`; `ANTHROPIC_API_KEY` si quieres el asistente) y:

```bash
docker compose up -d --build
```

La imagen descarga el modelo de embeddings durante el *build*, así que el contenedor no necesita salir a Internet para indexar. Pon un proxy con TLS delante (las cookies son `Secure` por defecto en producción) y `TRUST_PROXY=true` si ese proxy añade `X-Forwarded-*`.

## Tests

```bash
npm test
```

Unitarios + integración (66): API real con Fastify `inject`, PostgreSQL real en memoria (PGlite) y el modelo de embeddings real. Incluye la batería de seguridad (`tests/integration/security.test.ts`).

```bash
npm run test:pg
```

Los mismos 66 tests, pero a través del driver de producción (`node-postgres`) hablando el protocolo de PostgreSQL por TCP.

```bash
npx playwright install chromium
```

```bash
npm run test:e2e
```

E2E (6, escritorio y móvil): compila el frontend, arranca el servidor real y lo maneja con Chromium.

```bash
npm run typecheck
```

## Variables de entorno

| Variable | Por defecto | Para qué |
|---|---|---|
| `DATABASE_URL` | — | PostgreSQL con pgvector. Sin ella, PGlite en `PGLITE_DIR`. |
| `PGLITE_DIR` | `./data/pglite` | Carpeta de PGlite (`memory://` = en memoria). |
| `ANTHROPIC_API_KEY` | — | Activa el asistente RAG y los resúmenes con IA. |
| `LLM_MODEL` | `claude-opus-5-5` | Modelo de Claude. |
| `EMBEDDING_MODEL` | `Xenova/paraphrase-multilingual-MiniLM-L12-v2` | Modelo local (384 dim). Cambiarlo exige migrar la dimensión de los vectores. |
| `RAG_MIN_SCORE` / `RAG_TOP_K` | `0.3` / `8` | Umbral de similitud y nº de fragmentos para el asistente. |
| `AUTO_ENRICH` | `true` | Resumen (y, con clave de IA, personas y conceptos) automáticos tras editar. |
| `ENRICH_DELAY_SECONDS` / `ENRICH_MIN_CHARS` | `45` / `300` | Espera sin cambios antes de analizar, y longitud mínima de la nota. |
| `VERSION_COALESCE_SECONDS` | `120` | Autoguardados del mismo autor dentro de esta ventana forman una sola versión. |
| `TRASH_RETENTION_DAYS` | `30` | Purga automática de la papelera. |
| `RATE_LIMIT_MAX` / `AUTH_RATE_LIMIT_MAX` / `AI_RATE_LIMIT_MAX` | `300` / `10` / `20` | Peticiones por minuto e IP (general / auth / IA). |
| `COOKIE_SECURE` | `true` en producción | Cookie de sesión solo por HTTPS. |
| `TRUST_PROXY` | `false` | Confiar en `X-Forwarded-*` (IP real para rate limit, host para CSRF). |
| `SESSION_TTL_DAYS` | `30` | Caducidad de la sesión. |

## Estructura

```
server/          API Fastify (TypeScript sin compilar)
  app.ts         composición: plugins, errores, rutas, tareas de fondo
  auth.ts        registro, login, sesiones, CSRF
  notes.ts       notas, versiones, papelera, enlaces, compartir
  processing.ts  #etiquetas/@personas/[[enlaces]], fragmentado, embeddings, PDF, cola
  search.ts      búsqueda híbrida + notas relacionadas
  assistant.ts   RAG con Claude (citas nativas), conversaciones, resúmenes
  insights.ts    grafo, conexiones ocultas, estadísticas
  io.ts          importación / exportación
  admin.ts       gestión de usuarios
  migrations/    SQL versionado
web/src/         SPA React (vistas en views/)
tests/           unit, integration (incl. seguridad), e2e
```
