"""Cloudflare REST 도우미 (백업·복구 공용) — D1 쿼리, KV 읽기/쓰기."""
from __future__ import annotations

import os
import time
import urllib.parse

import requests

API = "https://api.cloudflare.com/client/v4"
S = requests.Session()


def _env(k):
    v = (os.environ.get(k) or "").strip()
    if not v:
        raise SystemExit(f"{k} 가 없습니다")
    return v


ACC = None


def init():
    global ACC
    S.headers.update({"Authorization": "Bearer " + _env("CLOUDFLARE_API_TOKEN")})
    ACC = _env("CLOUDFLARE_ACCOUNT_ID")


def call(method, path, **kw):
    for attempt in range(6):
        try:
            r = S.request(method, f"{API}/accounts/{ACC}{path}", timeout=120, **kw)
        except requests.RequestException:
            time.sleep(3 + attempt * 5)
            continue
        if r.status_code in (429, 500, 502, 503, 504):
            time.sleep(3 + attempt * 5)
            continue
        return r
    raise RuntimeError(f"Cloudflare 요청 실패: {path}")


def d1_id(name="alphadesk-notes"):
    r = call("GET", "/d1/database", params={"name": name, "per_page": 50})
    for d in r.json().get("result") or []:
        if d.get("name") == name:
            return d.get("uuid")
    raise SystemExit(f"D1 데이터베이스 {name} 를 찾지 못했습니다")


def q(db, sql, params=None):
    body = {"sql": sql}
    if params:
        body["params"] = params
    r = call("POST", f"/d1/database/{db}/query", json=body)
    j = r.json()
    if not j.get("success"):
        raise RuntimeError(f"D1 오류: {j.get('errors')} :: {sql[:120]}")
    res = j.get("result") or []
    return res[0].get("results", []) if res else []


def kv_ns(title="alphadesk-pf"):
    page = 1
    while True:
        r = call("GET", "/storage/kv/namespaces", params={"per_page": 100, "page": page})
        res = r.json().get("result") or []
        for n in res:
            if n.get("title") == title:
                return n["id"]
        if len(res) < 100:
            break
        page += 1
    raise SystemExit(f"KV {title} 를 찾지 못했습니다")


def kv_keys(ns, prefix=""):
    out, cursor = [], None
    while True:
        p = {"limit": 1000, "prefix": prefix}
        if cursor:
            p["cursor"] = cursor
        j = call("GET", f"/storage/kv/namespaces/{ns}/keys", params=p).json()
        out += [k["name"] for k in j.get("result") or []]
        cursor = (j.get("result_info") or {}).get("cursor")
        if not cursor:
            return out


def kv_get(ns, key):
    r = call("GET", f"/storage/kv/namespaces/{ns}/values/{urllib.parse.quote(key, safe='')}")
    return r.text if r.status_code == 200 else None


def kv_put(ns, key, value: str):
    r = call("PUT", f"/storage/kv/namespaces/{ns}/values/{urllib.parse.quote(key, safe='')}", data=value.encode("utf-8"),
             headers={"Content-Type": "text/plain"})
    if r.status_code >= 300:
        raise RuntimeError(f"KV 쓰기 실패 {key}: {r.text[:200]}")
