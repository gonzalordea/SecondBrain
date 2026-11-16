import { describe, expect, it } from 'vitest';
import { chunkText, CHUNK_SIZE, meanNormalized, parseContent } from '../../server/processing.ts';
import { attachSources } from '../../server/assistant.ts';
import { hashPassword, verifyPassword } from '../../server/auth.ts';
import { loadConfig } from '../../server/config.ts';

describe('parseContent', () => {
  it('extracts unique tags, people and wikilinks', () => {
    const r = parseContent('#Idea y #idea con @Ana, (@[Juan Gómez]) ver [[Plan A]] y [[plan a|alias]]');
    expect(r).toEqual({ tags: ['Idea'], people: ['Ana', 'Juan Gómez'], links: ['Plan A'] });
  });

  it('ignores headings, emails, URL fragments and code', () => {
    const r = parseContent('# Título\nescribe a ana@example.com o https://x.com/page#sec\n`@decorator` ```\n#include\n@Override\n```');
    expect(r).toEqual({ tags: [], people: [], links: [] });
  });
});

describe('chunkText', () => {
  it('keeps short text as a single chunk', () => {
    expect(chunkText('Hola\n\nmundo')).toEqual(['Hola\n\nmundo']);
    expect(chunkText('   ')).toEqual([]);
  });

  it('never exceeds the model window and loses no text', () => {
    const para = Array.from({ length: 60 }, (_, i) => `Frase número ${i} con algo de contenido.`).join(' ');
    const giant = 'x'.repeat(2000); // one "sentence" with no breaks
    const chunks = chunkText(`${para}\n\n${giant}\n\nfinal`);
    expect(chunks.every((c) => c.length <= CHUNK_SIZE)).toBe(true);
    expect(chunks.join(' ')).toContain('Frase número 59');
    expect(chunks.join('').replace(/[^x]/g, '').length).toBeGreaterThanOrEqual(2000);
    expect(chunks.at(-1)).toContain('final');
  });
});

describe('meanNormalized', () => {
  it('returns a unit vector', () => {
    const v = meanNormalized([[1, 0], [0, 1]]);
    expect(Math.hypot(...v)).toBeCloseTo(1);
    expect(v[0]).toBeCloseTo(v[1]);
  });
});

describe('attachSources', () => {
  const chunks = [{ note_id: 'a', title: 'A' }, { note_id: 'b', title: 'B' }, { note_id: 'a', title: 'A' }];

  it('numbers sources per note and inserts markers where cited', () => {
    const r = attachSources({
      text: 'Uno. Dos.',
      citations: [{ docIndex: 0, citedText: 'x', at: 4 }, { docIndex: 1, citedText: 'y', at: 9 }, { docIndex: 2, citedText: 'z', at: 9 }],
      refused: false,
    }, chunks);
    expect(r.text).toBe('Uno.[1] Dos.[1][2]');
    expect(r.sources).toEqual([
      { n: 1, noteId: 'a', title: 'A', quotes: ['x', 'z'] },
      { n: 2, noteId: 'b', title: 'B', quotes: ['y'] },
    ]);
  });

  it('drops citations that point outside the retrieved documents', () => {
    const r = attachSources({ text: 'Hola', citations: [{ docIndex: 7, citedText: 'q', at: 4 }], refused: false }, chunks);
    expect(r).toEqual({ text: 'Hola', sources: [] });
  });
});

describe('passwords', () => {
  it('hashes with a random salt and verifies', async () => {
    const [a, b] = await Promise.all([hashPassword('secreto largo'), hashPassword('secreto largo')]);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^scrypt\$16384\$8\$1\$/);
    expect(await verifyPassword('secreto largo', a)).toBe(true);
    expect(await verifyPassword('secreto larg0', a)).toBe(false);
    expect(await verifyPassword('x', 'garbage')).toBe(false);
  });
});

describe('config', () => {
  it('defaults to secure cookies in production and validates numbers', () => {
    expect(loadConfig({ NODE_ENV: 'production' }).cookieSecure).toBe(true);
    expect(loadConfig({}).cookieSecure).toBe(false);
    expect(() => loadConfig({ RAG_MIN_SCORE: '5' })).toThrow();
  });
});
