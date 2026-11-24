// 모든 요청을 로그인 세션으로 검사 (로그인·가입·관리자 화면과 해당 API만 예외)
import { verifyToken, getCookie, json } from '../functions-lib/auth.js';

const PUBLIC = new Set(['/login', '/login.html', '/admin', '/admin.html', '/api/auth/signup', '/api/auth/login', '/api/auth/logout',
  '/api/admin/users', '/favicon.ico', '/robots.txt']);

export async function onRequest(ctx) {
  const { request, env, next, data } = ctx;
  const url = new URL(request.url);
  if (PUBLIC.has(url.pathname) || request.method === 'OPTIONS') {
    const r = await next();
    const h = new Response(r.body, r);
    h.headers.set('X-Robots-Tag', 'noindex, nofollow');
    return h;
  }
  if (!env.PF_KV) return new Response('로그인 저장소가 설정되지 않았습니다', { status: 503 });
  const u = await verifyToken(env, getCookie(request, 'ad_session'));
  if (u) {
    data.user = u;
    const r = await next();
    const h = new Response(r.body, r);
    h.headers.set('Cache-Control', url.pathname.startsWith('/data/') ? 'private, max-age=300' : 'private, no-cache');
    h.headers.set('X-Robots-Tag', 'noindex, nofollow');
    return h;
  }
  const accept = request.headers.get('Accept') || '';
  const isPage = request.method === 'GET' && (accept.includes('text/html') || url.pathname === '/' || url.pathname.endsWith('.html'));
  if (isPage) return Response.redirect(`${url.origin}/login.html?next=${encodeURIComponent(url.pathname + url.search)}`, 302);
  return json({ error: 'login_required' }, 401);
}
