"""AlphaDesk 백업에서 복구: 백업 폴더(특정 날짜 시점) → Cloudflare D1·KV.

범위(scope): all | notes | accounts | page:<페이지id>
- notes: 백업 시점의 페이지로 되돌린다. 백업 이후에 새로 만든 페이지는 지우지 않고 휴지통으로 보낸다(되살릴 수 있음).
         이미지는 지금 없는 것만 다시 넣는다.
- accounts: 회원·포트폴리오를 백업 시점 값으로 되돌린다(백업 이후 새로 가입한 회원은 그대로 둔다).
사용: python tools/restore.py <백업 폴더> <scope>
"""
from __future__ import annotations

import json
import os
import re
import sys
import time
from html import unescape

sys.path.insert(0, os.path.dirname(__file__))
import cf  # noqa: E402

COLS = ["id", "parent_id", "title", "icon", "cover", "sort", "notion_id", "notion_edited", "source", "rev", "created_at", "updated_at", "updated_by", "deleted_at"]
CHUNK = 100_000


def strip(html):
    t = re.sub(r"<[^>]+>", " ", re.sub(r"</(p|li|h\d|tr|summary)>|<br\s*/?>", "\n", html or ""))
    t = re.sub(r"[ \t]+", " ", unescape(t))
    return re.sub(r"\n\s*\n+", "\n", t).strip()[:200000]


def put_page(db, p):
    html = p.get("html") or ""
    text = strip(html)
    vals = [p.get(c) for c in COLS]
    cf.q(db, f"INSERT OR REPLACE INTO nodes ({', '.join(COLS)}, html, text) VALUES ({', '.join('?' * len(COLS))}, ?, '')", vals + [html[:CHUNK]])
    for k in range(CHUNK, len(html), CHUNK):
        cf.q(db, "UPDATE nodes SET html = html || ? WHERE id = ?", [html[k:k + CHUNK], p["id"]])
    for k in range(0, len(text), CHUNK):
        cf.q(db, "UPDATE nodes SET text = text || ? WHERE id = ?", [text[k:k + CHUNK], p["id"]])


def restore_notes(db, root, only=None):
    pdir = os.path.join(root, "pages")
    pages = {}
    for fn in os.listdir(pdir):
        if fn.endswith(".json") and (not only or fn[:-5] == only):
            with open(os.path.join(pdir, fn), encoding="utf-8") as f:
                p = json.load(f)
            pages[p["id"]] = p
    if only and not pages:
        raise SystemExit(f"백업에 페이지 {only} 가 없습니다")
    live = {r["id"]: r for r in cf.q(db, "SELECT id, rev, updated_at, deleted_at FROM nodes")}
    n = 0
    for i, p in pages.items():
        l = live.get(i)
        if l and (l["rev"], l["updated_at"], l["deleted_at"]) == (p.get("rev"), p.get("updated_at"), p.get("deleted_at")):
            continue
        put_page(db, p)
        n += 1
    trashed = 0
    if not only:
        now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        for i, l in live.items():
            if i not in pages and not l["deleted_at"]:
                cf.q(db, "UPDATE nodes SET deleted_at = ? WHERE id = ?", [now, i])
                trashed += 1
    # 이미지·첨부: 지금 D1에 없는 것만
    fdir = os.path.join(root, "files")
    idx = {}
    try:
        with open(os.path.join(fdir, "index.json"), encoding="utf-8") as f:
            idx = json.load(f)
    except Exception:
        pass
    have = {r["id"] for r in cf.q(db, "SELECT id FROM files")}
    added = 0
    for fid, m in idx.items():
        if fid in have:
            continue
        path = os.path.join(fdir, fid[:2], fid + ".bin")
        if not os.path.exists(path):
            continue
        data = open(path, "rb").read()
        cf.q(db, "INSERT OR IGNORE INTO files (id, mime, name, size, data, notion_src, created_at) VALUES (?, ?, ?, ?, X'', ?, ?)",
             [fid, m.get("mime"), m.get("name"), len(data), m.get("notion_src"), m.get("created_at")])
        hx = data.hex()
        for k in range(0, len(hx), 90_000):
            cf.q(db, f"UPDATE files SET data = data || X'{hx[k:k + 90_000]}' WHERE id = ?", [fid])
        added += 1
    print(f"노트 복구: 페이지 {n}개 되돌림 · 백업 이후 새 페이지 {trashed}개 휴지통으로 · 이미지 {added}개 다시 넣음")


def restore_accounts(ns, root):
    kdir = os.path.join(root, "kv")
    n = 0
    for fn in sorted(os.listdir(kdir)) if os.path.isdir(kdir) else []:
        if not fn.endswith(".json"):
            continue
        with open(os.path.join(kdir, fn), encoding="utf-8") as f:
            j = json.load(f)
        v = j["value"]
        raw = v["__raw__"] if isinstance(v, dict) and "__raw__" in v else json.dumps(v, ensure_ascii=False)
        cf.kv_put(ns, j["key"], raw)
        n += 1
    print(f"회원·포트폴리오 복구: {n}개 키 (반영까지 최대 1분)")


def main(root, scope):
    cf.init()
    if scope in ("all", "notes") or scope.startswith("page:"):
        restore_notes(cf.d1_id(), root, scope[5:] if scope.startswith("page:") else None)
    if scope in ("all", "accounts"):
        restore_accounts(cf.kv_ns(), root)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else "all")
