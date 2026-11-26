// 07 분기 실적: 컨퍼런스콜 AI 정리 — POST {id}
// 이번 분기와 직전 최대 3개 분기 페이지의 컨퍼런스콜 노트(태헌님이 정리한 글)만 읽어서 Gemini로 정리한다.
import { json, needDb, needEditor, body, stripText } from '../../../functions-lib/notes.js';

function qKey(title) {
  const t = String(title || '');
  let m = t.match(/((?:19|20)\d{2})\s*[-.]?\s*([1-4])\s*Q/i) || t.match(/((?:19|20)\d{2})\s*[-.]?\s*Q\s*([1-4])/i);
  if (m) return +m[1] * 4 + (+m[2] - 1);
  m = t.match(/\b([1-4])\s*Q\s*(?:FY)?\s*'?(\d{2,4})\b/i) || t.match(/\bQ([1-4])\s*(?:FY)?\s*'?(\d{2,4})\b/i);
  if (m) { let y = +m[2]; if (y < 100) y += 2000; return y * 4 + (+m[1] - 1); }
  return null;
}
const qLabel = k => `${Math.floor(k / 4)} ${k % 4 + 1}Q`;

// 페이지 글에서 컨퍼런스콜 부분만 (없으면 실적 숫자 뒤쪽 서술 부분)
function callText(html) {
  let t = stripText(html);
  const cut = t.search(/\[컨퍼런스 콜 최근 트렌드\]|\[이번 분기 컨콜 전분기 대비 변화\]/);   // 예전에 넣은 AI 정리는 빼고
  if (cut >= 0) t = t.slice(0, cut);
  const i = t.search(/conference\s*call|컨퍼런스\s*콜|컨콜|earnings\s*call|Q&A/i);
  if (i >= 0) t = t.slice(i);
  return t.replace(/\n{2,}/g, '\n').slice(0, 14000);
}

async function gemini(key, prompt) {
  const models = ['gemini-flash-latest', 'gemini-flash-lite-latest'];
  let last = '';
  for (const model of models) {
    for (let a = 0; a < 3; a++) {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: 'application/json', temperature: 0.2 } }),
      });
      if ([429, 500, 502, 503, 504].includes(r.status)) { last = `${model} ${r.status}`; await new Promise(res => setTimeout(res, [3000, 8000, 15000][a])); continue; }
      if (!r.ok) { last = `${model} ${r.status}`; break; }
      const j = await r.json();
      const txt = j?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      try { return { model, data: JSON.parse(txt) }; } catch (e) { last = `${model} 응답 형식 오류`; break; }
    }
  }
  throw new Error('Gemini 응답 실패: ' + last);
}

export async function onRequestPost({ request, env, data }) {
  const e = needDb(env) || needEditor(data); if (e) return e;
  if (!env.GEMINI_API_KEY) return json({ error: 'no_key', message: 'Gemini 키가 아직 서버에 설정되지 않았습니다(다음 배포 후 사용 가능)' }, 503);
  const b = await body(request); if (!b?.id) return json({ error: 'bad_request' }, 400);
  const db = env.NOTES_DB;
  const cur = await db.prepare('SELECT id, parent_id, title, html FROM nodes WHERE id = ?').bind(b.id).first();
  if (!cur) return json({ error: 'not_found' }, 404);
  const k = qKey(cur.title);
  if (k == null) return json({ error: 'no_quarter', message: '페이지 제목에서 분기(예: 2027 3Q)를 찾지 못했습니다' }, 400);
  const company = await db.prepare('SELECT p.title AS t FROM nodes e JOIN nodes p ON p.id = e.parent_id WHERE e.id = ?').bind(cur.parent_id).first();
  const { results: sibs } = await db.prepare('SELECT id, title, html FROM nodes WHERE parent_id = ? AND deleted_at IS NULL').bind(cur.parent_id).all();
  const qs = sibs.map(s => ({ ...s, k: s.id === cur.id ? k : qKey(s.title) }))
    .filter(s => s.k != null && s.k <= k && s.k >= k - 3)
    .map(s => (s.id === cur.id ? { ...s, html: b.html || s.html } : s))   // 이번 분기는 화면의 최신 내용
    .sort((x, y) => y.k - x.k);
  const notes = qs.map(s => ({ q: qLabel(s.k), text: callText(s.html) })).filter(n => n.text.length > 80);
  if (!notes.length || notes[0].q !== qLabel(k)) return json({ error: 'no_call', message: '이번 분기 페이지에서 컨퍼런스콜 내용을 찾지 못했습니다(“Conference Call” 또는 “컨퍼런스 콜” 아래에 적어 주세요)' }, 400);
  const prompt = `당신은 미국 주식 애널리스트를 돕는 도우미입니다. 아래는 ${company?.t || '이 기업'}의 분기별 컨퍼런스콜 정리 노트입니다(사용자가 직접 정리한 글).
규칙:
- 아래 노트에 적힌 내용만 근거로 쓰고, 노트에 없는 사실·숫자·전망을 지어내지 마세요. 숫자는 노트 표기를 그대로 옮기세요.
- 한국어, 짧은 개조식 문장. 기업명·제품명·티커는 원문 표기 유지.
- 노트가 ${notes.length}개 분기뿐이면 그 범위 안에서만 정리하세요.
JSON으로만 답하세요:
{"trend":[{"topic":"주제","points":["최근 분기들에 걸친 흐름 1~3개"]}],
 "change":[{"topic":"주제","direction":"개선|악화|유지|신규|축소 중 하나","before":"직전 분기 노트 요약(없으면 빈 문자열)","now":"이번 분기 노트 요약"}],
 "note":"근거가 부족하거나 확신이 낮은 부분(없으면 빈 문자열)"}
topic은 가능하면 다음 순서·이름을 쓰고 노트에 내용이 없는 주제는 빼세요: 수요·업황, 가이던스·전망, 제품·기술·고객, 마진·비용, 자본 배분·재무, 리스크·불확실성.
"trend"는 ${notes.map(n => n.q).join(', ')} 전체에 걸친 흐름, "change"는 ${notes[0].q} 와 ${notes[1]?.q || '(직전 분기 노트 없음)'} 의 차이입니다.
노트:
${notes.map(n => `=== ${n.q} ===\n${n.text}`).join('\n\n')}`;
  try {
    const g = await gemini(env.GEMINI_API_KEY, prompt);
    return json({ ok: true, model: g.model, quarters: notes.map(n => n.q), ...g.data });
  } catch (err) {
    return json({ error: 'ai_failed', message: String(err.message || err) }, 502);
  }
}
