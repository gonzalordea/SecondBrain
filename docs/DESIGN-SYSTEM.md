# Sistema de diseño — «Grafito y subrayador»

## Idea

Un segundo cerebro no crea conocimiento: lo **marca**. Lo que leemos, decidimos o recordamos importa porque alguien lo subrayó. La identidad visual de SecondBrain sale de ese gesto: una superficie de **grafito** (el lápiz, la mesa de trabajo) sobre la que solo una cosa brilla, el **subrayador lima**. Si algo está en lima, está marcado: la sección activa, la nota seleccionada, el término encontrado, la acción principal.

Tres reglas que hacen reconocible la interfaz sin ver el nombre:

1. **El lima es escaso y siempre significa "marcado o principal".** Nunca decora. Nada de degradados.
2. **El conocimiento se compone en serif; la herramienta, en sans y mono.** Títulos y lectura de notas en *Newsreader* (tipo de libro); interfaz en *IBM Plex Sans*; todo dato que una máquina cuenta o fecha (contadores, fechas, versiones, atajos, puntuaciones) en *IBM Plex Mono*.
3. **Estructura con reglas, no con tarjetas.** Las zonas se separan con líneas de 1 px y etiquetas en mono, como un cuaderno técnico. Las sombras solo existen en lo que flota (menús, diálogos, avisos).

## Paleta

### Por qué estos colores
- **Grafito ligeramente verdoso** (no negro ni gris azulado): es el tono del lápiz y hace que el lima parezca de la misma familia en lugar de un neón pegado encima. En claro se convierte en un papel frío casi neutro, no blanco puro: menos deslumbrante en lectura larga.
- **Lima `#C6EC4A`**: el color del subrayador fluorescente. Se lee como "atención" sin ser rojo de error ni el azul/violeta de casi todo el software. Sobre él solo va texto grafito (13,5:1).
- **Ion (cian)**: color de apoyo reservado a lo que produce la IA (insignia de resúmenes y conceptos detectados), para separarlo visualmente de lo que el usuario escribió.
- **Semánticos** sobrios y distintos del lima: menta para éxito, ámbar para aviso, bermellón para error.

### Tokens (oscuro / claro)

| Token | Oscuro | Claro | Uso |
|---|---|---|---|
| `--bg-app` | `#0e0f0e` | `#ecece6` | Barra lateral, cromo |
| `--bg-canvas` | `#131412` | `#f7f7f3` | Área de trabajo |
| `--bg-raised` | `#1a1b19` | `#ffffff` | Campos, popovers, diálogos |
| `--bg-hover` / `--bg-active` | `#212320` / `#282a27` | `#e9e9e2` / `#e1e1d9` | Estados |
| `--line` / `--line-strong` | `#242623` / `#33362f` | `#dedfd6` / `#c9cabf` | Reglas y bordes |
| `--text-1/2/3` | `#ecede7` `#b2b4ab` `#8a8d83` | `#171815` `#4a4c44` `#696b62` | Texto, secundario, metadatos |
| `--accent` | `#c6ec4a` | `#c6ec4a` | Relleno principal, marca activa |
| `--accent-text` | `#c6ec4a` | `#4f6b00` | Enlaces y foco sobre el fondo |
| `--mark` | lima 16 % | `#e3f5a6` | Resaltado de búsqueda, selección |
| `--ion` | `#7cc8e8` | `#0b6f8f` | Contenido generado por IA |
| `--success / --warning / --danger` | `#4cc38a` `#e8b23e` `#f2685c` | `#1e7a46` `#8a5b00` `#b42318` | Estados |

Contraste medido (WCAG): todo texto ≥ 4,5:1 sobre las tres superficies en ambos temas (el más justo: `--text-3` claro sobre `--bg-app`, 4,56:1).

**Grafo** (validado con simulación de daltonismo, todos los pares): notas `#3987e5`/`#2a78d6`, conceptos `#7d9c12`/`#6b8c00`, personas `#d55181`/`#c2459b`. Además cada tipo tiene forma propia (círculo, rombo, cuadrado).

## Tipografía

| Rol | Familia | Tamaño / interlineado | Peso |
|---|---|---|---|
| Título de nota | Newsreader | 30 / 1.15 | 500 |
| Lectura de nota | Newsreader | 17 / 1.7 | 400 |
| Título de página | Plex Sans | 18 / 1.3 | 600 |
| Texto de interfaz | Plex Sans | 14 / 1.5 | 400–500 |
| Secundario | Plex Sans | 13 / 1.45 | 400 |
| Etiqueta de sección | Plex Mono | 11 / 1, mayúsculas, +0,06em | 500 |
| Metadatos, contadores | Plex Mono | 11.5–12 | 400 |

No hay titulares gigantes: el título más grande es el de la nota, porque es el contenido.

## Forma

- **Radios**: 3 px (etiquetas, `kbd`), 6 px (botones, campos, menús), 10 px (diálogos). Nada de píldoras salvo indicadores de estado de 6 px.
- **Sombras**: solo `--shadow-pop` en diálogos, paleta de búsqueda, avisos y tooltips.
- **Espaciado**: escala de 4 px (`--s-1` … `--s-8` = 4, 8, 12, 16, 20, 24, 32, 48).
- **Movimiento**: 120 ms para estados, 180 ms para entradas; curva `cubic-bezier(.2,.7,.2,1)`. Con `prefers-reduced-motion` todo es instantáneo.

## Componentes

- **Botón primario**: relleno lima, texto grafito. Uno por zona como máximo.
- **Secundario**: superficie elevada con borde de 1 px.
- **Terciario (ghost)**: solo texto; fondo al pasar el ratón.
- **Peligro**: texto bermellón; relleno solo al confirmar.
- **Estados**: hover = un escalón de fondo; active = otro escalón; focus = anillo de 2 px `--accent-text` con separación de 2 px; disabled = 45 % de opacidad y cursor normal.
- **Campos**: fondo elevado, borde `--line-strong`, foco con borde y anillo `--accent-text`.
- **Marcador activo**: barra lima de 2 px a la izquierda (navegación, fila seleccionada, versión elegida).
- **Etiquetas**: `#nombre` en mono sobre fondo `--bg-hover`, radio 3 px. Personas con `@`. Lo detectado por IA lleva la marca ion.
- **Estados vacíos**: tipográficos (etiqueta mono + una frase + una acción). Sin iconos decorativos.

## Temas

Oscuro, Claro y Sistema. Se elige en Ajustes (o con el botón de la barra lateral, que cicla), se guarda **en la cuenta** (`users.theme`) y se replica en `localStorage` para aplicarlo antes del primer pintado (`/theme-init.js`) y evitar el destello del tema equivocado.
