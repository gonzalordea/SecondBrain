let csrfToken = '';
let onUnauthorized: (() => void) | undefined;

export const setCsrf = (t: string) => { csrfToken = t; };
export const setUnauthorizedHandler = (fn: () => void) => { onUnauthorized = fn; };

export class ApiError extends Error {
  status: number;
  code: string;
  issues?: { path: string; message: string }[];
  constructor(status: number, code: string, message: string, issues?: { path: string; message: string }[]) {
    super(message);
    this.status = status;
    this.code = code;
    this.issues = issues;
  }
}

type Opts = { method?: string; body?: unknown; signal?: AbortSignal };

export async function api<T = any>(path: string, { method = 'GET', body, signal }: Opts = {}): Promise<T> {
  const headers: Record<string, string> = {};
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined || method !== 'GET') {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body ?? {});
  }
  if (method !== 'GET') headers['x-csrf-token'] = csrfToken;
  let res: Response;
  try {
    res = await fetch(`/api${path}`, { method, headers, body: payload, signal, credentials: 'same-origin' });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new ApiError(0, 'network', 'Sin conexión con el servidor');
  }
  const isJson = res.headers.get('content-type')?.includes('json');
  const data = isJson ? await res.json() : await res.text();
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/auth/')) onUnauthorized?.();
    const err = isJson ? data.error : undefined;
    throw new ApiError(res.status, err?.code ?? 'http', err?.message ?? `Error ${res.status}`, err?.issues);
  }
  return data as T;
}

/** POST that answers with Server-Sent Events; calls onEvent for each event as it arrives. */
export async function streamEvents(path: string, body: unknown, onEvent: (event: string, data: any) => void, signal?: AbortSignal) {
  const res = await fetch(`/api${path}`, {
    method: 'POST', signal, credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken, accept: 'text/event-stream' },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => null);
    throw new ApiError(res.status, data?.error?.code ?? 'http', data?.error?.message ?? `Error ${res.status}`);
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let i: number;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const event = /^event: (.*)$/m.exec(block)?.[1] ?? 'message';
      const data = /^data: (.*)$/m.exec(block)?.[1];
      if (data) onEvent(event, JSON.parse(data));
    }
  }
}

// ---------- Shared types (mirror the API) ----------

export type NoteType = 'note' | 'document' | 'task';
export type TaskStatus = 'todo' | 'doing' | 'done';
export interface User { id: string; email: string; displayName: string; role: 'user' | 'admin'; createdAt: string }
export interface NoteSummary {
  id: string; type: NoteType; title: string; excerpt: string; category: string | null; status: TaskStatus | null;
  dueDate: string | null; version: number; updatedAt: string; createdAt: string; tags: string[]; ownerName: string; embeddingStatus: string;
}
export interface Note {
  id: string; type: NoteType; title: string; content: string; summary: string | null; summaryMethod: 'llm' | 'extractive' | null;
  category: string | null; status: TaskStatus | null; dueDate: string | null; version: number; source: string;
  embeddingStatus: 'pending' | 'ready' | 'failed'; createdAt: string; updatedAt: string; deletedAt: string | null;
  access: 'owner' | 'editor' | 'viewer'; owner: { displayName: string }; tags: string[]; textTags: string[]; people: string[];
  linksOut: { id: string; title: string }[]; linksIn: { id: string; title: string }[];
}
export interface Source { n: number; noteId: string; title: string; quotes: string[] }
export interface ChatMessage { id: string; role: 'user' | 'assistant'; content: string; sources: Source[]; grounded: boolean; createdAt: string }
export interface Facets { tags: { name: string; count: number }[]; categories: { name: string; count: number }[]; people: { name: string; count: number }[] }
