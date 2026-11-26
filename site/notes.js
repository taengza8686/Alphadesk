// 07 시황 및 기업펀더멘털 분석 — Notion에서 옮긴 노트를 보고·쓰고·고치는 화면
// (index.html 의 전역 함수 $, esc, isNum, benchmarkData, MACRO 등을 함께 사용)
const NT = {
  nodes: new Map(), kids: new Map(), loaded: false, loading: null, canEdit: false, error: '',
  open: new Set(), sel: { market: null, company: null }, coTab: {}, ed: null, cur: null, saveT: null, titleT: null,
  pending: null, filter: '', tblSector: null, tblCache: new Map(), coCache: new Map(),
};
const NT_RE_TICKER = /\(([A-Z0-9][A-Z0-9.\-]{0,9})(?:\s+(?:US|UN|UW|UQ|LN|JP|KS|HK))?\)\s*$/;

async function ntApi(path, opt = {}) {
  const r = await fetch('/api/notes/' + path, { cache: 'no-store', headers: opt.body && typeof opt.body === 'string' ? { 'Content-Type': 'application/json' } : (opt.headers || {}), ...opt });
  if (r.status === 401) { location.replace('/login.html?next=' + encodeURIComponent(location.pathname + location.hash)); throw new Error('로그인이 필요합니다'); }
  let j = null; try { j = await r.json(); } catch (e) {}
  if (!r.ok) { const err = new Error(j?.message || j?.error || ('HTTP ' + r.status)); err.status = r.status; err.data = j; throw err; }
  return j;
}
const ntPost = (path, obj) => ntApi(path, { method: 'POST', body: JSON.stringify(obj) });

// ------------------------------------------------------------------ 트리
async function ntLoadTree(force) {
  if (NT.loaded && !force) return;
  if (NT.loading) return NT.loading;
  NT.loading = (async () => {
    try {
      const j = await ntApi('tree');
      NT.canEdit = !!j.canEdit; NT.error = '';
      NT.nodes = new Map(j.nodes.map(n => [n.id, n]));
      ntIndex(); NT.loaded = true;
    } catch (e) { NT.error = e.status === 503 ? '노트 저장소가 아직 연결되지 않았습니다. 다음 자동 배포 후 사용할 수 있습니다.' : ('노트를 불러오지 못했습니다: ' + e.message); }
    finally { NT.loading = null; }
  })();
  return NT.loading;
}
function ntIndex() {
  NT.kids = new Map();
  for (const n of NT.nodes.values()) {
    const p = n.parent_id && NT.nodes.has(n.parent_id) ? n.parent_id : '';
    if (!NT.kids.has(p)) NT.kids.set(p, []);
    NT.kids.get(p).push(n);
  }
  const byTitle = (x, y) => String(x.title || '').localeCompare(String(y.title || ''), 'en', { sensitivity: 'base', numeric: true });
  for (const a of NT.kids.values()) {
    // 기업 목록(제목에 "(티커 US)"가 있는 페이지가 대부분인 폴더)은 항상 알파벳순 — 새 기업을 추가해도 제자리에 들어감
    const companies = a.filter(n => NT_RE_TICKER.test(n.title || '')).length;
    if (companies && companies >= a.length / 2) a.sort((x, y) => (NT_RE_TICKER.test(y.title || '') - NT_RE_TICKER.test(x.title || '')) || byTitle(x, y));
    else a.sort((x, y) => (x.sort - y.sort) || byTitle(x, y));
  }
}
const ntKids = id => NT.kids.get(id || '') || [];
const ntNode = id => NT.nodes.get(id);
function ntPath(id) { const out = []; let n = ntNode(id), g = 0; while (n && g++ < 40) { out.unshift(n); n = ntNode(n.parent_id); } return out; }
const ntRootBy = re => ntKids('').find(n => re.test(n.title || ''));
const ntMrRoot = () => ntRootBy(/market\s*review|시황/i);
const ntCoRoot = () => ntRootBy(/기업\s*분석|company/i);
const ntChild = (id, re) => ntKids(id).find(n => re.test(n.title || ''));
const ntTicker = n => (n?.title || '').match(NT_RE_TICKER)?.[1] || '';
const ntIsCompany = n => !!n && !!ntTicker(n) && ntPath(n.id).some(p => p.id === ntCoRoot()?.id);
const ntCompanyOf = id => ntPath(id).reverse().find(ntIsCompany);
function ntScopeOf(id) { const p = ntPath(id); if (p[0] && p[0].id === ntMrRoot()?.id) return 'market'; if (p[0] && p[0].id === ntCoRoot()?.id) return 'company'; return 'market'; }
function ntQKey(title) {
  const t = String(title || '');
  let m = t.match(/((?:19|20)\d{2})\s*[-.]?\s*([1-4])\s*Q/i) || t.match(/((?:19|20)\d{2})\s*[-.]?\s*Q\s*([1-4])/i);
  if (m) return +m[1] * 4 + (+m[2] - 1);
  m = t.match(/\b([1-4])\s*Q\s*(?:FY)?\s*'?(\d{2,4})\b/i) || t.match(/\bQ([1-4])\s*(?:FY)?\s*'?(\d{2,4})\b/i);
  if (m) { let y = +m[2]; if (y < 100) y += 2000; return y * 4 + (+m[1] - 1); }
  return null;
}
const ntQLabel = k => k == null ? '-' : `${Math.floor(k / 4)} ${k % 4 + 1}Q`;
function ntTags(title) {
  const m = String(title || '').match(/\(([^()]*)\)\s*$/);
  if (!m) return '';
  return m[1].split(/[;,/]/).map(s => s.trim()).filter(Boolean).map(s => `<span class="nt-tag ${/beat|상회/i.test(s) ? 'beat' : /miss|하회/i.test(s) ? 'miss' : 'inline'}">${esc(s)}</span>`).join(' ');
}
const ntShortTitle = t => String(t || '').replace(/\s*\([^()]*\)\s*$/, '');
const ntFmtDate = s => s ? String(s).slice(0, 16).replace('T', ' ') : '';

// ------------------------------------------------------------------ 화면 진입점
async function renderNotes(sub) {
  const host = $('nt-' + sub);
  if (!host) return;
  if (!NT.loaded) { host.innerHTML = '<div class="py-16 text-center text-slate-500 text-sm">노트 불러오는 중…</div>'; await ntLoadTree(); }
  if (NT.error) { host.innerHTML = `<div class="bg-terminal-panel border border-terminal-border rounded-2xl p-8 text-center text-sm text-slate-400">${esc(NT.error)}</div>`; return; }
  if (!ntMrRoot() && !ntCoRoot()) return ntRenderEmpty(host);
  if (NT.pending && NT.pending.sub === sub) { const id = NT.pending.id; NT.pending = null; if (ntNode(id)) NT.sel[sub] = id; }
  if (sub === 'overview') return ntRenderOverview(host);
  if (sub === 'market' || sub === 'company') return ntRenderSplit(sub);
  if (sub === 'table') return ntRenderSectorTable(host);
}
function ntRenderEmpty(host) {
  host.innerHTML = `<div class="bg-terminal-panel border border-terminal-border rounded-2xl p-8 text-center space-y-3">
    <div class="text-white font-bold">아직 옮겨온 노트가 없습니다</div>
    <p class="text-sm text-slate-400">Notion 이관이 끝나면 Market Review와 기업 분석이 자동으로 나타납니다.<br>Notion 없이 새로 시작하려면 기본 폴더를 만들 수 있습니다.</p>
    ${NT.canEdit ? `<button onclick="ntCreateDefaults()" class="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold">기본 폴더 만들기 (Market Review · 기업 분석 · GICS 11개 섹터)</button>` : '<p class="text-xs text-slate-500">편집 권한이 있는 관리자만 만들 수 있습니다.</p>'}</div>`;
}
async function ntCreateDefaults() {
  const mr = await ntPost('node', { op: 'create', parent_id: null, title: 'Market Review', icon: '📰' });
  const co = await ntPost('node', { op: 'create', parent_id: null, title: '기업 분석', icon: '🏢' });
  for (const s of ['Information Technologies', 'Communication Services', 'Consumer Discretionary', 'Consumer Staples', 'Energy', 'Financials', 'Healthcare', 'Industrials', 'Materials', 'Real Estate', 'Utilities'])
    await ntPost('node', { op: 'create', parent_id: co.id, title: s });
  await ntPost('node', { op: 'create', parent_id: mr.id, title: String(new Date().getFullYear()) });
  await ntLoadTree(true); renderNotes(currentSub.tab6);
}

// ------------------------------------------------------------------ 좌측 트리 + 우측 페이지
function ntRenderSplit(scope) {
  const host = $('nt-' + scope);
  if (!host.dataset.ready) {
    host.innerHTML = `${scope === 'company' ? '<div id="nt-company-stats" class="mb-4"></div>' : ''}<div class="flex flex-col lg:flex-row gap-4 items-start">
      <aside class="w-full lg:w-72 shrink-0 bg-terminal-panel border border-terminal-border rounded-2xl p-3 lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] overflow-y-auto">
        <div class="flex items-center gap-2 mb-2">
          <input id="nt-${scope}-q" oninput="NT.filter=this.value; ntDrawTree('${scope}')" placeholder="${scope === 'company' ? '티커·기업명 찾기' : '페이지 찾기'}" class="flex-1 min-w-0 bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-white outline-none focus:border-blue-500">
          ${NT.canEdit ? `<button onclick="ntAddChild('${scope}', null)" title="${scope === 'company' ? '섹터·폴더 추가' : '새 페이지'}" class="w-7 h-7 rounded-lg bg-slate-800 hover:bg-blue-600 text-white text-sm">＋</button>` : ''}
        </div>
        <div id="nt-${scope}-tree" class="nt-tree"></div>
      </aside>
      <div id="nt-${scope}-page" class="flex-1 min-w-0 w-full bg-terminal-panel border border-terminal-border rounded-2xl px-5 sm:pl-16 sm:pr-10 py-6 min-h-[60vh]"></div></div>`;
    host.dataset.ready = '1';
  }
  if (!NT.sel[scope]) NT.sel[scope] = scope === 'market' ? ntLatestMr()?.id : (ntKids(ntCoRoot()?.id)[0]?.id || ntCoRoot()?.id);
  const sel = NT.sel[scope];
  ntPath(sel).slice(0, -1).forEach(n => NT.open.add(n.id));
  ntDrawTree(scope);
  ntShow(scope, sel);
}
// 07-2 맨 위: 정리 중인 기업 수 (트리가 바뀔 때마다 다시 계산 → 기업 추가·삭제·이동 즉시 반영)
function ntCompaniesUnder(id) { const out = []; const walk = x => ntKids(x).forEach(n => { if (ntTicker(n)) out.push(n); else walk(n.id); }); if (id) walk(id); return out; }
function ntCoStats() {
  const box = $('nt-company-stats'); const root = ntCoRoot(); if (!box || !root) return;
  const all = ntCompaniesUnder(root.id);
  const tickers = new Set(all.map(ntTicker));
  const withQ = all.filter(c => ntQuarterPages(c).some(x => x.k != null)).length;
  const qPages = all.reduce((a, c) => a + ntQuarterPages(c).length, 0);
  const secs = ntKids(root.id).map(sc => ({ sc, n: ntCompaniesUnder(sc.id).length })).sort((a, b) => b.n - a.n);
  const kpi = (l, v, sub = '') => `<div class="bg-terminal-panel border border-terminal-border rounded-2xl px-4 py-3"><div class="text-[11px] text-slate-400">${l}</div><div class="font-num text-2xl font-bold text-white mt-0.5">${v}</div>${sub ? `<div class="text-[10px] text-slate-500 mt-0.5">${sub}</div>` : ''}</div>`;
  box.innerHTML = `<div class="grid grid-cols-2 md:grid-cols-4 gap-3">
      ${kpi('정리 중인 기업', all.length.toLocaleString() + '<span class="text-sm text-slate-400 font-normal"> 개</span>', tickers.size !== all.length ? `고유 티커 ${tickers.size}개 (같은 티커가 두 폴더에 있음)` : '이름에 (티커 US)가 있는 페이지 기준')}
      ${kpi('섹터', secs.filter(x => x.n).length + '<span class="text-sm text-slate-400 font-normal"> / ' + secs.length + '</span>', '기업이 있는 섹터 / 전체 폴더')}
      ${kpi('분기 실적 있는 기업', withQ.toLocaleString() + '<span class="text-sm text-slate-400 font-normal"> 개</span>', all.length ? `전체의 ${Math.round(withQ / all.length * 100)}%` : '')}
      ${kpi('분기 실적 페이지', qPages.toLocaleString() + '<span class="text-sm text-slate-400 font-normal"> 개</span>', all.length ? `기업당 평균 ${(qPages / all.length).toFixed(1)}개` : '')}
    </div>
    <div class="flex flex-wrap gap-1.5 mt-3">${secs.map(({ sc, n }) => `<button onclick="ntSelect('company','${sc.id}')" class="nt-chip ${NT.sel.company === sc.id ? 'border-blue-600 text-white' : ''}">${esc(sc.title)} <b class="font-num text-blue-300">${n}</b></button>`).join('')}</div>`;
}
function ntDrawTree(scope) {
  if (scope === 'company') ntCoStats();
  const box = $(`nt-${scope}-tree`); if (!box) return;
  const root = scope === 'market' ? ntMrRoot() : ntCoRoot();
  if (!root) { box.innerHTML = '<div class="text-xs text-slate-500 p-2">폴더가 없습니다</div>'; return; }
  const q = (NT.filter || '').trim().toLowerCase();
  const sel = NT.sel[scope];
  const row = (n, depth) => {
    const kids = ntKids(n.id);
    const open = NT.open.has(n.id);
    const icon = n.icon || (kids.length ? (open ? '📂' : '📁') : '📄');
    return `<div class="nt-row ${n.id === sel ? 'on' : ''}" style="padding-left:${4 + depth * 14}px" onclick="ntSelect('${scope}','${n.id}')">
      <span class="nt-tog" onclick="event.stopPropagation(); ntToggle('${scope}','${n.id}')">${kids.length ? (open ? '▼' : '▶') : ''}</span>
      <span class="text-[13px] mr-1">${esc(icon)}</span><span class="nt-t" title="${esc(n.title)}">${esc(ntShortTitle(n.title) || n.title || '제목 없음')} ${ntTags(n.title)}</span>
      ${NT.canEdit ? `<button class="nt-add" title="하위 페이지 추가" onclick="event.stopPropagation(); ntAddChild('${scope}','${n.id}')">＋</button>` : ''}</div>`
      + (open && kids.length ? kids.map(k => row(k, depth + 1)).join('') : '');
  };
  if (q) {
    const hits = [];
    const walk = (id, d) => ntKids(id).forEach(n => { if ((n.title || '').toLowerCase().includes(q)) hits.push(n); if (hits.length < 200) walk(n.id, d + 1); });
    walk(root.id, 0);
    box.innerHTML = hits.length ? hits.slice(0, 200).map(n => `<div class="nt-row ${n.id === sel ? 'on' : ''}" onclick="ntSelect('${scope}','${n.id}')"><span class="nt-t"><span class="text-[10px] text-slate-500">${esc(ntPath(n.id).slice(1, -1).map(p => ntShortTitle(p.title)).join(' › '))}</span><br>${esc(n.title)}</span></div>`).join('') : '<div class="text-xs text-slate-500 p-2">찾는 페이지가 없습니다</div>';
    return;
  }
  box.innerHTML = ntKids(root.id).map(n => row(n, 0)).join('') || '<div class="text-xs text-slate-500 p-2">비어 있음</div>';
}
function ntToggle(scope, id) { NT.open.has(id) ? NT.open.delete(id) : NT.open.add(id); ntDrawTree(scope); }
function ntSelect(scope, id) {
  NT.sel[scope] = id;
  if (ntKids(id).length) NT.open.add(id);
  ntDrawTree(scope); ntShow(scope, id);
  if (innerWidth < 1024) $(`nt-${scope}-page`)?.scrollIntoView({ behavior: 'smooth' });
}
function ntGo(id, tab) {
  // 다른 화면(통합·표)에서 특정 페이지로 이동
  const scope = ntScopeOf(id);
  NT.sel[scope] = id;
  if (tab) { const co = ntCompanyOf(id); if (co) NT.coTab[co.id] = tab; }
  switchTab('tab6', scope);
}
function ntLatestMr() {
  const root = ntMrRoot(); if (!root) return null;
  let n = root, g = 0;
  while (ntKids(n.id).length && g++ < 10) { const k = ntKids(n.id); n = k[k.length - 1]; }
  return n;
}

// ------------------------------------------------------------------ 페이지 표시·편집
async function ntFlush() {
  clearTimeout(NT.saveT); clearTimeout(NT.titleT);
  if (NT.cur?.dirty) await ntSave();
}
function ntDestroyEditor() { try { NT.ed?.destroy(); } catch (e) {} NT.ed = null; }
async function ntShow(scope, id) {
  const box = $(`nt-${scope}-page`); if (!box) return;
  await ntFlush(); ntDestroyEditor();
  const n = ntNode(id);
  try { history.replaceState(null, '', `#tab6/${scope}${id ? '/' + id : ''}`); } catch (e) {}
  if (!n) { box.innerHTML = '<div class="text-sm text-slate-500 py-10 text-center">왼쪽에서 페이지를 고르세요</div>'; return; }
  if (scope === 'company' && ntIsCompany(n)) return ntShowCompany(box, n);
  box.innerHTML = '<div class="text-sm text-slate-500 py-10 text-center">불러오는 중…</div>';
  let pg;
  try { pg = await ntApi('page?id=' + id); } catch (e) { box.innerHTML = `<div class="text-sm text-rose-300 py-10 text-center">${esc(e.message)}</div>`; return; }
  if (NT.sel[scope] !== id) return;
  const co = scope === 'company' ? ntCompanyOf(id) : null;
  box.innerHTML = `${ntCrumbs(scope, id)}
    ${co ? ntCompanyStrip(co) : ''}
    ${pg.cover ? `<div class="-ml-5 -mr-5 sm:-ml-16 sm:-mr-10 -mt-2 mb-4 h-36 bg-cover bg-center rounded-t-xl" style="background-image:url('${esc(pg.cover)}')"></div>` : ''}
    <div class="flex items-start gap-3 mt-2">
      ${pg.icon ? `<span class="text-3xl leading-none mt-1">${esc(pg.icon)}</span>` : ''}
      <input id="nt-title" class="nt-title" value="${esc(pg.title)}" placeholder="제목 없음" ${NT.canEdit ? '' : 'readonly'} oninput="ntTitleChanged(this.value)">
    </div>
    <div class="flex flex-wrap items-center gap-2 mt-2 text-[11px] text-slate-500">
      ${pg.title !== undefined ? ntTags(pg.title) : ''}
      <span>수정 ${esc(ntFmtDate(pg.updated_at))}${pg.updated_by && pg.updated_by !== 'notion' ? ' · ' + esc(pg.updated_by) : (pg.source === 'notion' ? ' · Notion에서 옮김' : '')}</span>
      <span id="nt-chg-note" class="text-blue-300/80"></span>
      <span id="nt-save" class="ml-auto"></span>
      ${ntActions(scope, id)}
    </div>
    ${NT.canEdit ? `<div class="mt-2 text-[10.5px] text-slate-500 leading-relaxed">✏️ <b class="text-slate-400">/</b> 블록 추가 · <b class="text-slate-400">Enter</b> 새 줄 · <b class="text-slate-400">Tab / Shift+Tab</b> 들여쓰기·내어쓰기 · 줄 왼쪽 <b class="text-slate-400">＋</b> 아래에 줄 추가 · <b class="text-slate-400">⋮⋮</b> 끌어서 옮기기·클릭하면 삭제/복제/전환/색상 · <b class="text-slate-400">Ctrl+Shift+↑↓</b> 줄 이동 · <b class="text-slate-400">Ctrl+D</b> 복제 · <b class="text-slate-400">"- " "1. " "[] " "> " "# "</b> 자동 서식</div>` : ''}
    ${scope === 'market' ? '<div id="nt-days" class="flex flex-wrap gap-1.5 mt-3"></div>' : ''}
    ${ntChildChips(scope, id)}
    <div id="nt-ed" class="mt-4 ${NT.canEdit ? '' : 'ne-ro'}"></div>`;
  ntMountEditor($('nt-ed'), pg);
  if (scope === 'market') ntDayChips();
  if (scope === 'company' && NT.canEdit) ntFeedPrevQuarter(pg);
}
// 분기 실적 페이지: 직전 분기 페이지의 NTM PE·시가총액을 읽어 편집기에 넘김 → "…, +x.x% QoQ" 자동 계산
async function ntFeedPrevQuarter(pg) {
  const n = ntNode(pg.id), par = n && ntNode(n.parent_id);
  if (!par || !/^earnings$/i.test((par.title || '').trim())) return;
  const k = ntQKey(pg.title); if (k == null) return;
  const sib = d => ntKids(par.id).find(x => x.id !== pg.id && ntQKey(x.title) === k - d);
  const prevQ = sib(1), prevY = sib(4);
  if (!prevQ && !prevY) return;
  try {
    const [pq, py] = await Promise.all([prevQ ? ntApi('page?id=' + prevQ.id) : null, prevY ? ntApi('page?id=' + prevY.id) : null]);
    if (NT.cur?.id !== pg.id || !NT.ed) return;
    const eq = pq ? ntParseEarnings(pq.html) : null, ey = py ? ntParseEarnings(py.html) : null;
    if (eq && NT.ed.setPrevMetrics && (isNum(eq.ntmPE) || isNum(eq.mktCap))) NT.ed.setPrevMetrics({ ntmPE: eq.ntmPE, mktCap: eq.mktCap });
    const toMap = e => e ? Object.fromEntries(e.items.filter(i => isNum(i.v) && !i.range).map(i => [i.key, { v: i.v, unit: i.unit, isMn: i.isMn }])) : null;
    if (NT.ed.setChangeRefs) NT.ed.setChangeRefs({ parse: ntParseLine, skip: NT_SKIP_SEC, yoy: toMap(ey), qoq: toMap(eq) });
    const note = $('nt-chg-note');
    if (note) note.textContent = `자동 계산 기준 — YoY: ${prevY ? ntQLabel(k - 4) : '1년 전 페이지 없음'} · QoQ: ${prevQ ? ntQLabel(k - 1) : '직전 분기 페이지 없음'}`;
  } catch (e) {}
}
function ntCrumbs(scope, id) {
  const p = ntPath(id);
  return `<div class="flex flex-wrap items-center gap-1 text-[11px] text-slate-500">${p.map((n, i) => `<button onclick="ntSelect('${scope}','${n.id}')" class="hover:text-white ${i === p.length - 1 ? 'text-slate-300' : ''}">${esc(ntShortTitle(n.title) || '제목 없음')}</button>`).join('<span>/</span>')}</div>`;
}
function ntActions(scope, id) {
  const btn = (fn, label, cls = '') => `<button onclick="${fn}" class="px-2 py-1 rounded-md border border-slate-700 text-slate-300 hover:text-white hover:border-slate-500 ${cls}">${label}</button>`;
  const notion = ntNode(id) && /^[0-9a-f]{32}$/.test(id) ? '' : '';
  let h = '';
  if (NT.canEdit) {
    if (scope === 'market') h += btn(`ntAddDay()`, '＋ 오늘 시황 추가', 'border-blue-600/60 text-blue-300');
    { const n = ntNode(id), par = n && ntNode(n.parent_id); if (scope === 'company' && par && /^earnings$/i.test((par.title || '').trim()) && ntQKey(n.title) != null) h += btn(`ntAiConcall('${id}')`, '🤖 컨콜 정리 추가', 'border-violet-600/60 text-violet-300'); }
    h += btn(`ntAddChild('${scope}','${id}')`, '＋ 하위 페이지') + btn(`ntMove('${id}')`, '이동') + btn(`ntRevisions('${id}')`, '이전 버전') + btn(`ntDelete('${scope}','${id}')`, '삭제', 'hover:border-rose-500 hover:text-rose-300');
  }
  return h + notion;
}
function ntChildChips(scope, id) {
  const k = ntKids(id); if (!k.length) return '';
  return `<div class="flex flex-wrap gap-1.5 mt-4">${k.map(n => `<button onclick="ntSelect('${scope}','${n.id}')" class="nt-chip">${esc(n.icon || (ntKids(n.id).length ? '📁' : '📄'))} ${esc(ntShortTitle(n.title) || '제목 없음')} ${ntTags(n.title)}</button>`).join('')}</div>`;
}
function ntMountEditor(el, pg) {
  if (typeof NoteEditor === 'undefined') { el.innerHTML = '<div class="text-rose-300 text-sm">편집기를 불러오지 못했습니다(새로고침)</div>'; return; }
  NT.cur = { id: pg.id, rev: pg.rev, dirty: false, saving: false, title: pg.title };
  NT.ed = NoteEditor.create(el, {
    html: pg.html || '', editable: NT.canEdit,
    upload: NT.canEdit ? ntUpload : null,
    // 기업 개요(개요 페이지와 그 하위)는 붙여넣은 형식 그대로 — 줄마다 자동 나누기 안 함
    splitPaste: !ntPath(pg.id).some(n => /^(개요|overview)$/i.test((n.title || '').trim())),
    onUpdate: () => { if (!NT.cur) return; NT.cur.dirty = true; ntSaveState('편집 중…'); clearTimeout(NT.saveT); NT.saveT = setTimeout(ntSave, 1500); },
    onSave: () => { clearTimeout(NT.saveT); ntSave(); },
  });
  el.addEventListener('click', e => {
    const a = e.target.closest('a[href^="#note/"]'); if (!a) return;
    e.preventDefault(); const id = a.getAttribute('href').slice(6); if (ntNode(id)) ntGo(id);
  });
}
async function ntUpload(file) {
  const r = await fetch('/api/notes/file', { method: 'POST', headers: { 'Content-Type': file.type, 'X-File-Name': encodeURIComponent(file.name || 'image') }, body: file });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.message || j.error || ('HTTP ' + r.status));
  return j.url;
}
function ntSaveState(t, cls = '') { const s = $('nt-save'); if (s) { s.textContent = t; s.className = 'ml-auto ' + cls; } }
function ntTitleChanged(v) {
  if (!NT.cur) return;
  NT.cur.title = v; NT.cur.dirty = true; ntSaveState('편집 중…');
  clearTimeout(NT.saveT); NT.saveT = setTimeout(ntSave, 1200);
}
async function ntSave(force = false) {
  const c = NT.cur; if (!c || !NT.ed || !NT.canEdit) return;
  if (c.saving) { c.again = true; return; }
  c.saving = true; c.dirty = false; ntSaveState('저장 중…', 'text-slate-400');
  const html = NT.ed.getHTML(); const title = c.title;
  try {
    const j = await ntApi('page', { method: 'PUT', body: JSON.stringify({ id: c.id, title, html, rev: c.rev, force }) });
    c.rev = j.rev; ntSaveState('저장됨 ' + new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }), 'text-emerald-400/80');
    const n = ntNode(c.id); if (n && n.title !== title) { n.title = title; ['market', 'company'].forEach(ntDrawTree); }
  } catch (e) {
    c.dirty = true;
    if (e.status === 409) {
      c.saving = false;
      if (confirm('이 페이지가 다른 창(또는 다른 기기)에서 먼저 수정됐습니다.\n\n[확인] 지금 내 화면의 내용으로 덮어쓰기\n[취소] 최신 내용 다시 불러오기(내 변경은 버림)')) return ntSave(true);
      c.dirty = false; const scope = ntScopeOf(c.id); return ntShow(scope, c.id);
    }
    ntSaveState('저장 실패: ' + e.message + ' (자동 재시도)', 'text-rose-400');
    clearTimeout(NT.saveT); NT.saveT = setTimeout(ntSave, 5000);
  } finally { c.saving = false; if (c.again) { c.again = false; ntSave(); } }
}
addEventListener('beforeunload', e => {
  if (NT.cur?.dirty && NT.ed) {
    try { fetch('/api/notes/page', { method: 'PUT', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: NT.cur.id, title: NT.cur.title, html: NT.ed.getHTML(), rev: NT.cur.rev }) }); } catch (x) {}
    e.preventDefault(); e.returnValue = '';
  }
});

// ------------------------------------------------------------------ 트리 조작
async function ntAddChild(scope, parentId) {
  const root = scope === 'market' ? ntMrRoot() : ntCoRoot();
  const pid = parentId || root?.id || null;
  const pn = ntNode(pid);
  let title, children = [], html = '';
  if (scope === 'company' && pn && pn.id === root?.id) title = prompt('새 섹터·폴더 이름', '');
  else if (scope === 'company' && pn && ntPath(pid).length === 2) {
    title = prompt('새 기업 이름 — 형식: 회사명 (티커 US)\n예: Semtech Corporation (SMTC US)', '');
    if (title && NT_RE_TICKER.test(title)) children = ['개요', 'Earnings', 'News Flow'];
  } else if (scope === 'company' && pn && /^earnings$/i.test(pn.title || '')) return ntAddQuarter(pid);
  else title = prompt('새 페이지 제목', scope === 'market' ? ntSuggestMrTitle(pid) : '');
  if (!title) return;
  try {
    const j = await ntPost('node', { op: 'create', parent_id: pid, title, html });
    for (const c of children) await ntPost('node', { op: 'create', parent_id: j.id, title: c });
    await ntLoadTree(true);
    if (pid) NT.open.add(pid);
    NT.sel[scope] = j.id; ntDrawTree(scope); ntShow(scope, j.id);
  } catch (e) { alert('만들지 못했습니다: ' + e.message); }
}
function ntSuggestMrTitle(pid) {
  const d = new Date(Date.now() + 9 * 3600e3);
  const y = d.getUTCFullYear(), m = d.getUTCMonth() + 1, wk = Math.ceil((d.getUTCDate() + new Date(Date.UTC(y, m - 1, 1)).getUTCDay()) / 7);
  const depth = ntPath(pid).length;
  if (depth === 1) return String(y);
  if (depth === 2) return `${m}월`;
  return `${y}년 ${m}월 ${['첫째', '둘째', '셋째', '넷째', '다섯째', '여섯째'][wk - 1] || wk + '번째'} 주`;
}
async function ntDelete(scope, id) {
  const n = ntNode(id); const cnt = (function c(x) { return 1 + ntKids(x).reduce((a, k) => a + c(k.id), 0); })(id);
  if (!confirm(`"${ntShortTitle(n?.title)}"${cnt > 1 ? ` 및 하위 페이지 ${cnt - 1}개` : ''}를 휴지통으로 옮길까요?\n(07-0 통합 화면의 휴지통에서 되살릴 수 있습니다)`)) return;
  await ntFlush(); NT.cur = null;
  try { await ntPost('node', { op: 'delete', id }); } catch (e) { return alert(e.message); }
  const parent = n?.parent_id; await ntLoadTree(true);
  NT.sel[scope] = parent && ntNode(parent) ? parent : null; ntRenderSplit(scope);
}
function ntModal(title, inner) {
  ntCloseModal();
  const el = document.createElement('div'); el.id = 'nt-modal';
  el.className = 'fixed inset-0 z-[70] bg-black/60 flex items-start justify-center p-4 pt-[8vh]';
  el.innerHTML = `<div class="w-full max-w-2xl bg-terminal-panel border border-terminal-border rounded-2xl shadow-2xl flex flex-col max-h-[84vh]">
    <div class="flex items-center justify-between px-5 py-3 border-b border-terminal-border"><div class="font-bold text-white text-sm">${title}</div><button onclick="ntCloseModal()" class="text-slate-400 hover:text-white text-lg">✕</button></div>
    <div class="p-5 overflow-y-auto" id="nt-modal-body">${inner}</div></div>`;
  el.addEventListener('mousedown', e => { if (e.target === el) ntCloseModal(); });
  document.body.appendChild(el);
}
function ntCloseModal() { const m = $('nt-modal'); if (m) { m.querySelectorAll('.nt-prev').forEach(x => x._ed?.destroy?.()); m.remove(); } }
function ntMove(id) {
  ntModal('페이지 이동 — 옮길 위치(상위 페이지)를 고르세요', `<input id="nt-mv-q" oninput="ntMoveList('${id}')" placeholder="위치 찾기" class="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-blue-500 mb-3"><div id="nt-mv-list" class="space-y-0.5 text-sm"></div>`);
  ntMoveList(id); $('nt-mv-q').focus();
}
function ntMoveList(id) {
  const q = ($('nt-mv-q')?.value || '').trim().toLowerCase();
  const bad = new Set(); (function c(x) { bad.add(x); ntKids(x).forEach(k => c(k.id)); })(id);
  const out = [];
  (function walk(pid, d) { for (const n of ntKids(pid)) { if (bad.has(n.id)) continue; if (!q || (n.title || '').toLowerCase().includes(q)) out.push([n, d]); if (d < 4 || q) walk(n.id, d + 1); } })('', 0);
  $('nt-mv-list').innerHTML = out.slice(0, 300).map(([n, d]) => `<button onclick="ntDoMove('${id}','${n.id}')" class="block w-full text-left px-2 py-1.5 rounded hover:bg-slate-800 text-slate-200" style="padding-left:${8 + (q ? 0 : d * 16)}px">${q ? `<span class="text-[10px] text-slate-500">${esc(ntPath(n.id).slice(0, -1).map(p => ntShortTitle(p.title)).join(' › '))}</span> ` : ''}${esc(n.title)}</button>`).join('') || '<div class="text-slate-500 text-xs">없음</div>';
}
async function ntDoMove(id, parentId) {
  try { await ntPost('node', { op: 'move', id, parent_id: parentId }); } catch (e) { return alert(e.message); }
  ntCloseModal(); await ntLoadTree(true); const s = ntScopeOf(id); NT.sel[s] = id; ntPath(id).forEach(n => NT.open.add(n.id));
  if (currentSub.tab6 === s) { ntDrawTree(s); ntShow(s, id); } else ntGo(id);
}
async function ntRevisions(id) {
  await ntFlush();
  ntModal('이전 버전 (10분 단위 보관, 최근 40개)', '<div class="text-slate-500 text-sm">불러오는 중…</div>');
  try {
    const j = await ntPost('node', { op: 'revisions', id });
    $('nt-modal-body').innerHTML = j.revisions.length ? `<div class="space-y-1">${j.revisions.map(r => `<button onclick="ntPreviewRev('${id}', ${r.rev})" class="w-full flex justify-between px-3 py-2 rounded-lg hover:bg-slate-800 text-sm text-slate-200"><span>${esc(r.title || '')}</span><span class="text-xs text-slate-500 font-mono">${esc(ntFmtDate(r.saved_at))} · ${esc(r.saved_by || '')} · ${Math.round((r.size || 0) / 1024)}KB</span></button>`).join('')}</div><div id="nt-rev-view" class="mt-4"></div>` : '<div class="text-slate-500 text-sm">저장된 이전 버전이 없습니다</div>';
  } catch (e) { $('nt-modal-body').innerHTML = `<div class="text-rose-300 text-sm">${esc(e.message)}</div>`; }
}
async function ntPreviewRev(id, rev) {
  const r = await ntPost('node', { op: 'revision', id, rev });
  const v = $('nt-rev-view');
  v.innerHTML = `<div class="flex items-center justify-between mb-2"><div class="text-xs text-slate-400">${esc(ntFmtDate(r.saved_at))} 버전 미리보기</div>${NT.canEdit ? `<button id="nt-rev-restore" class="px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold">이 버전으로 되돌리기</button>` : ''}</div><div class="nt-prev ne-ro border border-slate-800 rounded-xl p-4 max-h-[50vh] overflow-y-auto"></div>`;
  const box = v.querySelector('.nt-prev'); box._ed = NoteEditor.create(box, { html: r.html, editable: false });
  const b = $('nt-rev-restore'); if (b) b.onclick = () => { if (NT.ed && NT.cur?.id === id) { NT.ed.commands.setContent(r.html, { emitUpdate: true }); NT.cur.dirty = true; ntSave(); } ntCloseModal(); };
}

// ------------------------------------------------------------------ Market Review 도우미
function ntDayChips() {
  const box = $('nt-days'); const ed = $('nt-ed'); if (!box || !ed) return;
  const marks = [...ed.querySelectorAll('.ne-doc > p, .ne-doc > h1, .ne-doc > h2, .ne-doc > h3')].filter(p => /Market Review\s*[-–]\s*\d{4}년\s*\d{1,2}월\s*\d{1,2}일/.test(p.textContent));
  box.innerHTML = marks.map((p, i) => { p.classList.add('nt-day-target'); const m = p.textContent.match(/(\d{1,2})월\s*(\d{1,2})일\s*(\([^)]*\))?/); return `<button data-i="${i}" class="nt-chip">📅 ${esc(m ? `${m[1]}/${m[2]} ${m[3] || ''}` : '날짜')}</button>`; }).join('');
  box.onclick = e => { const b = e.target.closest('[data-i]'); if (b) marks[+b.dataset.i].scrollIntoView({ behavior: 'smooth', block: 'start' }); };
}
async function ntMarketLines() {
  try { if (typeof MACRO !== 'undefined' && !MACRO) MACRO = await fetch('data/macro.json?ts=' + Date.now(), { cache: 'no-store' }).then(r => r.ok ? r.json() : null); } catch (e) {}
  const B = typeof benchmarkData !== 'undefined' ? benchmarkData : {};
  const M = Object.fromEntries(((typeof MACRO !== 'undefined' && MACRO?.items) || []).map(x => [x.key, x]));
  const pc = v => isNum(v) ? `${v > 0 ? '+' : ''}${v.toFixed(2)}%` : '';
  const n = (v, d) => isNum(v) ? v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }) : '';
  const lines = [];
  [['DJI', 'DOW'], ['SP500', 'S&P500'], ['NDX', 'Nasdaq100'], ['RUT', 'Russell2000']].forEach(([k, l]) => { const b = B[k]; if (b && isNum(b.level)) lines.push(`${l} ${pc(b.r1D)} (${n(b.level, 0)}p)`); });
  const px = (k, l, fmt) => { const x = M[k]; if (x && isNum(x.last)) lines.push(`${l} ${pc(x.chg?.r1D)} (${fmt(x.last)})`); };
  px('WTI', 'WTI', v => '$' + n(v, 1)); px('GOLD', '금', v => '$' + n(v, 0)); px('DXY', 'DXY', v => n(v, 2) + 'p');
  px('EURUSD', 'EUR', v => n(v, 4)); px('USDJPY', 'JPY', v => n(v, 1)); px('USDKRW', 'KRW', v => n(v, 0));
  [['UST2Y', '2y 금리'], ['UST10Y', '10y 금리']].forEach(([k, l]) => { const x = M[k]; if (x && isNum(x.last)) lines.push(`${l} ${isNum(x.chg?.r1D) ? (x.chg.r1D > 0 ? '+' : '') + x.chg.r1D.toFixed(2) + 'bp' : ''} (${x.last.toFixed(2)}%)`); });
  return lines;
}
async function ntAddDay() {
  if (!NT.ed) return;
  const d = new Date(Date.now() + 9 * 3600e3);
  const label = `Market Review - ${d.getUTCFullYear()}년 ${d.getUTCMonth() + 1}월 ${d.getUTCDate()}일 (${'일월화수목금토'[d.getUTCDay()]})`;
  const lines = await ntMarketLines();
  const sec = t => `<p><strong>[${t}]</strong></p>`;
  const html = `<p></p><p><strong>${esc(label)}</strong></p>${sec('시장 변동')}<p>${lines.map(esc).join('<br>') || '&nbsp;'}</p>${sec('경제지표')}<ul><li><p></p></li></ul>${sec('Macro 이슈')}<ol><li><p>시황</p><ol><li><p></p></li></ol></li></ol>${sec('Company 이슈')}<ol><li><p>[티커 US]</p><ol><li><p></p></li></ol></li></ol>${sec('View')}<ol><li><p></p></li></ol>`;
  NT.ed.chain().focus('end').insertContent(html).run();
  setTimeout(ntDayChips, 50);
  const marks = document.querySelectorAll('.nt-day-target'); marks[marks.length - 1]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ------------------------------------------------------------------ 실적 숫자 읽기
function ntParseLine(s) {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  const m = s.match(/^(.+?)\s+(-?\$?\s?-?[\d,]*\.?\d+(?:\s*[~～\-–]\s*\$?[\d,]*\.?\d+)?\s*(?:[KMBT](?![a-z])|조|억)?\s*(?:%|x|bp|배)?)(?=\s*(?:,|\(|$|\s(?:YoY|QoQ)))(.*)$/i);
  if (!m) return null;
  const name = m[1].replace(/[:：]\s*$/, '').trim();
  if (!name || /^[\d$.,%\s-]+$/.test(name)) return null;
  const raw = m[2].trim(); const rest = m[3] || '';
  const unit = /%/.test(raw) ? '%' : /bp/i.test(raw) ? 'bp' : /x|배/i.test(raw) ? 'x' : /\$/.test(raw) ? '$' : '';
  const nums = raw.replace(/\$/g, '').match(/-?[\d,]*\.?\d+/g).map(x => parseFloat(x.replace(/,/g, '')));
  let v = nums.length > 1 && /[~～]/.test(raw) ? (nums[0] + Math.abs(nums[1])) / 2 : nums[0];
  if (/^-|\s-|\$-/.test(raw) && v > 0) v = -v;
  const suf = (raw.match(/([KMBT]|조|억)(?![a-z])/i) || [])[1];
  let scale = 1, money = unit === '$';
  if (suf) { const S = { K: 1e-3, M: 1, B: 1e3, T: 1e6 }[suf.toUpperCase()]; if (S) scale = S; }
  const isMn = money && !!suf;           // 금액(백만 달러 환산)인지, 주당 금액(EPS 등)인지
  const yoy = ntParseChg(rest, 'YoY'), qoq = ntParseChg(rest, 'QoQ');
  const cm = rest.match(/컨센서스\s*\(([^)]*)\)\s*(?:[+-]?\d[\d,]*(?:\.\d+)?\s*(?:%|bp)\s*)?(상회|하회|부합)?/) || rest.match(/컨센서스\s*(상회|하회|부합)/);
  let cons = null, consTxt = '', beat = '';
  if (cm) {
    if (cm.length === 3) { consTxt = cm[1]; beat = cm[2] || ''; const c = ntParseLine('x ' + cm[1]); if (c) cons = c.v; }
    else beat = cm[1];
  }
  return { name, raw, unit, v: isMn ? v * scale : v, isMn, range: nums.length > 1 && /[~～]/.test(raw), yoy, qoq, cons, consTxt, beat };
}
function ntParseChg(rest, kw) {
  const m = rest.match(new RegExp(`([+-]?[\\d,]*\\.?\\d+)\\s*(%|bp|%p)\\s*${kw}`, 'i'));
  if (m) return { v: parseFloat(m[1].replace(/,/g, '')), u: /bp/i.test(m[2]) ? 'bp' : m[2] === '%p' ? '%p' : '%' };
  const t = rest.match(new RegExp(`(흑전|적전|적지|흑지|흑자전환|적자전환|적자지속|흑자지속|턴어라운드)\\s*${kw}`));
  return t ? { t: t[1] } : null;
}
const NT_SKIP_SEC = /guidance|가이던스|conference|컨퍼런스|q&a|추가 내용|코멘트|전망/i;
function ntParseEarnings(html) {
  const doc = new DOMParser().parseFromString(html || '', 'text/html');
  const txt = doc.body.textContent || '';
  const out = { items: [], guidance: [], ntmPE: null, mktCap: null, date: '' };
  let m = txt.match(/NTM\s*P\/?E\s*[:：]?\s*([\d.,]+)\s*x/i); if (m) out.ntmPE = parseFloat(m[1].replace(/,/g, ''));
  m = txt.match(/Market\s*Cap\s*[:：]?\s*\$?\s*([\d,.]+)\s*([MBT])?/i); if (m) out.mktCap = parseFloat(m[1].replace(/,/g, '')) * ({ B: 1e3, T: 1e6 }[(m[2] || 'M').toUpperCase()] || 1);
  m = txt.match(/(\d{4})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일\s*발표/); if (m) out.date = `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  const own = li => { const p = [...li.children].find(c => c.tagName === 'P'); if (p) return p.textContent; const c = li.cloneNode(true); c.querySelectorAll('ul,ol').forEach(x => x.remove()); return c.textContent; };
  const seen = new Set();
  doc.querySelectorAll('li').forEach(li => {
    const path = [], metricParents = []; let p = li.parentElement;
    while (p && p !== doc.body) {
      if (p.tagName === 'LI') { const t = own(p).trim(); const pr = ntParseLine(t); if (pr) metricParents.unshift(pr.name); else path.unshift(t); }
      p = p.parentElement;
    }
    const line = own(li).trim(); if (!line || line.length > 260) return;
    const r = ntParseLine(line); if (!r) return;
    const secPath = path.filter(x => !/^(재무제표|실적 요약)$/.test(x.replace(/[()]/g, '').trim()));
    r.sec = secPath.join(' › ');
    r.depth = metricParents.length;
    r.key = [r.sec, ...metricParents, r.name].join(' › ').toLowerCase().replace(/\s+/g, ' ');
    if (path.some(x => NT_SKIP_SEC.test(x))) { if (path.some(x => /guidance|가이던스/i.test(x))) out.guidance.push(r); return; }
    if (seen.has(r.key)) return; seen.add(r.key);
    out.items.push(r);
  });
  return out;
}
function ntFmtVal(it, v = it?.v) {
  if (!isNum(v)) return '-';
  if (it.unit === '%') return v.toFixed(Math.abs(v) >= 100 ? 0 : 2) + '%';
  if (it.unit === 'x') return v.toFixed(2) + 'x';
  if (it.unit === 'bp') return v.toFixed(0) + 'bp';
  if (it.unit === '$') return it.isMn ? `${v < 0 ? '-' : ''}$${Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: Math.abs(v) >= 100 ? 0 : 1 })}M` : `${v < 0 ? '-' : ''}$${Math.abs(v).toFixed(2)}`;
  return v.toLocaleString('en-US', { maximumFractionDigits: 2 });
}
function ntChgHtml(it, cur, prev, reported) {
  // 직접 계산(이전 분기 페이지가 있을 때) → 없으면 본문에 적힌 수치(보고치) 사용
  if (cur && prev && isNum(cur.v) && isNum(prev.v)) {
    if (cur.unit === '%') { const d = (cur.v - prev.v) * 100; return ntSigned(d, 'bp', 0); }
    if (cur.unit === 'x') return ntSigned(cur.v - prev.v, 'x', 2);
    if (prev.v > 0) return ntSigned((cur.v / prev.v - 1) * 100, '%', 1);
    if (prev.v < 0 && cur.v > 0) return '<span class="nt-up">흑전</span>';
    if (prev.v < 0 && cur.v < 0) return '<span class="nt-mu">적지</span>';
    if (prev.v > 0 && cur.v < 0) return '<span class="nt-dn">적전</span>';
    return '<span class="nt-mu">-</span>';
  }
  if (reported) {
    if (reported.t) return `<span class="${/흑/.test(reported.t) ? 'nt-up' : 'nt-dn'}" title="본문 기재값">${esc(reported.t)}<sup>*</sup></span>`;
    return ntSigned(reported.v, reported.u === '%p' ? 'bp' : reported.u, reported.u === 'bp' ? 0 : 1, reported.u === '%p' ? 100 : 1, true);
  }
  return '<span class="nt-mu">-</span>';
}
function ntSigned(v, u, d, mult = 1, rep = false) {
  if (!isNum(v)) return '<span class="nt-mu">-</span>';
  v *= mult;
  const cls = v > 0 ? 'nt-up' : v < 0 ? 'nt-dn' : 'nt-mu';
  return `<span class="${cls} font-num"${rep ? ' title="본문 기재값(이전 분기 페이지 없음)"' : ''}>${v > 0 ? '+' : ''}${v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}${u}${rep ? '<sup>*</sup>' : ''}</span>`;
}

// ------------------------------------------------------------------ 기업 화면
function ntCompanyStrip(co) {
  const t = ntTicker(co); const s = ntStock(t);
  return `<div class="flex flex-wrap items-center gap-2 mt-2 text-[11px]"><button onclick="ntSelect('company','${co.id}')" class="nt-chip">🏢 ${esc(ntShortTitle(co.title))} <b class="font-mono text-blue-300">${esc(t)}</b></button>${s ? `<span class="text-slate-400">${isNum(s.price) ? '$' + s.price.toFixed(2) : ''} ${typeof fmtPctHtml === 'function' ? fmtPctHtml(s.r1D) : ''}</span>` : ''}</div>`;
}
function ntStock(t) { if (!t || typeof findStock !== 'function') return null; return findStock(t) || findStock(t.replace('.', '-')) || findStock(t.replace('-', '.')) || null; }
function ntOpenDeepDive(t) { const sel = $('deepdive-ticker-select'); if (sel) { if (![...sel.options].some(o => o.value === t)) sel.add(new Option(t, t)); sel.value = t; } switchTab('tab4'); }
const NT_CO_TABS = [['overview', '개요'], ['table', '실적 표'], ['quarters', '분기별 실적'], ['news', 'News Flow']];
function ntShowCompany(box, co) {
  const t = ntTicker(co);
  const s = ntStock(t);
  const extra = ntKids(co.id).filter(n => !/^(개요|overview|earnings|news\s*flow)$/i.test((n.title || '').trim()));
  const tab = NT.coTab[co.id] || 'table';
  const kpi = (l, v) => `<div class="bg-slate-950/60 border border-slate-800 rounded-xl px-3 py-2"><div class="text-[10px] text-slate-500">${l}</div><div class="font-num text-sm font-bold text-white">${v}</div></div>`;
  box.innerHTML = `${ntCrumbs('company', co.id)}
    <div class="flex flex-wrap items-end justify-between gap-3 mt-2">
      <div><div class="text-2xl font-bold text-white">${esc(ntShortTitle(co.title))} <span class="font-mono text-blue-300 text-lg">${esc(t)}</span></div>
      <div class="text-xs text-slate-500 mt-0.5">${esc(ntPath(co.id).slice(1, -1).map(p => ntShortTitle(p.title)).join(' › '))}</div></div>
      <div class="flex flex-wrap items-center gap-1.5 text-[11px]">${NT.canEdit ? `<button onclick="ntRenameCompany('${co.id}')" class="px-2 py-1 rounded-md border border-slate-700 text-slate-300 hover:text-white">이름 변경</button><button onclick="ntMove('${co.id}')" class="px-2 py-1 rounded-md border border-slate-700 text-slate-300 hover:text-white">이동</button><button onclick="ntDelete('company','${co.id}')" class="px-2 py-1 rounded-md border border-slate-700 text-slate-300 hover:text-rose-300">삭제</button>` : ''}${s ? `<button onclick="ntOpenDeepDive('${esc(s.ticker)}')" class="px-2 py-1 rounded-md border border-blue-700 text-blue-300">05 재무제표 보기</button>` : ''}</div>
    </div>
    ${s ? `<div class="grid grid-cols-2 sm:grid-cols-5 gap-2 mt-3">${kpi('주가', isNum(s.price) ? '$' + s.price.toFixed(2) : '-')}${kpi('1D', fmtPctHtml(s.r1D))}${kpi('YTD', fmtPctHtml(s.rYTD))}${kpi('시가총액', typeof fmtUsdBig === 'function' ? fmtUsdBig(s.mktCap) : '-')}${kpi('Fwd P/E (AlphaDesk)', isNum(s.fwdPe) ? s.fwdPe.toFixed(1) + 'x' : (isNum(s.peTTM) ? s.peTTM.toFixed(1) + 'x' : '-'))}</div>` : ''}
    <div class="flex flex-wrap gap-1.5 mt-4 border-b border-slate-800 pb-2">${NT_CO_TABS.map(([k, l]) => `<button onclick="NT.coTab['${co.id}']='${k}'; ntShowCompany($('nt-company-page'), ntNode('${co.id}'))" class="px-3 py-1.5 rounded-lg text-xs font-semibold ${tab === k ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-white'}">${l}</button>`).join('')}
      ${extra.map(n => `<button onclick="ntSelect('company','${n.id}')" class="px-3 py-1.5 rounded-lg text-xs text-slate-400 hover:text-white">${esc(n.title)}</button>`).join('')}</div>
    <div id="nt-co-body" class="mt-4"></div>`;
  ntDestroyEditor(); NT.cur = null;
  try { history.replaceState(null, '', `#tab6/company/${co.id}`); } catch (e) {}
  const body = $('nt-co-body');
  if (tab === 'overview' || tab === 'news') {
    const re = tab === 'overview' ? /^(개요|overview)$/i : /^news\s*flow$/i;
    const child = ntKids(co.id).find(n => re.test((n.title || '').trim()));
    if (!child) { body.innerHTML = `<div class="text-sm text-slate-500 py-8 text-center">${tab === 'overview' ? '개요' : 'News Flow'} 페이지가 없습니다 ${NT.canEdit ? `<button onclick="ntMakeSub('${co.id}','${tab === 'overview' ? '개요' : 'News Flow'}')" class="ml-2 px-3 py-1 rounded-lg bg-blue-600 text-white text-xs">만들기</button>` : ''}</div>`; return; }
    return ntInlinePage(body, child.id);
  }
  if (tab === 'quarters') return ntRenderQuarters(body, co);
  return ntRenderCompanyTable(body, co);
}
async function ntMakeSub(coId, title) { await ntPost('node', { op: 'create', parent_id: coId, title }); await ntLoadTree(true); ntShowCompany($('nt-company-page'), ntNode(coId)); }
async function ntRenameCompany(id) {
  const n = ntNode(id); const t = prompt('기업 이름 — 형식: 회사명 (티커 US)', n.title); if (!t) return;
  await ntPost('node', { op: 'rename', id, title: t }); n.title = t; ntDrawTree('company'); ntShowCompany($('nt-company-page'), n);
}
async function ntInlinePage(body, id) {
  body.innerHTML = '<div class="text-sm text-slate-500 py-8 text-center">불러오는 중…</div>';
  const pg = await ntApi('page?id=' + id).catch(e => ({ error: e.message }));
  if (pg.error) { body.innerHTML = `<div class="text-rose-300 text-sm">${esc(pg.error)}</div>`; return; }
  body.innerHTML = `<div class="flex items-center gap-2 text-[11px] text-slate-500 mb-2"><span>수정 ${esc(ntFmtDate(pg.updated_at))}</span><span id="nt-save" class="ml-auto"></span>${NT.canEdit ? `<button onclick="ntRevisions('${id}')" class="px-2 py-1 rounded-md border border-slate-700 text-slate-300 hover:text-white">이전 버전</button>` : ''}<button onclick="ntSelect('company','${id}')" class="px-2 py-1 rounded-md border border-slate-700 text-slate-300 hover:text-white">페이지로 열기</button></div>
    ${pg.cover ? `<div class="h-32 bg-cover bg-center rounded-xl mb-4" style="background-image:url('${esc(pg.cover)}')"></div>` : ''}<div id="nt-ed" class="${NT.canEdit ? '' : 'ne-ro'}"></div>`;
  ntMountEditor($('nt-ed'), pg);
}
const ntEarnFolder = co => ntKids(co.id).find(n => /^earnings$/i.test((n.title || '').trim()));
function ntQuarterPages(co) {
  const f = ntEarnFolder(co); if (!f) return [];
  return ntKids(f.id).map(n => ({ n, k: ntQKey(n.title) })).sort((a, b) => (b.k ?? -1) - (a.k ?? -1));
}
function ntRenderQuarters(body, co) {
  const qs = ntQuarterPages(co); const f = ntEarnFolder(co);
  body.innerHTML = `<div class="flex items-center justify-between mb-3"><div class="text-xs text-slate-400">분기 실적 페이지 ${qs.length}개</div>${NT.canEdit ? `<button onclick="ntAddQuarter('${f ? f.id : ''}','${co.id}')" class="px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold">＋ 새 분기 실적</button>` : ''}</div>
    <div class="grid sm:grid-cols-2 gap-2">${qs.map(({ n, k }) => `<button onclick="ntSelect('company','${n.id}')" class="text-left bg-slate-950/60 border border-slate-800 hover:border-blue-600 rounded-xl px-4 py-3">
      <div class="font-mono text-sm font-bold text-white">${esc(ntQLabel(k) !== '-' ? ntQLabel(k) : ntShortTitle(n.title))}</div><div class="mt-1">${ntTags(n.title) || '<span class="text-[11px] text-slate-500">' + esc(n.title) + '</span>'}</div><div class="text-[10px] text-slate-500 mt-1">수정 ${esc(ntFmtDate(n.updated_at))}</div></button>`).join('') || '<div class="text-sm text-slate-500">아직 분기 실적 페이지가 없습니다</div>'}</div>`;
}
async function ntAddQuarter(folderId, coId) {
  let fid = folderId;
  const co = coId ? ntNode(coId) : ntCompanyOf(folderId);
  if (!fid && co) { const j = await ntPost('node', { op: 'create', parent_id: co.id, title: 'Earnings' }); fid = j.id; }
  const qs = co ? ntQuarterPages(co) : [];
  const last = qs.find(x => x.k != null);
  const next = last ? last.k + 1 : null;
  const title = prompt('새 분기 페이지 제목 — 예: 2027 4Q (Beat; 가이던스 Beat)\n(결과는 나중에 제목에서 고쳐도 됩니다)', next != null ? `${ntQLabel(next)} ()` : '');
  if (!title) return;
  let html = '';
  const useTpl = last && confirm(`직전 분기(${ntQLabel(last.k)}) 페이지의 형식(항목명·색상·구조)을 복사하고 숫자만 비울까요?\n[확인] 형식 복사  [취소] 빈 페이지`);
  if (useTpl) { try { const pg = await ntApi('page?id=' + last.n.id); html = ntQuarterTemplate(pg.html); } catch (e) {} }
  const j = await ntPost('node', { op: 'create', parent_id: fid, title, html, first: false });
  await ntLoadTree(true); NT.open.add(fid); NT.sel.company = j.id; ntDrawTree('company'); ntShow('company', j.id);
}
function ntQuarterTemplate(html) {
  const doc = new DOMParser().parseFromString(html || '', 'text/html');
  const b = doc.body; const top = [...b.children];
  let cut = top.findIndex(el => /^(UL|OL)$/.test(el.tagName) && /재무제표|Income Statement|손익/i.test(el.textContent));
  if (cut < 0) cut = top.findIndex(el => /^(UL|OL)$/.test(el.tagName));
  if (cut >= 0) top.slice(cut + 1).forEach(el => el.remove());
  b.querySelectorAll('a[href*=".pdf"], img').forEach(el => (el.closest('p') || el).remove());
  b.querySelectorAll('li').forEach(li => {
    const p = [...li.children].find(c => c.tagName === 'P');
    if (p && /conference|컨퍼런스|콜 주요/i.test(p.textContent)) [...li.children].filter(c => c !== p).forEach(c => c.remove());
  });
  const walker = doc.createTreeWalker(b, NodeFilter.SHOW_TEXT); const ts = []; while (walker.nextNode()) ts.push(walker.currentNode);
  ts.forEach(t => { t.nodeValue = t.nodeValue.replace(/\s*,\s*[+-]?\d[\d,]*(?:\.\d+)?\s*%\s*QoQ/gi, m0 => /NTM|Market\s*Cap/i.test(t.parentElement?.closest('p,li,h1,h2,h3,h4')?.textContent || '') ? '' : m0); });
  // (Guidance) 아래 내용은 직전 분기 수치를 그대로 둔다 → 새 분기 가이던스와 비교(상향/하향)용
  const ownText = li => { const p = [...li.children].find(c => c.tagName === 'P'); return (p || li).textContent || ''; };
  const inGuidance = t => { let e = t.parentElement; while (e && e !== b) { if (e.tagName === 'LI' && /guidance|가이던스/i.test(ownText(e))) return true; e = e.parentElement; } return false; };
  ts.forEach(t => {
    if (inGuidance(t)) return;
    t.nodeValue = t.nodeValue
      .replace(/\s*[+-]?\d[\d,]*(?:\.\d+)?\s*(?:%|bp)\s*(상회|하회|부합)(?=[\s,)]|$)/g, '')
      .replace(/^\s*[+-]?\d[\d,]*(?:\.\d+)?\s*(?:%|bp)\s*(상회|하회|부합)\s*$/, '')
      .replace(/(\d{4})\s*년\s*\d{1,2}\s*월\s*\d{1,2}\s*일\s*발표/, 'YYYY년 M월 D일 발표')
      .replace(/(\s?)[+-]?(\$?)-?[\d,]*\.?\d+(\s*[~～]\s*[\d,]*\.?\d+)?(?![\d.]*\s*Q\b)/g, (m0, sp, d) => sp + d)
      .replace(/(흑전|적전|적지|흑지)\s*(YoY|QoQ)/g, '% $2')
      .replace(/\s*(상회|하회|부합)(?=[\s,)]|$)/g, '');
  });
  return b.innerHTML;
}
async function ntCompanyQuarters(co, force) {
  const f = ntEarnFolder(co); if (!f) return [];
  const ck = co.id; if (!force && NT.coCache.has(ck)) return NT.coCache.get(ck);
  const j = await ntApi('bulk?parent=' + f.id);
  const rows = j.pages.map(p => ({ id: p.id, title: p.title, k: ntQKey(p.title), ...ntParseEarnings(p.html) })).filter(x => x.k != null).sort((a, b) => a.k - b.k);
  NT.coCache.set(ck, rows); return rows;
}
async function ntRenderCompanyTable(body, co, mode) {
  mode = mode || NT.coTab[co.id + ':mode'] || 'latest';
  NT.coTab[co.id + ':mode'] = mode;
  body.innerHTML = '<div class="text-sm text-slate-500 py-8 text-center">분기 페이지의 숫자를 읽는 중…</div>';
  let qs; try { qs = await ntCompanyQuarters(co, mode === 'refresh'); } catch (e) { body.innerHTML = `<div class="text-rose-300 text-sm">${esc(e.message)}</div>`; return; }
  if (mode === 'refresh') { mode = 'latest'; NT.coTab[co.id + ':mode'] = mode; }
  if (!qs.length) { body.innerHTML = `<div class="text-sm text-slate-500 py-8 text-center">숫자를 읽을 분기 실적 페이지가 없습니다.<br><span class="text-xs">페이지 제목에 "2027 3Q"처럼 연도·분기가 있고, 본문이 "항목 $금액, +x% YoY, 컨센서스($…) 상회" 형식이면 자동으로 표가 만들어집니다.</span></div>`; return; }
  const byK = new Map(qs.map(q => [q.k, q])); const latest = qs[qs.length - 1];
  const get = (q, key) => q?.items.find(i => i.key === key);
  // 행 순서: 최신 분기 순서 → 과거에만 있는 항목 뒤에
  const keys = []; const seen = new Set();
  [latest, ...qs.slice(0, -1).reverse()].forEach(q => q.items.forEach(i => { if (!seen.has(i.key)) { seen.add(i.key); keys.push(i); } }));
  const modeBtn = (k, l) => `<button onclick="ntRenderCompanyTable($('nt-co-body'), ntNode('${co.id}'), '${k}')" class="px-3 py-1 rounded-lg text-xs font-semibold ${mode === k ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-white'}">${l}</button>`;
  const head = `<div class="flex flex-wrap items-center justify-between gap-2 mb-3"><div class="flex flex-wrap gap-1 bg-slate-950 border border-slate-800 rounded-lg p-1">${modeBtn('latest', '최신 분기 한눈에')}${modeBtn('val', '분기별 값')}${modeBtn('yoy', '분기별 YoY')}${modeBtn('qoq', '분기별 QoQ')}</div>
    <div class="flex items-center gap-2 text-[11px] text-slate-500"><span>${qs.length}개 분기 · 금액 백만 달러, 마진은 bp 변화</span><button onclick="ntRenderCompanyTable($('nt-co-body'), ntNode('${co.id}'), 'refresh')" class="px-2 py-1 rounded-md border border-slate-700 text-slate-300 hover:text-white">다시 읽기</button></div></div>`;
  const secRow = (sec, cols) => `<tr class="bg-slate-900/70"><td colspan="${cols}" class="sticky-col py-1.5 px-3 text-[10px] font-bold text-slate-400 uppercase tracking-wide">${esc(sec || '기타')}</td></tr>`;
  const info = `<div class="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">${[['분기', ntQLabel(latest.k)], ['발표일', latest.date || '-'], ['NTM P/E', isNum(latest.ntmPE) ? latest.ntmPE.toFixed(2) + 'x' : '-'], ['시가총액(기재)', isNum(latest.mktCap) ? '$' + latest.mktCap.toLocaleString('en-US', { maximumFractionDigits: 0 }) + 'M' : '-']].map(([l, v]) => `<div class="bg-slate-950/60 border border-slate-800 rounded-xl px-3 py-2"><div class="text-[10px] text-slate-500">${l}</div><div class="font-num text-sm font-bold text-white">${esc(v)}</div></div>`).join('')}</div>
    <div class="text-[11px] mb-3">${ntTags(qs[qs.length - 1].title)}</div>`;
  let table;
  if (mode === 'latest') {
    const spark = key => {
      const vals = qs.slice(-8).map(q => get(q, key)?.v); const nums = vals.filter(isNum); if (nums.length < 2) return '';
      const mx = Math.max(...nums.map(Math.abs)) || 1;
      return `<div class="flex items-end gap-[2px] h-6">${vals.map(v => `<span title="${isNum(v) ? v : '-'}" style="width:6px;height:${isNum(v) ? Math.max(2, Math.abs(v) / mx * 24) : 1}px" class="${isNum(v) ? (v < 0 ? 'bg-rose-500/70' : 'bg-blue-400/70') : 'bg-slate-800'}"></span>`).join('')}</div>`;
    };
    let last = null;
    table = `<table class="nt-kpi w-full text-xs"><thead><tr class="text-slate-400 border-b border-slate-800"><th class="sticky-col text-left py-2 px-3">항목 (${esc(ntQLabel(latest.k))})</th><th class="text-right px-3">값</th><th class="text-right px-3">YoY</th><th class="text-right px-3">QoQ</th><th class="text-left px-3">컨센서스</th><th class="px-3 text-left">최근 8분기</th></tr></thead><tbody class="divide-y divide-slate-800/60">
      ${latest.items.map(it => {
        const s = it.sec !== last ? secRow(it.sec, 6) : ''; last = it.sec;
        const y = get(byK.get(latest.k - 4), it.key), q = get(byK.get(latest.k - 1), it.key);
        return s + `<tr class="hover:bg-slate-800/40"><td class="sticky-col py-1.5 px-3 ${it.depth ? 'text-slate-400' : 'text-slate-200'}" style="padding-left:${12 + (it.depth || 0) * 14}px">${it.depth ? '└ ' : ''}${esc(it.name)}</td><td class="text-right px-3 font-num font-semibold text-white">${ntFmtVal(it)}${it.range ? '<sup class="text-slate-500">범위</sup>' : ''}</td>
          <td class="text-right px-3">${ntChgHtml(it, it, y, it.yoy)}</td><td class="text-right px-3">${ntChgHtml(it, it, q, it.qoq)}</td>
          <td class="px-3">${it.beat ? `<span class="nt-tag ${it.beat === '상회' ? 'beat' : it.beat === '하회' ? 'miss' : 'inline'}">${esc(it.beat)}</span>` : ''} <span class="text-slate-500 font-num">${esc(it.consTxt || '')}</span>${isNum(it.cons) && isNum(it.v) && it.unit !== '%' && it.cons ? ` <span class="text-[10px] ${it.v >= it.cons ? 'nt-up' : 'nt-dn'}">(${((it.v / (it.isMn ? it.cons : it.cons) - 1) * 100).toFixed(1)}%)</span>` : (it.unit === '%' && isNum(it.cons) ? ` <span class="text-[10px] ${it.v >= it.cons ? 'nt-up' : 'nt-dn'}">(${((it.v - it.cons) * 100).toFixed(0)}bp)</span>` : '')}</td>
          <td class="px-3">${spark(it.key)}</td></tr>`;
      }).join('')}</tbody></table>`;
  } else {
    const cols = qs.slice(-12);
    let last = null;
    table = `<table class="nt-kpi w-full text-xs"><thead><tr class="text-slate-400 border-b border-slate-800"><th class="sticky-col text-left py-2 px-3">항목</th>${cols.map(q => `<th class="text-right px-3"><button onclick="ntSelect('company','${q.id}')" class="hover:text-white font-mono">${esc(ntQLabel(q.k))}</button></th>`).join('')}</tr></thead><tbody class="divide-y divide-slate-800/60">
      ${keys.map(k0 => {
        const s = k0.sec !== last ? secRow(k0.sec, cols.length + 1) : ''; last = k0.sec;
        return s + `<tr class="hover:bg-slate-800/40"><td class="sticky-col py-1.5 px-3 ${k0.depth ? 'text-slate-400' : 'text-slate-200'}" style="padding-left:${12 + (k0.depth || 0) * 14}px">${k0.depth ? '└ ' : ''}${esc(k0.name)}</td>${cols.map(q => {
          const it = get(q, k0.key); if (!it) return '<td class="text-right px-3 nt-mu">-</td>';
          if (mode === 'val') return `<td class="text-right px-3 font-num text-white">${ntFmtVal(it)}</td>`;
          const prev = get(byK.get(q.k - (mode === 'yoy' ? 4 : 1)), k0.key);
          return `<td class="text-right px-3">${ntChgHtml(it, it, prev, mode === 'yoy' ? it.yoy : it.qoq)}</td>`;
        }).join('')}</tr>`;
      }).join('')}</tbody></table>`;
  }
  body.innerHTML = head + info + `<div class="overflow-x-auto border border-slate-800 rounded-xl">${table}</div>
    <p class="text-[10px] text-slate-500 mt-2">YoY·QoQ는 같은 기업의 이전 분기 페이지 숫자로 직접 계산합니다(마진·비율은 bp 차이). 이전 분기 페이지가 없으면 본문에 적힌 수치를 쓰고 <sup>*</sup>로 표시합니다. 가이던스·컨퍼런스콜 항목은 제외됩니다.</p>`;
}

// ------------------------------------------------------------------ 07-0 통합
async function ntRenderOverview(host) {
  const mrRoot = ntMrRoot(), coRoot = ntCoRoot();
  const companies = []; const walk = id => ntKids(id).forEach(n => { if (ntTicker(n)) companies.push(n); else walk(n.id); }); if (coRoot) walk(coRoot.id);
  const quarters = [];
  companies.forEach(c => { const f = ntEarnFolder(c); if (f) ntKids(f.id).forEach(q => quarters.push({ q, c, k: ntQKey(q.title) })); });
  quarters.sort((a, b) => String(b.q.updated_at || '').localeCompare(String(a.q.updated_at || '')));
  const latest = ntLatestMr();
  host.innerHTML = `<div class="grid xl:grid-cols-5 gap-5">
    <div class="xl:col-span-3 bg-terminal-panel border border-terminal-border rounded-2xl p-5">
      <div class="flex items-center justify-between mb-3"><div><div class="text-sm font-bold text-white">최신 Market Review</div><div class="text-[11px] text-slate-500">${esc(latest ? ntPath(latest.id).slice(1).map(p => p.title).join(' › ') : '-')}</div></div>
      ${latest ? `<button onclick="ntGo('${latest.id}')" class="px-3 py-1.5 rounded-lg border border-slate-700 text-xs text-slate-300 hover:text-white">전체 보기 →</button>` : ''}</div>
      <div id="nt-ov-mr" class="ne-ro text-sm"><div class="text-slate-500 text-sm">불러오는 중…</div></div></div>
    <div class="xl:col-span-2 space-y-5">
      <div class="bg-terminal-panel border border-terminal-border rounded-2xl p-5">
        <div class="text-sm font-bold text-white mb-2">노트 검색</div>
        <input id="nt-search" placeholder="두 글자 이상 (예: HBM, 가이던스, NVDA)" onkeydown="if(event.key==='Enter') ntSearch()" class="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-blue-500">
        <div id="nt-search-res" class="mt-2 space-y-1 max-h-80 overflow-y-auto"></div></div>
      <div class="bg-terminal-panel border border-terminal-border rounded-2xl p-5">
        <div class="flex items-center justify-between mb-2"><div class="text-sm font-bold text-white">최근 수정된 분기 실적</div><span class="text-[11px] text-slate-500">기업 ${companies.length}곳 · 분기 페이지 ${quarters.length}개</span></div>
        <div class="divide-y divide-slate-800/60">${quarters.slice(0, 14).map(({ q, c, k }) => `<button onclick="ntGo('${q.id}')" class="w-full text-left py-2 flex items-center gap-2 hover:bg-slate-800/40 px-1 rounded">
          <span class="font-mono text-xs font-bold text-blue-300 w-14 shrink-0">${esc(ntTicker(c))}</span><span class="text-xs text-white w-16 shrink-0 font-mono">${esc(ntQLabel(k))}</span><span class="flex-1 truncate">${ntTags(q.title)}</span><span class="text-[10px] text-slate-500">${esc(String(q.updated_at || '').slice(5, 10))}</span></button>`).join('') || '<div class="text-xs text-slate-500 py-2">없음</div>'}</div></div>
      <div class="flex flex-wrap gap-2 text-xs">
        <span class="px-3 py-2 rounded-lg bg-slate-900 border border-slate-800 text-slate-400">전체 페이지 ${NT.nodes.size.toLocaleString()}개</span>
        <span class="px-3 py-2 rounded-lg bg-slate-900 border border-slate-800 text-slate-400">${NT.canEdit ? '✏️ 편집 가능' : '👀 읽기 전용'}</span>
        ${NT.canEdit ? '<button onclick="ntTrash()" class="px-3 py-2 rounded-lg bg-slate-900 border border-slate-800 text-slate-300 hover:text-white">🗑 휴지통</button>' : ''}
        <button onclick="ntLoadTree(true).then(() => renderNotes('overview'))" class="px-3 py-2 rounded-lg bg-slate-900 border border-slate-800 text-slate-300 hover:text-white">새로고침</button></div>
    </div></div>`;
  if (latest) {
    try {
      const pg = await ntApi('page?id=' + latest.id);
      const doc = new DOMParser().parseFromString(pg.html || '', 'text/html');
      const top = [...doc.body.children];
      const idx = top.map((el, i) => /Market Review\s*[-–]\s*\d{4}년/.test(el.textContent) && el.textContent.length < 80 ? i : -1).filter(i => i >= 0);
      let part = pg.html;
      if (idx.length) { const st = idx[idx.length - 1]; const wrap = doc.createElement('div'); top.slice(st).forEach(el => wrap.appendChild(el)); part = wrap.innerHTML; if (wrap.textContent.trim().length < 40 && idx.length > 1) { const w2 = doc.createElement('div'); new DOMParser().parseFromString(pg.html, 'text/html').body.childNodes.forEach((el, i) => { if (i >= idx[idx.length - 2] && i < st) w2.appendChild(el.cloneNode(true)); }); part = w2.innerHTML + part; } }
      const box = $('nt-ov-mr'); box.innerHTML = '';
      NoteEditor.create(box, { html: part, editable: false });
    } catch (e) { $('nt-ov-mr').innerHTML = `<div class="text-rose-300 text-sm">${esc(e.message)}</div>`; }
  } else $('nt-ov-mr').innerHTML = '<div class="text-slate-500 text-sm">Market Review가 없습니다</div>';
}
async function ntSearch() {
  const q = $('nt-search').value.trim(); const box = $('nt-search-res');
  if (q.length < 2) { box.innerHTML = '<div class="text-xs text-slate-500">두 글자 이상 입력하세요</div>'; return; }
  box.innerHTML = '<div class="text-xs text-slate-500">찾는 중…</div>';
  try {
    const j = await ntApi('search?q=' + encodeURIComponent(q));
    const hl = s => esc(s).replace(new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), m => `<mark class="bg-amber-400/30 text-amber-100">${m}</mark>`);
    box.innerHTML = j.results.map(r => `<button onclick="ntGo('${r.id}')" class="w-full text-left px-2 py-2 rounded-lg hover:bg-slate-800/60"><div class="text-[10px] text-slate-500">${esc(ntPath(r.id).slice(0, -1).map(p => ntShortTitle(p.title)).join(' › '))}</div><div class="text-xs text-white font-semibold">${hl(r.title)}</div><div class="text-[11px] text-slate-400 line-clamp-2">${hl(r.snip || '')}</div></button>`).join('') || '<div class="text-xs text-slate-500">결과 없음</div>';
  } catch (e) { box.innerHTML = `<div class="text-xs text-rose-300">${esc(e.message)}</div>`; }
}
async function ntTrash() {
  ntModal('휴지통', '<div class="text-slate-500 text-sm">불러오는 중…</div>');
  const j = await ntApi('tree?trash=1');
  $('nt-modal-body').innerHTML = j.nodes.length ? j.nodes.map(n => `<div class="flex items-center justify-between py-2 border-b border-slate-800 text-sm"><span class="text-slate-200">${esc(n.title)}</span><span class="flex items-center gap-2"><span class="text-[10px] text-slate-500">${esc(ntFmtDate(n.deleted_at))}</span><button onclick="ntRestore('${n.id}')" class="px-2 py-1 rounded-md bg-blue-600 text-white text-xs">되살리기</button></span></div>`).join('') : '<div class="text-slate-500 text-sm">비어 있습니다</div>';
}
async function ntRestore(id) { await ntPost('node', { op: 'restore', id }); await ntLoadTree(true); ntTrash(); }

// ------------------------------------------------------------------ 07-3 섹터별 실적 요약표
function ntPick(items, re, unit) { return items.find(i => re.test(i.name) && (!unit || i.unit === unit) && !/non-?gaap|adj/i.test(i.sec)) || items.find(i => re.test(i.name) && (!unit || i.unit === unit)); }
async function ntRenderSectorTable(host) {
  const coRoot = ntCoRoot(); if (!coRoot) { host.innerHTML = '<div class="text-slate-500 text-sm">기업 분석 폴더가 없습니다</div>'; return; }
  const sectors = ntKids(coRoot.id);
  if (!NT.tblSector || !ntNode(NT.tblSector)) NT.tblSector = sectors[0]?.id;
  host.innerHTML = `<div class="bg-terminal-panel border border-terminal-border rounded-2xl p-5">
    <div class="flex flex-wrap items-center justify-between gap-3 mb-4"><div class="flex flex-wrap gap-1.5">${sectors.map(s => `<button onclick="NT.tblSector='${s.id}'; renderNotes('table')" class="px-3 py-1.5 rounded-lg text-xs font-semibold ${s.id === NT.tblSector ? 'bg-blue-600 text-white' : 'bg-slate-900 border border-slate-800 text-slate-400 hover:text-white'}">${esc(s.title)}</button>`).join('')}</div>
    <span class="text-[11px] text-slate-500">각 기업의 가장 최근 분기 페이지 기준</span></div>
    <div id="nt-tb-body" class="overflow-x-auto"><div class="text-sm text-slate-500 py-8 text-center">불러오는 중…</div></div></div>`;
  const companies = []; const walk = id => ntKids(id).forEach(n => { if (ntTicker(n)) companies.push(n); else walk(n.id); }); walk(NT.tblSector);
  const latest = companies.map(c => ({ c, q: ntQuarterPages(c).find(x => x.k != null) })).filter(x => x.q);
  let pages = NT.tblCache.get(NT.tblSector);
  if (!pages) {
    pages = new Map();
    for (let i = 0; i < latest.length; i += 60) {
      const j = await ntApi('bulk?ids=' + latest.slice(i, i + 60).map(x => x.q.n.id).join(','));
      j.pages.forEach(p => pages.set(p.id, ntParseEarnings(p.html)));
    }
    NT.tblCache.set(NT.tblSector, pages);
  }
  const rows = latest.map(({ c, q }) => {
    const p = pages.get(q.n.id) || { items: [] }; const it = p.items;
    return { c, q, p, rev: ntPick(it, /^(total\s+)?(net\s+)?(revenue|revenues|sales|net sales|매출)/i, '$'), gpm: ntPick(it, /(gp|gross).*margin|매출총이익률/i, '%'), opm: ntPick(it, /(op|operating).*margin|영업이익률/i, '%'),
      eps: it.find(i => /eps/i.test(i.name) && /non-?gaap|adj/i.test(i.sec + i.name)) || ntPick(it, /eps/i) };
  });
  const cell = (it, kind) => {
    if (!it) return '<td class="px-3 text-right nt-mu">-</td>';
    const chg = it.yoy ? (it.yoy.t ? `<span class="${/흑/.test(it.yoy.t) ? 'nt-up' : 'nt-dn'}">${esc(it.yoy.t)}</span>` : ntSigned(it.yoy.v, it.yoy.u === '%p' ? 'bp' : it.yoy.u, it.yoy.u === 'bp' ? 0 : 1, it.yoy.u === '%p' ? 100 : 1)) : '<span class="nt-mu">-</span>';
    const b = it.beat ? `<span class="nt-tag ${it.beat === '상회' ? 'beat' : it.beat === '하회' ? 'miss' : 'inline'} ml-1">${esc(it.beat)}</span>` : '';
    return `<td class="px-3 text-right whitespace-nowrap"><span class="font-num text-white">${ntFmtVal(it)}</span> <span class="text-[11px]">${chg}</span>${b}</td>`;
  };
  $('nt-tb-body').innerHTML = rows.length ? `<table class="nt-kpi w-full text-xs"><thead><tr class="text-slate-400 border-b border-slate-800"><th class="sticky-col text-left py-2 px-3">기업</th><th class="px-3 text-left">분기</th><th class="px-3 text-left">결과</th><th class="px-3 text-left">발표일</th><th class="px-3 text-right">매출 (YoY)</th><th class="px-3 text-right">GPM (YoY)</th><th class="px-3 text-right">OPM (YoY)</th><th class="px-3 text-right">EPS (YoY)</th><th class="px-3 text-right">NTM P/E</th></tr></thead>
    <tbody class="divide-y divide-slate-800/60">${rows.map(r => `<tr class="hover:bg-slate-800/40 cursor-pointer" onclick="NT.coTab['${r.c.id}']='table'; ntGo('${r.c.id}')">
      <td class="sticky-col py-2 px-3"><span class="font-mono font-bold text-blue-300">${esc(ntTicker(r.c))}</span> <span class="text-slate-400">${esc(ntShortTitle(r.c.title).replace(/,?\s*(Inc\.?|Corporation|Corp\.?|Holdings?|Ltd\.?|PLC|N\.?V\.?)\b.*$/i, ''))}</span></td>
      <td class="px-3 font-mono text-white">${esc(ntQLabel(r.q.k))}</td><td class="px-3">${ntTags(r.q.n.title)}</td><td class="px-3 text-slate-400 font-mono">${esc(r.p.date || '-')}</td>
      ${cell(r.rev)}${cell(r.gpm)}${cell(r.opm)}${cell(r.eps)}<td class="px-3 text-right font-num text-slate-200">${isNum(r.p.ntmPE) ? r.p.ntmPE.toFixed(1) + 'x' : '-'}</td></tr>`).join('')}</tbody></table>
    <p class="text-[10px] text-slate-500 mt-2">값 옆 YoY·컨센서스 결과는 분기 페이지 본문에 적힌 수치입니다. 행을 누르면 기업별 실적 표로 이동합니다. 분기 페이지가 없는 기업 ${companies.length - rows.length}곳은 빠졌습니다.</p>`
    : '<div class="text-sm text-slate-500 py-8 text-center">이 섹터에는 분기 실적 페이지가 있는 기업이 없습니다</div>';
}

// ------------------------------------------------------------------ 컨퍼런스콜 AI 정리 ([컨퍼런스 콜 최근 트렌드] · [이번 분기 컨콜 전분기 대비 변화])
const NT_AI_T1 = '[컨퍼런스 콜 최근 트렌드]', NT_AI_T2 = '[이번 분기 컨콜 전분기 대비 변화]';
async function ntAiConcall(id) {
  if (!NT.ed || NT.cur?.id !== id) return;
  const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('컨콜 정리 추가'));
  const old = btn?.textContent; if (btn) { btn.disabled = true; btn.textContent = '🤖 정리 중… (최대 1분)'; }
  try {
    await ntFlush();
    const j = await ntApi('ai', { method: 'POST', body: JSON.stringify({ id, html: NT.ed.getHTML() }) });
    if (!NT.ed || NT.cur?.id !== id) return;
    const li = t => `<li><p>${esc(t)}</p></li>`;
    const dirTag = d => `<span style="color: ${/개선|신규/.test(d) ? '#a3e635' : /악화|축소/.test(d) ? '#f87171' : '#cbd5e1'}">${esc(d || '')}</span>`;
    const trend = (j.trend || []).filter(t => t.topic && (t.points || []).length).map(t => `<li><p><strong>${esc(t.topic)}</strong></p><ul>${t.points.map(li).join('')}</ul></li>`).join('');
    const chg = (j.change || []).filter(c => c.topic).map(c => `<li><p><strong>${esc(c.topic)}</strong> — ${dirTag(c.direction)}</p><ul>${c.before ? `<li><p>${esc(j.quarters?.[1] || '직전 분기')}: ${esc(c.before)}</p></li>` : ''}<li><p>${esc(j.quarters?.[0] || '이번 분기')}: ${esc(c.now || '')}</p></li></ul></li>`).join('');
    const basis = `<p><em><span style="color: #9b9a97">🤖 AI 정리(${esc(j.model || 'Gemini')}) · 근거: 이 기업 ${esc((j.quarters || []).join(', '))} 페이지의 컨퍼런스콜 노트만 사용 · 확인 후 고쳐 쓰세요</span></em></p>`;
    const add = `<hr><h3>${NT_AI_T1}</h3>${basis}<ul>${trend || li('정리할 내용이 없습니다')}</ul><h3>${NT_AI_T2}</h3><ul>${chg || li((j.quarters || []).length < 2 ? '직전 분기 컨퍼런스콜 노트가 없어 비교하지 못했습니다' : '정리할 내용이 없습니다')}</ul>${j.note ? `<p><em><span style="color: #cb912f">⚠️ ${esc(j.note)}</span></em></p>` : ''}`;
    // 예전에 넣은 AI 정리가 있으면 그 부분만 새것으로 바꾼다
    const doc = new DOMParser().parseFromString(NT.ed.getHTML(), 'text/html'), bd = doc.body, kids = [...bd.children];
    const i1 = kids.findIndex(el => /^H[1-4]$/.test(el.tagName) && el.textContent.trim() === NT_AI_T1);
    if (i1 >= 0) {
      let i = i1; if (kids[i - 1]?.tagName === 'HR') i--;
      let end = kids.length;
      for (let x = i1 + 1; x < kids.length; x++) { const el = kids[x]; if (/^H[1-4]$/.test(el.tagName) && el.textContent.trim() !== NT_AI_T2) { end = x; break; } }
      const tmp = doc.createElement('div'); tmp.innerHTML = add;
      kids.slice(i, end).forEach((el, n) => { if (n === 0) el.replaceWith(...tmp.childNodes); else el.remove(); });
      NT.ed.commands.setContent(bd.innerHTML, { emitUpdate: true });
    } else NT.ed.chain().focus('end').insertContent(add).run();
    NT.cur.dirty = true; ntSave();
    const h = [...document.querySelectorAll('#nt-ed h3')].find(x => x.textContent.trim() === NT_AI_T1); h?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) { alert('컨콜 정리 실패: ' + e.message); }
  finally { if (btn) { btn.disabled = false; btn.textContent = old; } }
}
