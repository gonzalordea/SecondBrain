# Limitaciones y estado de verificación

## Qué se ha ejecutado de verdad (16/11/2026, Windows 11, Node 24.18)

| Componente | Cómo se verificó | Resultado |
|---|---|---|
| Typecheck de todo el código (servidor, web, tests) | `npm run typecheck` | Sin errores |
| API completa sobre PGlite (Postgres 17 + pgvector en WASM) | `npm test` — 55 tests (unit + integración + seguridad) con el modelo de embeddings real | 55/55 |
| La misma API sobre el **driver de producción** `node-postgres` | `npm run test:pg` — los mismos 55 tests hablando el protocolo de PostgreSQL por TCP (PGlite socket server), pool de 1 conexión | 55/55 |
| Frontend + servidor real en navegador | `npm run test:e2e` — Chromium, escritorio y móvil (Pixel 7) | 5/5 |
| Revisión visual | Navegador integrado: login, editor, búsqueda, grafo, panorama, papelera, móvil 375 px, tema claro/oscuro, sin violaciones de CSP en consola | Correcto tras los arreglos |
| Extracción de PDF | Test con un PDF real generado en el test | Correcto |
| Búsqueda semántica | Consultas sin palabras en común con la nota correcta ("¿qué come mi mascota?" → nota del gato) | Correcto |

## Qué NO se ha podido verificar

- **Llamada real a Claude.** En este entorno no hay `ANTHROPIC_API_KEY`. El flujo RAG completo (recuperación, filtrado por usuario, "no hay información", mapeo de citas a notas, persistencia, SSE) está probado con un doble del LLM **en la frontera de red**; el código que llama al SDK (`anthropicLlm` en `server/assistant.ts`) compila contra los tipos del SDK oficial pero **no se ha ejecutado contra la API**. Riesgos concretos: el parámetro `fallbacks` (beta `server-side-fallback-2026-07-01`) y la forma exacta en que llegan las citas en el stream. Primer paso al tener clave: abrir una conversación y comprobar que aparecen las fuentes.
- **Imagen Docker y `docker compose`.** Docker Desktop está instalado pero su motor no respondió durante la sesión, así que ni el `Dockerfile` ni el `docker-compose.yml` se han construido ni arrancado. El código de base de datos que usaría ese despliegue (driver `pg`) sí está verificado con la prueba anterior, pero contra PGlite por socket, **no** contra la imagen `pgvector/pgvector:pg17`.
- **Calidad de las respuestas del asistente** (que realmente se limite a las notas, que resista inyecciones de prompt dentro de documentos). Depende del modelo; requiere clave y un conjunto de evaluación.
- **Rendimiento a escala.** No hay pruebas de carga. Los tests trabajan con decenas de notas.

## Limitaciones funcionales conocidas

- **Entidades por sintaxis, no por IA.** Personas = `@Nombre` / `@[Nombre Apellido]`; conceptos = `#etiquetas`. No se extraen entidades de texto libre ni de PDFs importados.
- **PDF escaneados** (imagen sin capa de texto) no se pueden importar: no hay OCR.
- **El asistente no ve las notas compartidas contigo**, solo las tuyas (decisión de privacidad).
- **Renombrar una nota** no reescribe los `[[Título antiguo]]` de otras notas; esos enlaces se recalculan cuando se edita la nota que los contiene.
- **Exportación JSON** incluye notas, etiquetas manuales y enlaces manuales; no incluye versiones, conversaciones ni permisos de compartir. La importación JSON crea las notas una a una: si falla a mitad, lo ya importado se queda.
- **Imágenes externas en Markdown no se muestran** (la CSP solo permite imágenes propias o `data:`), a propósito: evita píxeles de seguimiento en notas compartidas.
- **Grafo** limitado a las 500 notas más recientes; el layout se calcula en el navegador.
- **Sin colaboración en tiempo real**: dos editores a la vez reciben un aviso de conflicto (409) y eligen qué versión mantener; no hay fusión automática.
- **Cambiar de modelo de embeddings** exige una migración (la columna es `vector(384)`) y reindexar.
- **Sin verificación de email, recuperación de contraseña ni 2FA.**

## Límites técnicos (marcados con `ponytail:` en el código)

- **Cola de indexado en proceso** (`processing.ts`): una sola cola por servidor; las notas pendientes o fallidas se reencolan al arrancar. Con varias réplicas o mucho volumen, pasar a una tabla de trabajos con workers.
- **Búsqueda vectorial exacta por usuario** (`search.ts`, migración 003): correcta siempre y rápida para bibliotecas personales (miles de fragmentos). Por encima de ~100 000 fragmentos por usuario, usar HNSW con `iterative_scan` de pgvector ≥ 0.8 o particionar por usuario.
- **Vecinos del grafo y "conexiones ocultas"** se calculan en cada petición (O(n·k) sobre ≤ 500 notas). Para más, precalcular en una tabla al indexar.
- **Rate limiting en memoria** del proceso: con varias réplicas, almacén compartido (Redis).
- **Diff de versiones** por LCS de líneas, con tope de tamaño (`text.tsx`).

## Siguientes pasos recomendados

1. Con una `ANTHROPIC_API_KEY`: probar el chat y los resúmenes de punta a punta y ajustar `RAG_MIN_SCORE` con preguntas reales.
2. Con Docker en marcha: `docker compose up --build`, registrar un usuario, importar un PDF y repetir el flujo E2E contra el contenedor.
3. Verificación de email + recuperación de contraseña.
4. Extracción de entidades con el LLM para documentos importados.
