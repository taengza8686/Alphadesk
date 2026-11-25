"""AlphaDesk 데이터 백업: Cloudflare(D1 노트·이미지, KV 회원·포트폴리오) → 백업 저장소 폴더.

- 바뀐 페이지·새 파일만 받아서 덮어쓴다(증분). 날짜별 버전은 백업 저장소의 커밋 기록으로 남는다.
- 비밀번호 원문은 원래 저장하지 않으므로 백업에도 없다(해시만 있음). 세션 비밀키·로그인 시도 기록은 백업하지 않는다.
사용: python tools/backup.py <백업 폴더>
"""
from __future__ import annotations

import json
import os
import sys
import time
import urllib.parse

sys.path.insert(0, os.path.dirname(__file__))
import cf  # noqa: E402

PAGE_COLS = "id, parent_id, title, icon, cover, sort, html, notion_id, notion_edited, source, rev, created_at, updated_at, updated_by, deleted_at"


def jdump(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=1, sort_keys=True)
    os.replace(tmp, path)


def jload(path, default=None):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default


def main(root):
    t0 = time.time()
    cf.init()
    db = cf.d1_id()
    ns = cf.kv_ns()
    pdir, fdir = os.path.join(root, "pages"), os.path.join(root, "files")
    os.makedirs(pdir, exist_ok=True)
    os.makedirs(fdir, exist_ok=True)

    # ---- 07 노트 페이지 (바뀐 것만)
    live = {r["id"]: r for r in cf.q(db, "SELECT id, rev, updated_at, deleted_at, length(html) AS n FROM nodes")}
    have = {}
    for fn in os.listdir(pdir):
        if fn.endswith(".json"):
            j = jload(os.path.join(pdir, fn), {})
            have[fn[:-5]] = j
    changed = [i for i, r in live.items() if i not in have or (have[i].get("rev"), have[i].get("updated_at"), have[i].get("deleted_at")) != (r["rev"], r["updated_at"], r["deleted_at"])]
    removed = [i for i in have if i not in live]
    batch, size = [], 0
    def fetch(ids):
        ph = ",".join("?" * len(ids))
        for row in cf.q(db, f"SELECT {PAGE_COLS} FROM nodes WHERE id IN ({ph})", ids):
            jdump(os.path.join(pdir, row["id"] + ".json"), row)
    for i in changed:
        batch.append(i)
        size += live[i]["n"] or 0
        if len(batch) >= 40 or size > 2_500_000:
            fetch(batch)
            batch, size = [], 0
    if batch:
        fetch(batch)
    for i in removed:
        os.remove(os.path.join(pdir, i + ".json"))

    # ---- 이미지·첨부 파일 (파일은 바뀌지 않으므로 새 것만)
    idx_path = os.path.join(fdir, "index.json")
    idx = jload(idx_path, {}) or {}
    flive = {r["id"]: r for r in cf.q(db, "SELECT id, mime, name, size, notion_src, created_at FROM files")}
    new_files = [i for i in flive if i not in idx or not os.path.exists(os.path.join(fdir, i[:2], i + ".bin"))]
    batch, size, got = [], 0, 0
    def fetch_files(ids):
        nonlocal got
        ph = ",".join("?" * len(ids))
        for row in cf.q(db, f"SELECT id, hex(data) AS hx FROM files WHERE id IN ({ph})", ids):
            d = bytes.fromhex(row["hx"] or "")
            p = os.path.join(fdir, row["id"][:2], row["id"] + ".bin")
            os.makedirs(os.path.dirname(p), exist_ok=True)
            with open(p, "wb") as f:
                f.write(d)
            idx[row["id"]] = flive[row["id"]]
            got += 1
    for i in new_files:
        batch.append(i)
        size += flive[i].get("size") or 0
        if len(batch) >= 10 or size > 1_500_000:
            fetch_files(batch)
            batch, size = [], 0
            if got % 200 < 10:
                jdump(idx_path, idx)
    if batch:
        fetch_files(batch)
    for i in [i for i in idx if i not in flive]:
        idx.pop(i, None)  # D1에서 지워진 파일: 목록에서만 빼고 파일은 과거 커밋에 남는다
        p = os.path.join(fdir, i[:2], i + ".bin")
        if os.path.exists(p):
            os.remove(p)
    jdump(idx_path, idx)

    # ---- 회원·포트폴리오 (KV)
    kdir = os.path.join(root, "kv")
    keep = []
    for prefix in ("user:", "portfolio"):
        for k in cf.kv_keys(ns, prefix):
            v = cf.kv_get(ns, k)
            if v is None:
                continue
            fn = urllib.parse.quote(k, safe="") + ".json"
            keep.append(fn)
            try:
                val = json.loads(v)
            except Exception:
                val = {"__raw__": v}
            jdump(os.path.join(kdir, fn), {"key": k, "value": val})
    if os.path.isdir(kdir):
        for fn in os.listdir(kdir):
            if fn.endswith(".json") and fn not in keep:
                os.remove(os.path.join(kdir, fn))

    man = {
        "backed_up_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "pages": len(live), "pages_alive": sum(1 for r in live.values() if not r["deleted_at"]),
        "files": len(idx), "kv_keys": len(keep),
        "this_run": {"pages_changed": len(changed), "pages_removed": len(removed), "files_new": got, "seconds": int(time.time() - t0)},
    }
    jdump(os.path.join(root, "manifest.json"), man)
    with open(os.path.join(root, "README.md"), "w", encoding="utf-8") as f:
        f.write("# AlphaDesk 백업 (비공개)\n\n자동으로 만들어지는 백업입니다. 직접 고치지 마세요.\n\n"
                "- pages/: 07 노트 페이지 (1개 = 1파일)\n- files/: 노트 이미지·첨부\n- kv/: 회원·포트폴리오\n- manifest.json: 마지막 백업 요약\n\n"
                "복구는 Alphadesk 저장소 Actions의 'AlphaDesk 백업에서 복구'에서 날짜를 골라 실행합니다.\n")
    print(f"백업 완료: 페이지 {man['pages']}개(변경 {len(changed)}·삭제 {len(removed)}) · 파일 {man['files']}개(새로 {got}) · 회원/포트폴리오 키 {len(keep)}개 · {man['this_run']['seconds']}초")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "backup")
