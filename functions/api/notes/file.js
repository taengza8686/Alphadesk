// 이미지·첨부 파일 — GET ?id= / POST (본문=파일 바이트, 헤더 X-File-Name, Content-Type)
import { json, needDb, needEditor, now, newId } from '../../../functions-lib/notes.js';
const MAX = 1900000;
const OK = /^(image\/(png|jpe?g|gif|webp|svg\+xml)|application\/pdf)$/;

export async function onRequestGet({ request, env }) {
  const e = needDb(env); if (e) return e;
  const id = new URL(request.url).searchParams.get('id') || '';
  const r = await env.NOTES_DB.prepare('SELECT mime, name, data FROM files WHERE id = ?').bind(id).first();
  if (!r) return new Response('not found', { status: 404 });
  const mime = r.mime || 'application/octet-stream';
  const h = { 'Content-Type': mime, 'Cache-Control': 'private, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' };
  if (mime === 'image/svg+xml') h['Content-Security-Policy'] = "default-src 'none'; style-src 'unsafe-inline'";
  if (mime === 'application/pdf') h['Content-Disposition'] = `inline; filename*=UTF-8''${encodeURIComponent(r.name || 'file.pdf')}`;
  return new Response(new Uint8Array(r.data), { headers: h });
}

export async function onRequestPost({ request, env, data }) {
  const e = needDb(env) || needEditor(data); if (e) return e;
  const mime = (request.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
  if (!OK.test(mime)) return json({ error: 'bad_type', message: '이미지(PNG·JPG·GIF·WEBP) 또는 PDF만 올릴 수 있습니다' }, 400);
  const buf = await request.arrayBuffer();
  if (!buf.byteLength || buf.byteLength > MAX) return json({ error: 'too_large', message: '파일은 약 1.9MB까지 올릴 수 있습니다' }, 413);
  const id = newId();
  const name = decodeURIComponent(request.headers.get('X-File-Name') || 'file').slice(0, 200);
  await env.NOTES_DB.prepare('INSERT INTO files (id, mime, name, size, data, created_at) VALUES (?, ?, ?, ?, ?, ?)').bind(id, mime, name, buf.byteLength, buf, now()).run();
  return json({ ok: true, id, url: '/api/notes/file?id=' + id });
}
