"""Notion → AlphaDesk(07 노트, Cloudflare D1) 이관 스크립트.

- Equity 페이지 아래 하위 페이지 전체를 같은 트리 구조로 옮긴다 (노드 id = Notion 페이지 id).
- Notion 블록을 편집기(TipTap)가 읽는 HTML로 변환한다. 서식(굵게·색상·목록·토글·표·콜아웃)을 유지.
- Notion에 올린 이미지/파일은 D1 files 표에 저장한다(1.9MB 초과 이미지는 줄여서 저장).
- AlphaDesk에서 한 번이라도 수정한 페이지(source='app')는 덮어쓰지 않는다.
- 이미 옮긴 페이지는 Notion 수정 시각이 같으면 다시 받지 않는다 → 중간에 끊겨도 다음 실행이 이어 받는다.

환경변수: NOTION_TOKEN (필수), NOTION_ROOT (기본: config.json notion_root), IMPORT_BUDGET_MIN (기본 330분)
실행: python notion_import.py  (wrangler·D1 바인딩이 있는 작업 폴더에서)
"""
from __future__ import annotations

import hashlib
import html
import io
import json
import os
import re
import subprocess
import sys
import tempfile
import time

import requests

API = "https://api.notion.com/v1"
NV = "2022-06-28"
DB_NAME = "alphadesk-notes"
MAX_FILE = 1_900_000
STMT_BYTES = 80_000
T0 = time.time()
BUDGET = float(os.environ.get("IMPORT_BUDGET_MIN", "330")) * 60

TEXT_COLORS = {"gray": "#9b9a97", "brown": "#ba856f", "orange": "#d9730d", "yellow": "#cb912f", "green": "#4dab9a",
               "blue": "#529cca", "purple": "#9a6dd7", "pink": "#e255a1", "red": "#e03e3e"}
BG_COLORS = {"gray": "rgba(155,154,151,0.22)", "brown": "rgba(186,133,111,0.25)", "orange": "rgba(217,115,13,0.25)",
             "yellow": "rgba(223,171,1,0.25)", "green": "rgba(77,171,154,0.25)", "blue": "rgba(82,156,202,0.25)",
             "purple": "rgba(154,109,215,0.25)", "pink": "rgba(226,85,161,0.25)", "red": "rgba(224,62,62,0.25)"}

S = requests.Session()
_last = [0.0]
CALLS = [0]


def nid(x: str) -> str:
    return (x or "").replace("-", "").lower()


def notion(method: str, path: str, **kw):
    """요청 1건 (초당 약 2.8회로 제한, 429/5xx 재시도)."""
    for attempt in range(8):
        wait = 0.36 - (time.time() - _last[0])
        if wait > 0:
            time.sleep(wait)
        _last[0] = time.time()
        CALLS[0] += 1
        try:
            r = S.request(method, API + path, timeout=60, **kw)
        except requests.RequestException as e:
            time.sleep(2 + attempt * 3)
            continue
        if r.status_code == 429 or r.status_code >= 500:
            time.sleep(float(r.headers.get("Retry-After", 2 + attempt * 3)))
            continue
        if r.status_code >= 400:
            raise RuntimeError(f"Notion {r.status_code} {path}: {r.text[:300]}")
        return r.json()
    raise RuntimeError(f"Notion 재시도 초과: {path}")


def children(block_id: str) -> list:
    out, cur = [], None
    while True:
        q = {"page_size": 100}
        if cur:
            q["start_cursor"] = cur
        j = notion("GET", f"/blocks/{block_id}/children", params=q)
        out += j.get("results", [])
        if not j.get("has_more"):
            return out
        cur = j.get("next_cursor")


# ------------------------------------------------------------------ 파일 저장(D1 files)
PENDING_FILES: list[tuple[str, str, str, bytes, str]] = []  # (id, mime, name, data, src)
KNOWN_FILES: set[str] = set()


def store_file(key: str, url: str, name_hint: str, image: bool):
    """Notion 파일을 내려받아 D1에 넣을 준비. 성공하면 앱 내부 URL을 돌려준다."""
    fid = hashlib.sha1(key.encode()).hexdigest()[:32]
    if fid in KNOWN_FILES:
        return f"/api/notes/file?id={fid}"
    try:
        r = requests.get(url, timeout=90)
        r.raise_for_status()
        data = r.content
    except Exception as e:
        print(f"  파일 내려받기 실패: {name_hint} ({e})")
        return None
    mime = (r.headers.get("Content-Type") or "").split(";")[0].strip().lower()
    name = re.sub(r"\?.*$", "", name_hint.rsplit("/", 1)[-1])[:200] or "file"
    if image and (len(data) > MAX_FILE or mime not in ("image/png", "image/jpeg", "image/gif", "image/webp")):
        try:
            from PIL import Image  # pillow
            im = Image.open(io.BytesIO(data))
            im = im.convert("RGB")
            for side in (1800, 1400, 1100, 900):
                im2 = im.copy()
                im2.thumbnail((side, side))
                buf = io.BytesIO()
                im2.save(buf, "JPEG", quality=84, optimize=True)
                if buf.tell() <= MAX_FILE:
                    data, mime = buf.getvalue(), "image/jpeg"
                    break
        except Exception as e:
            print(f"  이미지 변환 실패: {name} ({e})")
    if not mime:
        mime = "application/pdf" if name.lower().endswith(".pdf") else "application/octet-stream"
    if len(data) > MAX_FILE:
        print(f"  파일이 커서 보관하지 않음: {name} ({len(data)/1e6:.1f}MB)")
        return None
    PENDING_FILES.append((fid, mime, name, data, key))
    KNOWN_FILES.add(fid)
    return f"/api/notes/file?id={fid}"


# ------------------------------------------------------------------ Notion → HTML
def esc(s: str) -> str:
    return html.escape(s or "", quote=True)


def style_for(color: str | None) -> str:
    if not color or color == "default":
        return ""
    if color.endswith("_background"):
        c = BG_COLORS.get(color[:-11])
        return f"background-color: {c}" if c else ""
    c = TEXT_COLORS.get(color)
    return f"color: {c}" if c else ""


def rich(rt: list, block_color: str | None = None) -> str:
    out = []
    for t in rt or []:
        a = t.get("annotations", {})
        if t.get("type") == "equation":
            s = f"<code>{esc(t['equation'].get('expression', ''))}</code>"
        else:
            s = esc(t.get("plain_text", "")).replace("\n", "<br>")
        if not s:
            continue
        href = t.get("href") or (t.get("text", {}).get("link") or {}).get("url")
        if t.get("type") == "mention":
            m = t.get("mention", {})
            if m.get("type") == "page":
                href = f"#note/{nid(m['page']['id'])}"
        if a.get("code"):
            s = f"<code>{s}</code>"
        if a.get("bold"):
            s = f"<strong>{s}</strong>"
        if a.get("italic"):
            s = f"<em>{s}</em>"
        if a.get("underline"):
            s = f"<u>{s}</u>"
        if a.get("strikethrough"):
            s = f"<s>{s}</s>"
        st = style_for(a.get("color"))
        if st:
            s = f'<span style="{st}">{s}</span>'
        if href:
            if href.startswith("/"):
                href = "https://www.notion.so" + href
            s = f'<a href="{esc(href)}">{s}</a>'
        out.append(s)
    s = "".join(out)
    st = style_for(block_color)
    if st and s:
        s = f'<span style="{st}">{s}</span>'
    return s


def file_url(b: dict, key: str, image: bool):
    f = b.get(b["type"], {})
    if f.get("type") == "external":
        return f["external"]["url"], False
    if f.get("type") == "file":
        u = f["file"]["url"]
        return store_file(key, u, u.split("?")[0], image), True
    return None, False


CHILD_PAGES: list[tuple[str, str]] = []  # (page_id, title) 현재 페이지의 하위 페이지 (본문 순서)


def blocks_html(blocks: list) -> str:
    out, i = [], 0
    while i < len(blocks):
        b = blocks[i]
        t = b["type"]
        if t in ("bulleted_list_item", "numbered_list_item", "to_do"):
            j = i
            while j < len(blocks) and blocks[j]["type"] == t:
                j += 1
            items = []
            for x in blocks[i:j]:
                d = x[t]
                inner = f"<p>{rich(d.get('rich_text'), d.get('color'))}</p>" + kids(x)
                if t == "to_do":
                    items.append(f'<li data-type="taskItem" data-checked="{"true" if d.get("checked") else "false"}">{inner}</li>')
                else:
                    items.append(f"<li>{inner}</li>")
            tag = {"bulleted_list_item": "<ul>", "numbered_list_item": "<ol>", "to_do": '<ul data-type="taskList">'}[t]
            out.append(tag + "".join(items) + ("</ol>" if t == "numbered_list_item" else "</ul>"))
            i = j
            continue
        out.append(block_html(b))
        i += 1
    return "".join(out)


def kids(b: dict) -> str:
    if not b.get("has_children") or b["type"] in ("child_page", "child_database"):
        return ""
    return blocks_html(load_children(b["id"]))


def load_children(bid: str) -> list:
    bl = children(bid)
    for x in bl:
        if x["type"] == "child_page":
            CHILD_PAGES.append((nid(x["id"]), x["child_page"].get("title", "")))
    return bl


def block_html(b: dict) -> str:
    t = b["type"]
    d = b.get(t, {}) or {}
    if t == "paragraph":
        return f"<p>{rich(d.get('rich_text'), d.get('color'))}</p>" + kids(b)
    if t in ("heading_1", "heading_2", "heading_3"):
        lv = t[-1]
        text = rich(d.get("rich_text"), d.get("color"))
        if d.get("is_toggleable"):
            return f'<details><summary><strong>{text}</strong></summary><div data-type="detailsContent">{kids(b) or "<p></p>"}</div></details>'
        return f"<h{lv}>{text}</h{lv}>" + kids(b)
    if t == "toggle":
        return f'<details><summary>{rich(d.get("rich_text"), d.get("color"))}</summary><div data-type="detailsContent">{kids(b) or "<p></p>"}</div></details>'
    if t == "quote":
        return f"<blockquote><p>{rich(d.get('rich_text'), d.get('color'))}</p>{kids(b)}</blockquote>"
    if t == "callout":
        ic = (d.get("icon") or {}).get("emoji") or "💡"
        return f'<div data-callout="" data-icon="{esc(ic)}"><p>{rich(d.get("rich_text"), d.get("color"))}</p>{kids(b)}</div>'
    if t == "divider":
        return "<hr>"
    if t == "code":
        return f"<pre><code>{esc(''.join(x.get('plain_text', '') for x in d.get('rich_text', [])))}</code></pre>"
    if t == "equation":
        return f"<p><code>{esc(d.get('expression', ''))}</code></p>"
    if t == "image":
        url, _ = file_url(b, b["id"], True)
        cap = rich(d.get("caption"))
        if not url:
            return "<p>(이미지를 옮기지 못했습니다)</p>"
        return f'<img src="{esc(url)}">' + (f"<p>{cap}</p>" if cap else "")
    if t in ("pdf", "file", "video", "audio"):
        url, local = file_url(b, b["id"], False)
        name = (d.get("name") or "") or (url or "").split("?")[0].rsplit("/", 1)[-1] or t.upper()
        ic = {"pdf": "📄", "file": "📎", "video": "🎬", "audio": "🔊"}[t]
        if not url:
            return f"<p>{ic} {esc(name)} (용량이 커서 옮기지 못함 — Notion 원본 확인)</p>"
        return f'<p>{ic} <a href="{esc(url)}">{esc(name)}</a></p>'
    if t in ("bookmark", "embed", "link_preview"):
        u = d.get("url", "")
        cap = rich(d.get("caption")) or esc(u)
        return f'<p>🔗 <a href="{esc(u)}">{cap}</a></p>' if u else ""
    if t == "table":
        rows = load_children(b["id"])
        head = d.get("has_column_header")
        rh = d.get("has_row_header")
        trs = []
        for ri, r in enumerate(rows):
            if r["type"] != "table_row":
                continue
            tds = []
            for ci, cell in enumerate(r["table_row"].get("cells", [])):
                tag = "th" if (head and ri == 0) or (rh and ci == 0) else "td"
                tds.append(f"<{tag}><p>{rich(cell)}</p></{tag}>")
            trs.append("<tr>" + "".join(tds) + "</tr>")
        return "<table><tbody>" + "".join(trs) + "</tbody></table>"
    if t in ("column_list", "column", "synced_block", "template"):
        return kids(b)
    if t == "child_page":
        return ""  # 트리의 하위 페이지로 옮김
    if t == "child_database":
        return f"<p>🗂 데이터베이스 \"{esc(d.get('title', ''))}\" (이관 대상 아님)</p>"
    if t == "link_to_page":
        pid = d.get("page_id") or d.get("database_id") or ""
        return f'<p>↗ <a href="#note/{nid(pid)}">연결된 페이지</a></p>' if pid else ""
    return ""  # table_of_contents, breadcrumb, unsupported 등


# ------------------------------------------------------------------ D1
def sql_str(s: str) -> str:
    return "'" + (s or "").replace("\x00", "").replace("'", "''") + "'"


def chunks_utf8(s: str, limit: int) -> list[str]:
    out, cur, size = [], [], 0
    for ch in s:
        n = len(ch.encode()) + (1 if ch == "'" else 0)
        if size + n > limit and cur:
            out.append("".join(cur))
            cur, size = [], 0
        cur.append(ch)
        size += n
    out.append("".join(cur))
    return out


def d1(args: list[str], capture=True):
    cmd = ["npx", "--yes", "wrangler@4", "d1", "execute", DB_NAME, "--remote", "--yes"] + args
    for attempt in range(4):
        r = subprocess.run(cmd, capture_output=capture, text=True)
        if r.returncode == 0:
            return r.stdout
        print(f"  wrangler 실패(재시도 {attempt + 1}): {(r.stderr or r.stdout or '')[-400:]}")
        time.sleep(5 + attempt * 10)
    raise RuntimeError("D1 실행 실패")


def d1_query(sql: str) -> list:
    out = d1(["--json", "--command", sql])
    j = json.loads(out[out.index("["):])
    return j[0].get("results", []) if j else []


STMTS: list[str] = []


def flush(label=""):
    global STMTS
    for fid, mime, name, data, src in PENDING_FILES:
        STMTS.append(f"INSERT OR REPLACE INTO files (id, mime, name, size, data, notion_src, created_at) VALUES "
                     f"({sql_str(fid)}, {sql_str(mime)}, {sql_str(name)}, {len(data)}, X'', {sql_str(src)}, {sql_str(time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()))});")
        hx = data.hex()
        step = STMT_BYTES
        for k in range(0, len(hx), step):
            STMTS.append(f"UPDATE files SET data = data || X'{hx[k:k + step]}' WHERE id = {sql_str(fid)};")
    PENDING_FILES.clear()
    if not STMTS:
        return
    with tempfile.NamedTemporaryFile("w", suffix=".sql", delete=False, encoding="utf-8") as f:
        f.write("\n".join(STMTS))
        path = f.name
    d1(["--file", path])
    os.unlink(path)
    print(f"  D1 저장 완료 {label} (문장 {len(STMTS)}개)")
    STMTS = []


def upsert_page(pid, parent, title, icon, cover, sort, html_s, edited):
    from html import unescape
    text = re.sub(r"<[^>]+>", " ", re.sub(r"</(p|li|h\d|tr|summary)>|<br>", "\n", html_s))
    text = re.sub(r"[ \t]+", " ", unescape(text))
    text = re.sub(r"\n\s*\n+", "\n", text).strip()[:200000]
    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    hparts = chunks_utf8(html_s, STMT_BYTES)
    tparts = chunks_utf8(text, STMT_BYTES)
    par = "NULL" if parent is None else sql_str(parent)
    STMTS.append(
        "INSERT INTO nodes (id, parent_id, title, icon, cover, sort, html, text, notion_id, notion_edited, source, rev, created_at, updated_at, updated_by) VALUES "
        f"({sql_str(pid)}, {par}, {sql_str(title)}, {sql_str(icon) if icon else 'NULL'}, {sql_str(cover) if cover else 'NULL'}, {sort}, "
        f"{sql_str(hparts[0])}, '', {sql_str(pid)}, {sql_str(edited)}, 'notion', 1, {sql_str(edited)}, {sql_str(edited)}, 'notion') "
        "ON CONFLICT(id) DO UPDATE SET parent_id = excluded.parent_id, title = excluded.title, icon = excluded.icon, cover = excluded.cover, "
        "sort = excluded.sort, html = excluded.html, text = excluded.text, notion_edited = excluded.notion_edited, updated_at = excluded.updated_at "
        "WHERE nodes.source = 'notion';")
    for p in hparts[1:]:
        STMTS.append(f"UPDATE nodes SET html = html || {sql_str(p)} WHERE id = {sql_str(pid)} AND source = 'notion' AND notion_edited = {sql_str(edited)};")
    for p in tparts:
        STMTS.append(f"UPDATE nodes SET text = text || {sql_str(p)} WHERE id = {sql_str(pid)} AND source = 'notion' AND notion_edited = {sql_str(edited)};")


def page_title(pg: dict) -> str:
    for v in (pg.get("properties") or {}).values():
        if v.get("type") == "title":
            return "".join(x.get("plain_text", "") for x in v.get("title", []))
    return ""


# ------------------------------------------------------------------ main
def main():
    tok = (os.environ.get("NOTION_TOKEN") or "").strip()
    if not tok:
        print("NOTION_TOKEN 없음 → 이관 건너뜀")
        return 0
    S.headers.update({"Authorization": f"Bearer {tok}", "Notion-Version": NV, "Content-Type": "application/json"})
    root = nid(os.environ.get("NOTION_ROOT") or json.load(open("config.json", encoding="utf-8")).get("notion_root", ""))
    if not root:
        print("NOTION_ROOT 없음")
        return 1
    d1(["--file", "db/notes_schema.sql"])
    state = {r["id"]: r for r in d1_query("SELECT id, notion_edited, source FROM nodes WHERE notion_id IS NOT NULL")}
    for r in d1_query("SELECT id FROM files"):
        KNOWN_FILES.add(r["id"])
    print(f"기존 이관 페이지 {len(state)}개, 파일 {len(KNOWN_FILES)}개")

    try:
        top = children(root)
    except RuntimeError as e:
        print(f"Equity 페이지를 읽지 못했습니다. Notion에서 Equity 페이지에 AlphaDesk 연결을 추가했는지 확인하세요.\n{e}")
        return 1
    queue = [(nid(x["id"]), None, k) for k, x in enumerate(b for b in top if b["type"] == "child_page")]
    done = changed = skipped_app = 0
    pending = 0
    while queue:
        if time.time() - T0 > BUDGET:
            print(f"시간 한도 도달 → 남은 {len(queue)}개 이상은 다음 실행에서 이어 받습니다")
            break
        pid, parent, sort = queue.pop(0)
        try:
            pg = notion("GET", f"/pages/{pid}")
        except RuntimeError as e:
            print(f"  페이지 읽기 실패 {pid}: {e}")
            continue
        if pg.get("archived") or pg.get("in_trash"):
            continue
        title = page_title(pg) or "제목 없음"
        edited = pg.get("last_edited_time", "")
        prev = state.get(pid)
        CHILD_PAGES.clear()
        if prev and prev.get("notion_edited") == edited:
            load_children(pid)  # 변경 없음: 하위 페이지 목록만 확인
        elif prev and prev.get("source") == "app":
            skipped_app += 1
            load_children(pid)
        else:
            icon = (pg.get("icon") or {}).get("emoji") if (pg.get("icon") or {}).get("type") == "emoji" else None
            cover = None
            cv = pg.get("cover") or {}
            if cv.get("type") == "external":
                cover = cv["external"]["url"]
            elif cv.get("type") == "file":
                cover = store_file(pid + ":cover", cv["file"]["url"], cv["file"]["url"].split("?")[0], True)
            body = blocks_html(load_children(pid))
            upsert_page(pid, parent, title, icon, cover, sort, body, edited)
            changed += 1
            pending += 1
        kids_ = list(CHILD_PAGES)
        queue = [(c, pid, k) for k, (c, _) in enumerate(kids_)] + queue  # 깊이 우선(같은 회사 페이지끼리 모아 저장)
        done += 1
        if pending >= 25 or sum(len(x[3]) for x in PENDING_FILES) > 6_000_000:
            flush(f"(누적 {done}개 확인 · 변경 {changed} · API {CALLS[0]}회 · {int((time.time() - T0) / 60)}분)")
            pending = 0
    flush("(마지막)")
    print(f"완료: 확인 {done} · 새로/다시 옮김 {changed} · AlphaDesk에서 수정돼 건너뜀 {skipped_app} · Notion API {CALLS[0]}회 · {int((time.time() - T0) / 60)}분")
    return 0


if __name__ == "__main__":
    sys.exit(main())
