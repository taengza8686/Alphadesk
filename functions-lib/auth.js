// AlphaDesk 로그인 공용 함수 (Cloudflare Pages Functions · Web Crypto)
const enc = new TextEncoder();
export const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const fromB64u = s => { s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; const bin = atob(s); return Uint8Array.from(bin, c => c.charCodeAt(0)); };

export function safeEq(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export async function hashPw(pw, saltB64, iter = 100000) {
  const salt = saltB64 ? fromB64u(saltB64) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, key, 256);
  return { hash: b64u(bits), salt: b64u(salt), iter };
}

let SECRET = null;
async function secret(env) {
  if (SECRET) return SECRET;
  let s = await env.PF_KV.get('cfg:session_secret');
  if (!s) { s = b64u(crypto.getRandomValues(new Uint8Array(32))); await env.PF_KV.put('cfg:session_secret', s); }
  SECRET = s;
  return s;
}
async function hmac(env, data) {
  const k = await crypto.subtle.importKey('raw', enc.encode(await secret(env)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64u(await crypto.subtle.sign('HMAC', k, enc.encode(data)));
}

export const SESSION_DAYS = 30;
export async function makeToken(env, user) {
  const p = b64u(enc.encode(JSON.stringify({ u: user.id, v: user.sv || 1, exp: Date.now() + SESSION_DAYS * 864e5 })));
  return p + '.' + await hmac(env, p);
}

const UCACHE = new Map();
export async function getUser(env, id, fresh = false) {
  const c = UCACHE.get(id);
  if (!fresh && c && Date.now() - c.t < 60000) return c.u;
  const u = await env.PF_KV.get('user:' + id, 'json');
  UCACHE.set(id, { u, t: Date.now() });
  return u;
}
export function bustUser(id) { UCACHE.delete(id); }
export async function putUser(env, u) { await env.PF_KV.put('user:' + u.id, JSON.stringify(u)); bustUser(u.id); }

export async function verifyToken(env, token) {
  if (!token) return null;
  const [p, sig] = token.split('.');
  if (!p || !sig || !safeEq(sig, await hmac(env, p))) return null;
  let o;
  try { o = JSON.parse(new TextDecoder().decode(fromB64u(p))); } catch (e) { return null; }
  if (!o.exp || o.exp < Date.now()) return null;
  const u = await getUser(env, o.u);
  if (!u || u.status !== 'approved' || (u.sv || 1) !== o.v) return null;
  return u;
}

export function getCookie(req, name) {
  const m = (req.headers.get('Cookie') || '').match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  return m ? decodeURIComponent(m[1]) : null;
}
export const sessionCookie = (token, maxAge = SESSION_DAYS * 86400) =>
  `ad_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

export const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers } });

export function isAdmin(req, env) {
  const k = (req.headers.get('X-Admin-Key') || '').trim();
  return !!env.PF_PASSWORD && k.length > 0 && safeEq(k, String(env.PF_PASSWORD).trim());
}

export const clientIp = req => req.headers.get('CF-Connecting-IP') || req.headers.get('X-Forwarded-For') || 'unknown';

// 간단한 시도 횟수 제한 (KV, 창 15분)
export async function rateHit(env, key, limit, ttl = 900) {
  const k = 'rl:' + key;
  const n = parseInt(await env.PF_KV.get(k) || '0', 10);
  if (n >= limit) return false;
  await env.PF_KV.put(k, String(n + 1), { expirationTtl: ttl });
  return true;
}
export async function rateCount(env, key) { return parseInt(await env.PF_KV.get('rl:' + key) || '0', 10); }
export async function rateClear(env, key) { await env.PF_KV.delete('rl:' + key); }
