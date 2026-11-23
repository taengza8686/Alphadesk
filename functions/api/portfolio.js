// AlphaDesk 포트폴리오 서버 저장 (Cloudflare Pages Functions + KV)
// GET  /api/portfolio  → 저장된 포트폴리오
// PUT  /api/portfolio  → 저장 (본문: {holdings:[{ticker, weight}]})
// 인증: 헤더 X-PF-Key = Cloudflare 비밀값 PF_PASSWORD
const ALLOWED = ['https://taengza8686.github.io', 'https://alphadesk-6cv.pages.dev'];

function cors(req) {
  const o = req.headers.get('Origin') || '';
  const ok = ALLOWED.includes(o) || /^https:\/\/[a-z0-9-]+\.alphadesk-6cv\.pages\.dev$/.test(o);
  return {
    'Access-Control-Allow-Origin': ok ? o : ALLOWED[1],
    'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-PF-Key',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}
const json = (req, body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...cors(req) } });

function sameKey(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(request) });
  if (!env.PF_KV || !env.PF_PASSWORD) return json(request, { error: 'not_configured' }, 503);
  if (!sameKey(request.headers.get('X-PF-Key') || '', String(env.PF_PASSWORD).trim())) return json(request, { error: 'unauthorized' }, 401);

  if (request.method === 'GET') {
    const v = await env.PF_KV.get('portfolio', 'json');
    return json(request, v || { holdings: null });
  }
  if (request.method === 'PUT') {
    let body;
    try { body = await request.json(); } catch (e) { return json(request, { error: 'bad_json' }, 400); }
    const list = Array.isArray(body?.holdings) ? body.holdings : null;
    if (!list || list.length > 100) return json(request, { error: 'bad_holdings' }, 400);
    const holdings = [];
    for (const h of list) {
      const t = String(h?.ticker || '').toUpperCase();
      const w = Number(h?.weight);
      if (!/^[A-Z0-9.\-]{1,10}$/.test(t) || !Number.isFinite(w) || w < 0 || w > 100) return json(request, { error: 'bad_item', item: h }, 400);
      holdings.push({ ticker: t, weight: Math.round(w * 100) / 100 });
    }
    const prev = await env.PF_KV.get('portfolio');
    if (prev) await env.PF_KV.put('portfolio_prev', prev);
    const doc = { holdings, savedAt: new Date().toISOString() };
    await env.PF_KV.put('portfolio', JSON.stringify(doc));
    return json(request, { ok: true, ...doc });
  }
  return json(request, { error: 'method_not_allowed' }, 405);
}
