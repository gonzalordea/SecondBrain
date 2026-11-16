import { expect, test, type Page } from '@playwright/test';

const password = 'e2e password long enough';

async function register(page: Page, email: string) {
  await page.goto('/');
  await page.getByRole('tab', { name: 'Crear cuenta' }).click();
  await page.getByLabel('Nombre').fill('E2E');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Contraseña').fill(password);
  await page.locator('form').getByRole('button', { name: 'Crear cuenta' }).click();
  await expect(page.getByRole('heading', { name: 'Todas las notas' })).toBeVisible();
}

async function newNote(page: Page, title: string, body: string) {
  await page.getByRole('button', { name: 'Nueva nota' }).click();
  const titleInput = page.getByLabel('Título');
  await expect(titleInput).toHaveValue('Sin título');
  await titleInput.fill(title);
  await page.getByLabel('Contenido (Markdown)').fill(body);
  await expect(page.locator('.save-badge')).toHaveText('Guardado');
}

test.describe.configure({ mode: 'serial' });

test('full knowledge flow: write, link, search, version, trash, graph, stats', async ({ page }) => {
  await register(page, `flow-${Date.now()}@example.com`);
  await expect(page.getByText('Aquí no hay nada aún')).toBeVisible();

  await newNote(page, 'Proyecto Atlas', 'Objetivos del proyecto: migrar la base de datos. #trabajo');
  await newNote(page, 'Reunión del lunes', 'Hablé con @Marta sobre [[Proyecto Atlas]]. Mi gato Tom come salmón. #trabajo');

  // Autosave survives a reload; parsing produced the tag chip, the person and the wikilink.
  await page.reload();
  await expect(page.getByLabel('Título')).toHaveValue('Reunión del lunes');
  await expect(page.locator('.chip', { hasText: '#trabajo' })).toBeVisible();
  await expect(page.locator('.chip.person', { hasText: '@Marta' })).toBeVisible();
  await page.getByRole('button', { name: 'Leer' }).click();
  await page.locator('.prose a', { hasText: 'Proyecto Atlas' }).click();
  await expect(page.getByLabel('Título')).toHaveValue('Proyecto Atlas');
  await expect(page.locator('.editor-aside').getByRole('link', { name: 'Reunión del lunes', exact: true })).toBeVisible();

  // Semantic search from the palette: the query shares no words with the note.
  await page.keyboard.press('Control+k');
  await page.getByRole('combobox', { name: 'Buscar en tus notas' }).fill('¿qué come mi mascota?');
  await expect(page.locator('#palette-results [role=option]').first()).toContainText('Reunión del lunes');
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('Título')).toHaveValue('Reunión del lunes');

  // Version history (coalescing disabled for this run): restore the state before the last edit.
  await page.getByRole('button', { name: 'Editar' }).click();
  await page.getByLabel('Contenido (Markdown)').fill('Texto completamente nuevo');
  await expect(page.locator('.save-badge')).toHaveText('Guardado');
  await page.getByRole('button', { name: 'Historial de versiones' }).click();
  const dialog = page.getByRole('dialog', { name: 'Historial de versiones' });
  await dialog.locator('.history-list button').nth(1).click();
  await expect(dialog.locator('.diff .add')).toContainText('Texto completamente nuevo');
  await dialog.getByRole('button', { name: /Restaurar v/ }).click();
  await expect(page.getByLabel('Contenido (Markdown)')).toHaveValue(/Mi gato Tom/);

  // Trash with undo, then restore from the trash page.
  await page.getByRole('button', { name: 'Mover a la papelera' }).click();
  await page.getByRole('button', { name: 'Deshacer' }).click();
  await expect(page.getByLabel('Título')).toHaveValue('Reunión del lunes');
  await page.getByRole('button', { name: 'Mover a la papelera' }).click();
  await page.getByRole('link', { name: 'Papelera' }).click();
  await expect(page.getByText('Reunión del lunes')).toBeVisible();
  await page.getByRole('button', { name: 'Restaurar' }).click();
  await expect(page.getByText('La papelera está vacía')).toBeVisible();

  // Graph and stats are built from the same data.
  await page.getByRole('link', { name: 'Grafo' }).click();
  await expect(page.locator('.gnode')).toHaveCount(4); // 2 notes + #trabajo + @Marta
  await page.getByRole('button', { name: 'Ver como lista' }).click();
  await expect(page.getByRole('cell', { name: '#trabajo' })).toBeVisible();
  await page.getByRole('link', { name: 'Panorama' }).click();
  await expect(page.locator('.hero-n').first()).toContainText('2');
});

test('markdown is sanitized: note content cannot run scripts', async ({ page }) => {
  await register(page, `xss-${Date.now()}@example.com`);
  await newNote(page, 'XSS', [
    '<img src=x onerror="window.__xss = 1">',
    '<script>window.__xss = 2</script>',
    '[clic](javascript:window.__xss=3)',
    '<a href="https://example.com">externo</a>',
  ].join('\n\n'));
  await page.getByRole('button', { name: 'Leer' }).click();
  const prose = page.locator('.prose');
  await expect(prose.getByRole('link', { name: 'externo' })).toHaveAttribute('rel', /noopener/);
  await prose.getByText('clic').click().catch(() => {});
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => (window as any).__xss)).toBeUndefined();
  expect(await prose.locator('script').count()).toBe(0);
  expect(await prose.locator('[onerror]').count()).toBe(0);
  expect(await prose.locator('a[href^="javascript:" i]').count()).toBe(0);
});

test('import a markdown file and open it as a document', async ({ page }) => {
  await register(page, `import-${Date.now()}@example.com`);
  await page.goto('/#/settings');
  await page.locator('input[type=file]').setInputFiles({
    name: 'apuntes.md', mimeType: 'text/markdown',
    buffer: Buffer.from('# Apuntes de Rust\n\nEl borrow checker evita carreras de datos. #rust'),
  });
  await expect(page.getByText('1 elemento importado')).toBeVisible();
  await page.getByRole('link', { name: 'Apuntes de Rust' }).click();
  await expect(page.getByLabel('Título')).toHaveValue('Apuntes de Rust');
  await expect(page.locator('.meta-field select').first()).toHaveValue('document');
});

test('assistant explains it is not configured; logout ends the session', async ({ page }) => {
  await register(page, `ask-${Date.now()}@example.com`);
  await page.getByRole('link', { name: 'Preguntar' }).click();
  await expect(page.getByText(/Asistente desactivado/)).toBeVisible();
  await page.getByRole('button', { name: 'Cerrar sesión' }).click();
  await expect(page.getByRole('tab', { name: 'Entrar' })).toBeVisible();
  await page.goto('/#/notes');
  await page.reload();
  await expect(page.getByRole('tab', { name: 'Entrar' })).toBeVisible();
});

test('phone layout: drawer navigation, list ↔ editor, no horizontal scroll @mobile', async ({ page }) => {
  await register(page, `mobile-${Date.now()}@example.com`);
  await page.getByRole('button', { name: 'Abrir menú' }).click();
  await page.getByRole('button', { name: 'Nueva nota' }).click();
  await page.getByLabel('Título').fill('Nota móvil');
  await expect(page.locator('.save-badge')).toHaveText('Guardado');
  await page.getByRole('link', { name: 'Volver a la lista' }).click();
  await expect(page.getByText('Nota móvil')).toBeVisible();
  for (const route of ['#/notes', '#/search?q=nota', '#/insights', '#/graph', '#/trash', '#/settings', '#/ask']) {
    await page.goto(`/${route}`);
    await page.waitForTimeout(500);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, route).toBeLessThanOrEqual(0);
  }
});
