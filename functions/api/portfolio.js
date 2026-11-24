// 로그인한 사용자별 포트폴리오 저장 (Cloudflare KV · 키: portfolio:<id>)
import { json } from '../../functions-lib/auth.js';

export async function onRequest({ request, env, data }) {
  const u = data.user;
  if (!u) return json({ error: 'login_required' }, 401);
  if (!env.PF_KV) return json({ error: 'not_configured' }, 503);
  const key = 'portfolio:' + u.id;
  if (request.method === 'GET') return json((await env.PF_KV.get(key, 'json')) || { holdings: null });
  if (request.method === 'PUT') {
    let body;
    try { body = await request.json(); } catch (e) { return json({ error: 'bad_json' }, 400); }
    const list = Array.isArray(body?.holdings) ? body.holdings : null;
    if (!list || list.length > 100) return json({ error: 'bad_holdings' }, 400);
    const holdings = [];
    for (const h of list) {
      const t = String(h?.ticker || '').toUpperCase();
      const w = Number(h?.weight);
      if (!/^[A-Z0-9.\-]{1,10}$/.test(t) || !Number.isFinite(w) || w < 0 || w > 100) return json({ error: 'bad_item', item: h }, 400);
      holdings.push({ ticker: t, weight: Math.round(w * 100) / 100 });
    }
    const prev = await env.PF_KV.get(key);
    if (prev) await env.PF_KV.put(key + ':prev', prev);
    const doc = { holdings, savedAt: new Date().toISOString() };
    await env.PF_KV.put(key, JSON.stringify(doc));
    return json({ ok: true, ...doc });
  }
  return json({ error: 'method_not_allowed' }, 405);
}
