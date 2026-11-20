#!/usr/bin/env python3
"""
AlphaDesk 데이터 파이프라인 (Russell 1000 · GitHub Pages용)
=========================================================
매일 1회 실행되어 site/data/ 아래에 정적 JSON을 만듭니다. 홈페이지(site/index.html)는 이 파일만 읽습니다.

  유니버스   : iShares IWB(Russell 1000 추종 ETF) 보유종목 CSV
  재무제표   : SEC EDGAR companyfacts.zip (XBRL, 공식·무료)
  공시 목록  : SEC EDGAR submissions
  주가(EOD)  : Yahoo Finance 일괄 다운로드 (실패 시 FMP_API_KEY 있으면 백업)
  Fwd P/E 등 : Yahoo 부가정보 (7일 캐시, 하루 조회 한도 내에서 순차 갱신)
  R2000 등락 : iShares IWM 보유종목 + Yahoo 종가
  뉴스       : FINNHUB_API_KEY가 있을 때만

산출물: site/data/summary.json(스크리너·지수), site/data/hist/{티커}.json(일봉), site/data/fin/{티커}.json(재무·공시)

테스트:  python build_data.py --max 30 --no-movers
"""
from __future__ import annotations

import argparse
import datetime as dt
import io
import json
import math
import os
import sys
import time
from collections import defaultdict
from pathlib import Path

import numpy as np
import pandas as pd
import requests

ROOT = Path(__file__).resolve().parent
CACHE = ROOT / ".cache"
KST = dt.timezone(dt.timedelta(hours=9))

WARNINGS: list[str] = []


def warn(msg: str) -> None:
    WARNINGS.append(msg)
    print(f"  [경고] {msg}", file=sys.stderr)


# ---------------------------------------------------------------------------
# HTTP helpers
# ---------------------------------------------------------------------------
class SecClient:
    """SEC 규정: User-Agent에 이름+이메일 필수, 초당 10회 이하."""

    def __init__(self, user_agent: str):
        self.s = requests.Session()
        self.s.headers.update({"User-Agent": user_agent, "Accept-Encoding": "gzip, deflate"})
        self._last = 0.0

    def get_json(self, url: str, cache_name: str | None = None, max_age_h: float = 12):
        if cache_name:
            p = CACHE / cache_name
            if p.exists() and (time.time() - p.stat().st_mtime) < max_age_h * 3600:
                return json.loads(p.read_text())
        wait = 0.12 - (time.time() - self._last)
        if wait > 0:
            time.sleep(wait)
        for attempt in range(3):
            r = self.s.get(url, timeout=30)
            self._last = time.time()
            if r.status_code == 200:
                data = r.json()
                if cache_name:
                    (CACHE / cache_name).parent.mkdir(parents=True, exist_ok=True)
                    (CACHE / cache_name).write_text(json.dumps(data))
                return data
            if r.status_code in (429, 503):
                time.sleep(2 * (attempt + 1))
                continue
            r.raise_for_status()
        r.raise_for_status()


def _d(s: str) -> dt.date:
    return dt.date.fromisoformat(s)


# ---------------------------------------------------------------------------
# SEC: companyfacts → 분기 재무제표
# ---------------------------------------------------------------------------
FORMS_OK = {"10-Q", "10-K", "10-Q/A", "10-K/A", "10-KT", "10-QT"}

# key: (태그 우선순위 목록, 단위, 'dur'|'inst', 병합방식)
#  병합방식 'first' = 우선순위 높은 태그 값, 'max' = 같은 기간 여러 태그 중 최댓값(매출처럼 부분합 태그가 섞일 때)
CONCEPTS = {
    "revenue": (["Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax", "SalesRevenueNet",
                 "RevenueFromContractWithCustomerIncludingAssessedTax", "RevenuesNetOfInterestExpense"], "USD", "dur", "max"),
    "costOfRevenue": (["CostOfRevenue", "CostOfGoodsAndServicesSold", "CostOfGoodsSold"], "USD", "dur", "first"),
    "grossProfit": (["GrossProfit"], "USD", "dur", "first"),
    "opIncome": (["OperatingIncomeLoss"], "USD", "dur", "first"),
    "netIncome": (["NetIncomeLoss", "NetIncomeLossAvailableToCommonStockholdersBasic", "ProfitLoss"], "USD", "dur", "first"),
    "epsDiluted": (["EarningsPerShareDiluted", "EarningsPerShareBasicAndDiluted"], "USD/shares", "dur", "first"),
    "dilutedShares": (["WeightedAverageNumberOfDilutedSharesOutstanding"], "shares", "dur", "first"),
    "dna": (["DepreciationDepletionAndAmortization", "DepreciationAmortizationAndAccretionNet",
             "DepreciationAndAmortization", "Depreciation"], "USD", "dur", "first"),
    "ocf": (["NetCashProvidedByUsedInOperatingActivities",
             "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations"], "USD", "dur", "first"),
    "capex": (["PaymentsToAcquirePropertyPlantAndEquipment", "PaymentsToAcquireProductiveAssets"], "USD", "dur", "first"),
    "buyback": (["PaymentsForRepurchaseOfCommonStock"], "USD", "dur", "first"),
    "dividends": (["PaymentsOfDividendsCommonStock", "PaymentsOfDividends"], "USD", "dur", "first"),
    # --- 재무상태표(시점) ---
    "cash": (["CashAndCashEquivalentsAtCarryingValue",
              "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents", "Cash"], "USD", "inst", "first"),
    "stInvest": (["ShortTermInvestments", "MarketableSecuritiesCurrent",
                  "AvailableForSaleSecuritiesDebtSecuritiesCurrent"], "USD", "inst", "first"),
    "receivables": (["AccountsReceivableNetCurrent", "ReceivablesNetCurrent"], "USD", "inst", "first"),
    "inventory": (["InventoryNet"], "USD", "inst", "first"),
    "totalAssets": (["Assets"], "USD", "inst", "first"),
    "totalLiabilities": (["Liabilities"], "USD", "inst", "first"),
    "liabAndEquity": (["LiabilitiesAndStockholdersEquity"], "USD", "inst", "first"),
    "equity": (["StockholdersEquity"], "USD", "inst", "first"),
    "equityInclNci": (["StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"], "USD", "inst", "first"),
    "ltDebtTotal": (["LongTermDebt"], "USD", "inst", "first"),
    "ltDebtNoncurrent": (["LongTermDebtNoncurrent"], "USD", "inst", "first"),
    "ltDebtCurrent": (["LongTermDebtCurrent"], "USD", "inst", "first"),
    "stBorrowings": (["ShortTermBorrowings"], "USD", "inst", "first"),
    "commercialPaper": (["CommercialPaper"], "USD", "inst", "first"),
}


def collect_facts(us_gaap: dict, tags: list[str], unit: str, kind: str, merge: str):
    """태그 목록에서 사실(fact)을 모아 기간별 1개 값으로 정리.

    - 같은 기간이 여러 공시에 반복 등장하면 가장 최근 제출본(정정 반영)을 사용
    - 반환: dur → {(start,end): val}, inst → {end: val}
    """
    out: dict = {}
    prio: dict = {}
    for p, tag in enumerate(tags):
        entries = us_gaap.get(tag, {}).get("units", {}).get(unit)
        if not entries:
            continue
        best: dict = {}
        for e in entries:
            if e.get("form") not in FORMS_OK:
                continue
            try:
                end = _d(e["end"])
                key = (_d(e["start"]), end) if kind == "dur" else end
            except (KeyError, ValueError):
                continue
            if kind == "dur" and "start" not in e:
                continue
            prev = best.get(key)
            if prev is None or e.get("filed", "") > prev.get("filed", ""):
                best[key] = e
        for key, e in best.items():
            v = float(e["val"])
            if key not in out:
                out[key], prio[key] = v, p
            elif merge == "max":
                out[key] = max(out[key], v)
            # merge == 'first': 이미 더 높은 우선순위 태그 값이 있으면 유지
    return out


def quarterize(facts: dict):
    """기간(duration) 사실 → 분기값 {end: (val, derived, start)}.

    1) 3개월(80~100일) 기간 값은 그대로 사용
    2) 누적(YTD) 값 차분: 같은 회계연도 시작일의 6M−3M, 9M−6M, 12M−9M → 2·3·4분기
       (현금흐름표는 10-Q에 누적값만 나오므로 이 단계가 필수)
    3) 그래도 4분기가 없으면 연간 − (1~3분기 합)
    """
    q: dict = {}

    def has_near(e: dt.date) -> bool:
        return any(abs((e - k).days) <= 7 for k in q)

    for (s, e), v in facts.items():
        if 80 <= (e - s).days + 1 <= 100:
            q[e] = (v, False, s)

    by_start = defaultdict(list)
    for (s, e), v in facts.items():
        d = (e - s).days + 1
        if 80 <= d <= 380:
            by_start[s].append((e, v))
    for s, lst in by_start.items():
        lst.sort()
        for (e0, v0), (e1, v1) in zip(lst, lst[1:]):
            if 80 <= (e1 - e0).days <= 100 and not has_near(e1):
                q[e1] = (v1 - v0, True, e0 + dt.timedelta(days=1))

    for (s, e), v in facts.items():
        if 350 <= (e - s).days + 1 <= 380 and not has_near(e):
            inside = [(k, val) for k, (val, _, st) in q.items() if s - dt.timedelta(days=7) <= st and k < e - dt.timedelta(days=30)]
            if len(inside) == 3:
                q[e] = (v - sum(val for _, val in inside), True, max(k for k, _ in inside) + dt.timedelta(days=1))
    return q


def lookup_near(d: dict, end: dt.date, tol: int = 7):
    if end in d:
        return d[end]
    for k, v in d.items():
        if abs((k - end).days) <= tol:
            return v
    return None


def fiscal_label(end: dt.date, fy_end_mmdd: str | None) -> str:
    """분기 종료일 + 회계연도 말(MMDD) → 'FY26 Q3'.

    주의: companyfacts의 fy/fp 필드는 '그 숫자가 실린 공시'의 회계연도라서
    비교기간(전년 동기) 값에도 최신 공시 연도가 붙습니다. 그래서 종료일로 직접 계산합니다.
    52/53주 회계연도(예: NVDA 1월 마지막 일요일)를 위해 ±10일 여유를 둡니다.
    """
    if not fy_end_mmdd or len(fy_end_mmdd) != 4:
        fy_end_mmdd = "1231"
    mm, dd = int(fy_end_mmdd[:2]), int(fy_end_mmdd[2:])
    dd = min(dd, 28) if mm == 2 else dd
    cand = dt.date(end.year, mm, dd)
    fy_year = end.year if end <= cand + dt.timedelta(days=10) else end.year + 1
    fy_end = dt.date(fy_year, mm, dd)
    months_before = round((fy_end - end).days / 30.44)
    qn = 4 - round(months_before / 3)
    qn = min(4, max(1, qn))
    return f"FY{str(fy_year)[-2:]} Q{qn}"


IS_ROWS = [
    ("revenue", "매출액 (Revenue)", True),
    ("grossProfit", "매출총이익 (Gross Profit)", False),
    ("grossMargin", "매출총이익률 (Gross Margin %)", False),
    ("opIncome", "영업이익 (Operating Income)", True),
    ("opMargin", "영업이익률 (Operating Margin %)", False),
    ("netIncome", "순이익 (Net Income)", False),
    ("epsDiluted", "희석 주당순이익 (Diluted EPS $)", False),
]
BS_ROWS = [
    ("cashAndSti", "현금 및 단기투자자산", True),
    ("receivables", "매출채권 (Accounts Receivable)", False),
    ("inventory", "재고자산 (Inventories)", False),
    ("totalAssets", "총자산 (Total Assets)", True),
    ("totalLiabilities", "총부채 (Total Liabilities)", False),
    ("totalDebt", "총차입금 (Total Debt)", False),
    ("equity", "자기자본 (Stockholders' Equity)", True),
]
CF_ROWS = [
    ("ocf", "영업활동현금흐름 (OCF)", True),
    ("capex", "자본적지출 (CAPEX)", False),
    ("fcf", "잉여현금흐름 (FCF = OCF − CAPEX)", True),
    ("fcfMargin", "FCF 마진율 (%)", False),
    ("buyback", "자사주 매입 (Buybacks)", False),
    ("dividends", "배당금 지급 (Dividends)", False),
]


def build_financials(facts_json: dict, fy_end: str | None, n_quarters: int) -> dict | None:
    us_gaap = facts_json.get("facts", {}).get("us-gaap", {})
    if not us_gaap:
        return None
    raw = {k: collect_facts(us_gaap, *spec) for k, spec in CONCEPTS.items()}
    qd = {k: quarterize(v) for k, v in raw.items() if CONCEPTS[k][2] == "dur"}
    inst = {k: v for k, v in raw.items() if CONCEPTS[k][2] == "inst"}

    anchor = qd.get("revenue") or qd.get("netIncome") or {}
    if not anchor:
        anchor = qd.get("netIncome", {})
    if not anchor:
        return None
    ends = sorted(anchor.keys())[-n_quarters:]

    def dur(key, e):
        v = lookup_near(qd.get(key, {}), e)
        return (v[0], v[1]) if v else (None, False)

    def ins(key, e):
        return lookup_near(inst.get(key, {}), e)

    cols = []
    for e in ends:
        row: dict = {}
        der: dict = {}
        for k in ("revenue", "costOfRevenue", "grossProfit", "opIncome", "netIncome", "epsDiluted",
                  "dilutedShares", "dna", "ocf", "capex", "buyback", "dividends"):
            row[k], der[k] = dur(k, e)
        if row["grossProfit"] is None and row["revenue"] is not None and row["costOfRevenue"] is not None:
            row["grossProfit"] = row["revenue"] - row["costOfRevenue"]
            der["grossProfit"] = der["revenue"] or der["costOfRevenue"]
        rev = row["revenue"]
        row["grossMargin"] = (row["grossProfit"] / rev * 100) if (rev and row["grossProfit"] is not None) else None
        row["opMargin"] = (row["opIncome"] / rev * 100) if (rev and row["opIncome"] is not None) else None
        der["grossMargin"], der["opMargin"] = der["grossProfit"], der["opIncome"]
        if row["ocf"] is not None and row["capex"] is not None:
            row["fcf"] = row["ocf"] - row["capex"]
            der["fcf"] = der["ocf"] or der["capex"]
        else:
            row["fcf"], der["fcf"] = None, False
        row["fcfMargin"] = (row["fcf"] / rev * 100) if (rev and row["fcf"] is not None) else None
        der["fcfMargin"] = der["fcf"]
        # 현금흐름 유출 항목은 음수로 표시
        for k in ("capex", "buyback", "dividends"):
            if row[k] is not None:
                row[k] = -abs(row[k])

        cash, sti = ins("cash", e), ins("stInvest", e)
        row["cashAndSti"] = None if cash is None else cash + (sti or 0)
        row["receivables"] = ins("receivables", e)
        row["inventory"] = ins("inventory", e)
        row["totalAssets"] = ins("totalAssets", e)
        row["equity"] = ins("equity", e)
        liab = ins("totalLiabilities", e)
        if liab is None:
            le, eq_all = ins("liabAndEquity", e), ins("equityInclNci", e) or row["equity"]
            if le is not None and eq_all is not None:
                liab = le - eq_all
        row["totalLiabilities"] = liab
        lt = ins("ltDebtTotal", e)
        if lt is None:
            nc, cur = ins("ltDebtNoncurrent", e), ins("ltDebtCurrent", e)
            lt = None if (nc is None and cur is None) else (nc or 0) + (cur or 0)
        stb, cp = ins("stBorrowings", e), ins("commercialPaper", e)
        row["totalDebt"] = None if (lt is None and stb is None and cp is None) else (lt or 0) + (stb or 0) + (cp or 0)
        for k in ("cashAndSti", "receivables", "inventory", "totalAssets", "equity", "totalLiabilities", "totalDebt"):
            der[k] = False
        cols.append((e, row, der))

    def pack(rows):
        out = []
        for key, label, hl in rows:
            vals = [c[1].get(key) for c in cols]
            if all(v is None for v in vals):
                continue
            out.append({
                "key": key, "item": label, "highlight": hl,
                "isPct": key.endswith("Margin"), "isEps": key == "epsDiluted",
                "vals": [None if v is None else round(v, 4 if key == "epsDiluted" else 2) for v in vals],
                "derived": [bool(c[2].get(key)) for c in cols],
            })
        return out

    # TTM: 연속된 최근 4개 분기 합
    def ttm(key):
        series = qd.get(key, {})
        ks = sorted(series.keys())
        if len(ks) < 4:
            return None
        last4 = ks[-4:]
        if any(not (80 <= (b - a).days <= 100) for a, b in zip(last4, last4[1:])):
            return None
        if (ends[-1] - last4[-1]).days > 7:   # 최신 분기와 일치해야 함
            return None
        return float(sum(series[k][0] for k in last4))

    last = cols[-1][1]
    ttm_vals = {k: ttm(k) for k in ("revenue", "opIncome", "netIncome", "epsDiluted", "ocf", "capex", "dna")}
    if ttm_vals["ocf"] is not None and ttm_vals["capex"] is not None:
        ttm_vals["fcf"] = ttm_vals["ocf"] - abs(ttm_vals["capex"])
    else:
        ttm_vals["fcf"] = None

    # 발행주식수(표지 dei) — 다중 클래스 회사는 비어 있을 수 있음
    shares = None
    dei = facts_json.get("facts", {}).get("dei", {}).get("EntityCommonStockSharesOutstanding", {}).get("units", {}).get("shares", [])
    if dei:
        latest_end = max(x["end"] for x in dei)
        same = [x for x in dei if x["end"] == latest_end]
        shares = float(max(same, key=lambda x: x.get("filed", ""))["val"])

    return {
        "fyEnd": fy_end,
        "quarters": [{"label": fiscal_label(e, fy_end), "end": e.isoformat()} for e, _, _ in cols],
        "IS": pack(IS_ROWS), "BS": pack(BS_ROWS), "CF": pack(CF_ROWS),
        "ttm": ttm_vals,
        "latest": {"cashAndSti": last.get("cashAndSti"), "totalDebt": last.get("totalDebt"),
                   "equity": last.get("equity"), "dilutedShares": last.get("dilutedShares")},
        "sharesOutstanding": shares,
    }


def recent_filings(sub: dict, cik: str, n: int = 12) -> list:
    r = sub.get("filings", {}).get("recent", {})
    out = []
    for i, form in enumerate(r.get("form", [])):
        if form not in ("10-K", "10-Q", "8-K", "10-K/A", "10-Q/A"):
            continue
        items = (r.get("items") or [""] * (i + 1))[i] or ""
        accn = r["accessionNumber"][i]
        doc = r["primaryDocument"][i]
        out.append({
            "form": form,
            "filed": r["filingDate"][i],
            "period": (r.get("reportDate") or [""] * (i + 1))[i],
            "items": items,
            "isEarnings": form == "8-K" and "2.02" in items,
            "desc": (r.get("primaryDocDescription") or [""] * (i + 1))[i],
            "url": f"https://www.sec.gov/Archives/edgar/data/{int(cik)}/{accn.replace('-', '')}/{doc}",
        })
        if len(out) >= n:
            break
    return out


# ---------------------------------------------------------------------------
# 가격 데이터
# ---------------------------------------------------------------------------
def yahoo_symbol(t: str) -> str:
    return t.replace(".", "-").upper()


def download_prices(symbols: list[str], years: int) -> dict[str, pd.DataFrame]:
    """yfinance 일괄 다운로드. Close는 분할만 반영된 실제 종가(TradingView 기본 차트와 동일 기준)."""
    import yfinance as yf

    out: dict[str, pd.DataFrame] = {}
    for attempt in range(3):
        todo = [s for s in symbols if s not in out]
        if not todo:
            break
        try:
            df = yf.download(todo, period=f"{years}y", interval="1d", auto_adjust=False,
                             group_by="ticker", threads=True, progress=False, timeout=30)
        except Exception as ex:  # noqa: BLE001
            warn(f"Yahoo 다운로드 오류(시도 {attempt + 1}): {ex}")
            time.sleep(5 * (attempt + 1))
            continue
        for s in todo:
            try:
                sub = df[s] if isinstance(df.columns, pd.MultiIndex) else df
                sub = sub[["Open", "High", "Low", "Close", "Volume"]].dropna(subset=["Close"])
                if len(sub) > 5:
                    sub.index = pd.to_datetime(sub.index).tz_localize(None)
                    out[s] = sub
            except (KeyError, TypeError):
                pass
        if len(out) < len(symbols):
            time.sleep(3)
    return out


def fmp_prices(symbol: str, years: int, key: str) -> pd.DataFrame | None:
    """백업: Financial Modeling Prep EOD (FMP_API_KEY 필요, 무료 250회/일)."""
    start = (dt.date.today() - dt.timedelta(days=365 * years)).isoformat()
    try:
        r = requests.get("https://financialmodelingprep.com/stable/historical-price-eod/full",
                         params={"symbol": symbol, "from": start, "apikey": key}, timeout=30)
        rows = r.json()
        if isinstance(rows, dict):
            rows = rows.get("historical", [])
        if not rows:
            return None
        df = pd.DataFrame(rows)
        df["date"] = pd.to_datetime(df["date"])
        df = df.set_index("date").sort_index()
        df = df.rename(columns={"open": "Open", "high": "High", "low": "Low", "close": "Close", "volume": "Volume"})
        return df[["Open", "High", "Low", "Close", "Volume"]]
    except Exception as ex:  # noqa: BLE001
        warn(f"FMP {symbol} 실패: {ex}")
        return None


def price_on_or_before(close: pd.Series, when: pd.Timestamp):
    s = close.loc[:when]
    return None if s.empty else float(s.iloc[-1])


PERIODS = {
    "r1W": pd.DateOffset(weeks=1), "r1M": pd.DateOffset(months=1), "r3M": pd.DateOffset(months=3),
    "r6M": pd.DateOffset(months=6), "r1Y": pd.DateOffset(years=1), "r3Y": pd.DateOffset(years=3),
}


def period_start(last: pd.Timestamp, key: str) -> pd.Timestamp:
    if key == "rYTD":
        return pd.Timestamp(last.year - 1, 12, 31)
    return last - PERIODS[key]


def returns_block(close: pd.Series) -> dict:
    last_d = close.index[-1]
    last = float(close.iloc[-1])
    out = {"r1D": (last / float(close.iloc[-2]) - 1) * 100 if len(close) > 1 else None}
    first_d = close.index[0]
    for k in list(PERIODS) + ["rYTD"]:
        st = period_start(last_d, k)
        if st < first_d - pd.Timedelta(days=5):   # 상장 전 구간은 계산 안 함
            out[k] = None
            continue
        p0 = price_on_or_before(close, st)
        out[k] = None if not p0 else (last / p0 - 1) * 100
    return {k: (None if v is None else round(v, 2)) for k, v in out.items()}


def vol_block(close: pd.Series) -> dict:
    lr = np.log(close).diff().dropna()
    out = {}
    for k in list(PERIODS) + ["rYTD"]:
        st = period_start(close.index[-1], k)
        seg = lr.loc[st:]
        out[k] = round(float(seg.std() * math.sqrt(252) * 100), 1) if len(seg) >= 15 else None
    out.pop("r1W", None)
    return out


def beta_vs(close: pd.Series, bench: pd.Series, years: int = 1):
    st = close.index[-1] - pd.DateOffset(years=years)
    a = close.pct_change().loc[st:]
    b = bench.pct_change().loc[st:]
    j = pd.concat([a, b], axis=1, join="inner").dropna()
    if len(j) < 120:
        return None
    var = j.iloc[:, 1].var()
    return round(float(j.iloc[:, 0].cov(j.iloc[:, 1]) / var), 2) if var else None


def history_pack(df: pd.DataFrame) -> dict:
    r = lambda s: [None if pd.isna(x) else round(float(x), 4) for x in s]  # noqa: E731
    return {
        "d": [d.strftime("%Y-%m-%d") for d in df.index],
        "o": r(df["Open"]), "h": r(df["High"]), "l": r(df["Low"]), "c": r(df["Close"]),
        "v": [None if pd.isna(x) else int(x) for x in df["Volume"]],
    }


# ---------------------------------------------------------------------------
# Yahoo 부가정보 (시가총액, Fwd P/E, 회사 설명 등)
# ---------------------------------------------------------------------------
EXCH_TV = {"NMS": "NASDAQ", "NGM": "NASDAQ", "NCM": "NASDAQ", "NASDAQ": "NASDAQ",
           "NYQ": "NYSE", "NYSE": "NYSE", "ASE": "AMEX", "PCX": "AMEX", "BTS": "BATS"}

YAHOO_TO_GICS = {
    "Technology": "Information Technology", "Communication Services": "Communication Services",
    "Consumer Cyclical": "Consumer Discretionary", "Consumer Defensive": "Consumer Staples",
    "Healthcare": "Health Care", "Financial Services": "Financials", "Industrials": "Industrials",
    "Energy": "Energy", "Utilities": "Utilities", "Basic Materials": "Materials", "Real Estate": "Real Estate",
}


def yahoo_info(sym: str) -> dict:
    import yfinance as yf

    for attempt in range(2):
        try:
            info = yf.Ticker(sym).get_info() or {}
            return info
        except Exception as ex:  # noqa: BLE001
            if attempt == 1:
                warn(f"Yahoo info {sym} 실패: {ex}")
            time.sleep(2)
    return {}


# ---------------------------------------------------------------------------
# iShares ETF 보유종목 (Russell 1000 = IWB, Russell 2000 = IWM)
# ---------------------------------------------------------------------------
ISHARES = {
    "IWB": "https://www.ishares.com/us/products/239707/ishares-russell-1000-etf/1467271812596.ajax?fileType=csv&fileName=IWB_holdings&dataType=fund",
    "IWM": "https://www.ishares.com/us/products/239710/ishares-russell-2000-etf/1467271812596.ajax?fileType=csv&fileName=IWM_holdings&dataType=fund",
}


def ishares_holdings(fund: str) -> list[dict]:
    """iShares 보유종목 CSV → [{ticker, name, sector, weight}] (주식만). 실패 시 지난 성공본 캐시 사용."""
    cache = CACHE / f"holdings_{fund}.json"
    try:
        r = requests.get(ISHARES[fund], timeout=60, headers={"User-Agent": "Mozilla/5.0"})
        r.raise_for_status()
        lines = r.content.decode("utf-8-sig", errors="replace").splitlines()
        hdr = next(i for i, l in enumerate(lines) if l.startswith("Ticker,"))
        h = pd.read_csv(io.StringIO("\n".join(lines[hdr:])), on_bad_lines="skip")
        if "Asset Class" in h.columns:
            h = h[h["Asset Class"] == "Equity"]
        h = h[h["Ticker"].astype(str).str.match(r"^[A-Z][A-Z0-9.\-]{0,6}$")]
        wcol = next((c for c in h.columns if c.startswith("Weight")), None)
        rows = [{"ticker": str(t).strip(), "name": str(n).strip().title(),
                 "sector": str(s).strip() if "Sector" in h.columns else "",
                 "weight": float(str(w).replace(",", "")) if wcol and str(w) not in ("nan", "-") else None}
                for t, n, s, w in zip(h["Ticker"], h["Name"], h["Sector"] if "Sector" in h.columns else [""] * len(h),
                                      h[wcol] if wcol else [None] * len(h))]
        if len(rows) < 100:
            raise ValueError(f"보유종목 수 이상({len(rows)})")
        CACHE.mkdir(exist_ok=True)
        cache.write_text(json.dumps(rows))
        return rows
    except Exception as ex:  # noqa: BLE001
        if cache.exists():
            warn(f"{fund} 보유종목 CSV 실패 → 지난 성공본 사용: {ex}")
            return json.loads(cache.read_text())
        warn(f"{fund} 보유종목 CSV 실패: {ex}")
        return []


def map_ticker(t: str, sec_map: dict) -> str:
    """iShares 표기(BRKB, BFB) → SEC/Yahoo 표기(BRK-B, BF-B)."""
    t = t.upper().replace(".", "-").replace(" ", "")
    if t in sec_map:
        return t
    if len(t) >= 3 and t[-1] in "ABCK" and f"{t[:-1]}-{t[-1]}" in sec_map:
        return f"{t[:-1]}-{t[-1]}"
    return t


def r2000_movers(n: int = 10) -> dict | None:
    import yfinance as yf

    hold = ishares_holdings("IWM")
    if not hold:
        return None
    meta = {yahoo_symbol(h["ticker"]): h for h in hold}
    syms = list(meta)
    rows = []
    for i in range(0, len(syms), 250):
        chunk = syms[i:i + 250]
        try:
            df = yf.download(chunk, period="7d", interval="1d", auto_adjust=False,
                             group_by="ticker", threads=True, progress=False, timeout=30)
        except Exception as ex:  # noqa: BLE001
            warn(f"R2000 시세 묶음 실패: {ex}")
            continue
        for s in chunk:
            try:
                sub = df[s][["Close", "Volume"]].dropna()
                if len(sub) < 2:
                    continue
                c0, c1 = float(sub["Close"].iloc[-2]), float(sub["Close"].iloc[-1])
                rows.append({"ticker": s, "date": sub.index[-1].strftime("%Y-%m-%d"), "price": round(c1, 2),
                             "r1D": round((c1 / c0 - 1) * 100, 2), "volume": int(sub["Volume"].iloc[-1]),
                             "name": meta[s]["name"], "sector": meta[s]["sector"]})
            except (KeyError, IndexError, ZeroDivisionError, ValueError):
                continue
        time.sleep(1.5)
    if not rows:
        return None
    latest = max(r["date"] for r in rows)
    rows = [r for r in rows if r["date"] == latest and r["price"] >= 1]
    rows.sort(key=lambda r: r["r1D"], reverse=True)
    return {"asOf": latest, "universeCount": len(rows), "gainers": rows[:n], "losers": rows[-n:][::-1],
            "source": "iShares IWM 보유종목 + Yahoo Finance 종가"}


# ---------------------------------------------------------------------------
# Yahoo 스크리너 기반 유니버스 (iShares CSV가 막힐 때의 기본 경로)
# ---------------------------------------------------------------------------
US_EXCH = ["NMS", "NGM", "NCM", "NYQ", "ASE"]
US_STATES = set("AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY PR".split())


def yahoo_screen(query, sort_field: str, asc: bool, total: int) -> list[dict]:
    import yfinance as yf

    out = []
    for off in range(0, total, 250):
        for attempt in range(3):
            try:
                r = yf.screen(query, offset=off, size=min(250, total - off), sortField=sort_field, sortAsc=asc)
                break
            except Exception as ex:  # noqa: BLE001
                if attempt == 2:
                    warn(f"Yahoo 스크리너 실패: {ex}")
                    return out
                time.sleep(5)
        qs = r.get("quotes", [])
        out += qs
        if len(qs) < 250:
            break
        time.sleep(1)
    return out


def universe_candidates(n_candidates: int = 1600) -> list[dict]:
    """미국 거래소 상장 보통주 시가총액 상위 후보. 실패 시 지난 성공본 캐시."""
    from yfinance import EquityQuery as EQ

    cache = CACHE / "universe_candidates.json"
    q = EQ("and", [EQ("eq", ["region", "us"]), EQ("is-in", ["exchange", *US_EXCH]), EQ("gte", ["intradaymarketcap", 5e8])])
    qs = yahoo_screen(q, "intradaymarketcap", False, n_candidates)
    rows = [{"ticker": x["symbol"].upper(), "name": x.get("longName") or x.get("shortName") or x["symbol"],
             "marketCap": x.get("marketCap"), "sector": YAHOO_TO_GICS.get(x.get("sector") or "", "")}
            for x in qs if x.get("quoteType", "EQUITY") == "EQUITY" and x.get("symbol")]
    if len(rows) >= 500:
        CACHE.mkdir(exist_ok=True)
        cache.write_text(json.dumps(rows))
        return rows
    if cache.exists():
        warn("Yahoo 스크리너 결과 부족 → 지난 성공본 유니버스 사용")
        return json.loads(cache.read_text())
    return rows


def is_us_company(sub: dict) -> bool:
    biz = ((sub.get("addresses") or {}).get("business") or {}).get("stateOrCountry") or ""
    forms = set((sub.get("filings") or {}).get("recent", {}).get("form", [])[:300])
    if forms & {"20-F", "40-F", "6-K"} and not forms & {"10-K", "10-Q"}:
        return False
    return biz in US_STATES


def sic_sector(sic: str | None, desc: str | None) -> str:
    try:
        c = int(sic or 0)
    except ValueError:
        c = 0
    d = (desc or "").lower()
    if c in (2833, 2834, 2835, 2836) or 3841 <= c <= 3851 or 8000 <= c <= 8099 or c == 6324:
        return "Health Care"
    if c in (3570, 3571, 3572, 3575, 3576, 3577, 3578, 3579, 3661, 3663, 3669, 3670, 3672, 3674, 3677, 3678, 3679, 3825, 3826, 7370, 7371, 7372, 7373, 7374, 7379):
        return "Information Technology"
    if c in (4812, 4813, 4822, 4841, 4899, 7812, 7819, 2711, 2721, 7370) or "broadcast" in d:
        return "Communication Services"
    if 1300 <= c <= 1399 or c in (2911, 4610, 4922, 4923, 5171, 5172, 2990):
        return "Energy"
    if 4900 <= c <= 4991:
        return "Utilities"
    if c == 6798 or 6500 <= c <= 6553:
        return "Real Estate"
    if 6000 <= c <= 6799:
        return "Financials"
    if c in (2000, 2011, 2013, 2015, 2020, 2024, 2030, 2033, 2040, 2050, 2060, 2070, 2080, 2082, 2086, 2090, 2092, 2100, 2111, 2840, 2842, 2844, 5140, 5141, 5411, 5412, 5331, 5399, 5912):
        return "Consumer Staples"
    if 1000 <= c <= 1499 or 2600 <= c <= 2699 or 2800 <= c <= 2829 or 2851 <= c <= 2899 or 3200 <= c <= 3399:
        return "Materials"
    if 5000 <= c <= 5999 or 7000 <= c <= 7299 or c in (3711, 3713, 3714, 3716, 3751, 2300, 2320, 2330, 3021, 3942, 3944, 3949, 2510, 2520, 3630, 3651, 7900, 7990, 8200):
        return "Consumer Discretionary"
    if 3400 <= c <= 3999 or 1500 <= c <= 1799 or 4000 <= c <= 4799 or 7300 <= c <= 7389 or 8700 <= c <= 8748:
        return "Industrials"
    return "기타"


def small_cap_movers(n: int = 10) -> dict | None:
    """미국 소형주(시총 3억~100억 달러) 전일 등락 상·하위 — Russell 2000 근사."""
    from yfinance import EquityQuery as EQ

    q = EQ("and", [EQ("eq", ["region", "us"]), EQ("is-in", ["exchange", *US_EXCH]),
                   EQ("btwn", ["intradaymarketcap", 3e8, 1e10]), EQ("gte", ["intradayprice", 2]),
                   EQ("gte", ["avgdailyvol3m", 200000])])
    conv = lambda x: {"ticker": x["symbol"], "name": x.get("shortName") or x.get("longName") or x["symbol"],  # noqa: E731
                      "price": x.get("regularMarketPrice"), "r1D": round(x.get("regularMarketChangePercent") or 0, 2),
                      "volume": x.get("regularMarketVolume"), "sector": x.get("sector") or ""}
    up = [conv(x) for x in yahoo_screen(q, "percentchange", False, n)]
    dn = [conv(x) for x in yahoo_screen(q, "percentchange", True, n)]
    if not up and not dn:
        return None
    return {"asOf": dt.date.today().isoformat(), "universeCount": None, "gainers": up, "losers": dn,
            "source": "Yahoo 스크리너: 미국 상장 시총 3억~100억 달러·주가 2달러↑·일평균 거래량 20만주↑ (Russell 2000 근사)"}


# ---------------------------------------------------------------------------
# SEC 대량 데이터: companyfacts.zip (하루 1회 일괄) → 실패 시 종목별 API
# ---------------------------------------------------------------------------
BULK_FACTS = "https://www.sec.gov/Archives/edgar/daily-index/xbrl/companyfacts.zip"


def open_bulk_facts(sec: "SecClient"):
    import zipfile

    p = CACHE / "companyfacts.zip"
    try:
        if not p.exists() or time.time() - p.stat().st_mtime > 20 * 3600:
            print("   SEC companyfacts.zip 다운로드 (약 1~2GB, 수 분)")
            CACHE.mkdir(exist_ok=True)
            tmp = p.with_suffix(".part")
            with sec.s.get(BULK_FACTS, stream=True, timeout=600) as r:
                r.raise_for_status()
                with open(tmp, "wb") as f:
                    for chunk in r.iter_content(1 << 20):
                        f.write(chunk)
            tmp.replace(p)
        return zipfile.ZipFile(p)
    except Exception as ex:  # noqa: BLE001
        warn(f"SEC 대량 파일 실패 → 종목별 조회로 전환: {ex}")
        return None


def company_facts(sec: "SecClient", z, cik: str) -> dict | None:
    if z is not None:
        try:
            return json.loads(z.read(f"CIK{cik}.json"))
        except KeyError:
            return None
        except Exception:  # noqa: BLE001
            pass
    return sec.get_json(f"https://data.sec.gov/api/xbrl/companyfacts/CIK{cik}.json", None)


# ---------------------------------------------------------------------------
# Yahoo 부가정보 캐시 (Fwd P/E·설명·시총) — 하루 호출 수 제한
# ---------------------------------------------------------------------------
def cached_yahoo_info(sym: str, budget: list, max_age_days: float = 7) -> dict:
    d = CACHE / "yinfo"
    p = d / f"{sym}.json"
    if p.exists():
        old = json.loads(p.read_text())
        if time.time() - old.get("_ts", 0) < max_age_days * 86400 or budget[0] <= 0:
            return old
    if budget[0] <= 0:
        return {}
    budget[0] -= 1
    info = yahoo_info(sym)
    time.sleep(0.35)
    keep = {k: info.get(k) for k in ("longName", "exchange", "marketCap", "forwardPE", "longBusinessSummary",
                                       "industry", "sector", "website", "firstTradeDateMilliseconds", "firstTradeDateEpochUtc")}
    if any(v is not None for v in keep.values()):
        keep["_ts"] = time.time()
        d.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(keep))
        return keep
    budget[1] += 1
    return json.loads(p.read_text()) if p.exists() else {}


def download_prices_chunked(symbols: list[str], years: int, chunk: int = 150) -> dict:
    out = {}
    for i in range(0, len(symbols), chunk):
        part = symbols[i:i + chunk]
        got = download_prices(part, years)
        out.update(got)
        print(f"   가격 {min(i + chunk, len(symbols))}/{len(symbols)} (성공 {len(out)})")
        time.sleep(2)
    return out


# ---------------------------------------------------------------------------
# Finnhub 뉴스 (선택)
# ---------------------------------------------------------------------------
def finnhub_get(path: str, key: str, **params):
    try:
        r = requests.get(f"https://finnhub.io/api/v1/{path}", params={**params, "token": key}, timeout=20)
        if r.status_code == 429:
            time.sleep(2)
            r = requests.get(f"https://finnhub.io/api/v1/{path}", params={**params, "token": key}, timeout=20)
        return r.json() if r.ok else None
    except Exception:  # noqa: BLE001
        return None


def news_item(n: dict) -> dict:
    return {"headline": n.get("headline"), "source": n.get("source"), "url": n.get("url"),
            "summary": (n.get("summary") or "")[:300],
            "time": dt.datetime.fromtimestamp(n.get("datetime", 0), dt.timezone.utc).isoformat()}


def company_news(sym: str, key: str, days: int = 4, n: int = 5) -> list:
    to = dt.date.today()
    rows = finnhub_get("company-news", key, symbol=sym, **{"from": (to - dt.timedelta(days=days)).isoformat(), "to": to.isoformat()})
    time.sleep(1.05)   # 무료 60회/분
    if not isinstance(rows, list):
        return []
    rows.sort(key=lambda x: x.get("datetime", 0), reverse=True)
    return [news_item(x) for x in rows[:n]]


# ---------------------------------------------------------------------------
# 메인
# ---------------------------------------------------------------------------
def clean(o):
    """NaN/inf → None (JSON 표준 준수)."""
    if isinstance(o, float):
        return None if (math.isnan(o) or math.isinf(o)) else o
    if isinstance(o, dict):
        return {k: clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [clean(v) for v in o]
    if isinstance(o, np.integer):
        return int(o)
    return o


def fkey(t: str) -> str:
    return "".join(ch if ch.isalnum() or ch == "-" else "_" for ch in t.upper())


def dump(path: Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(clean(obj), ensure_ascii=False, separators=(",", ":")))


def stock_record(t, u, df, info, fin, sub, cik, prices, bench_cfg):
    rec = {"ticker": t, "name": info.get("longName") or u.get("name") or sub.get("name") or t,
           "cik": cik, "sic": sub.get("sicDescription"),
           "gicsSector": u.get("sector") or YAHOO_TO_GICS.get(info.get("sector") or "", info.get("sector") or "기타"),
           "industry": info.get("industry"), "indexWeight": u.get("weight"),
           "exchange": EXCH_TV.get(info.get("exchange") or "", ((sub.get("exchanges") or [None])[0] or "").upper()),
           "description": info.get("longBusinessSummary"), "website": info.get("website")}
    if rec["exchange"] in ("NASDAQ", "NYSE", "AMEX"):
        rec["tvSymbol"] = f"{rec['exchange']}:{t.replace('-', '.')}"
    else:
        rec["tvSymbol"] = t.replace("-", ".")
    ftd = info.get("firstTradeDateMilliseconds") or (info.get("firstTradeDateEpochUtc") or 0) * 1000
    rec["firstTradeDate"] = dt.datetime.fromtimestamp(ftd / 1000, dt.timezone.utc).strftime("%Y-%m-%d") if ftd else None
    rec["hasFin"] = bool(fin)
    if df is None:
        return rec
    c = df["Close"]
    price = float(c.iloc[-1])
    rec.update({"price": round(price, 2), "priceAsOf": c.index[-1].strftime("%Y-%m-%d"), **returns_block(c),
                "volume": int(df["Volume"].iloc[-1]) if not pd.isna(df["Volume"].iloc[-1]) else None})
    hi = df["High"].loc[c.index[-1] - pd.DateOffset(years=1):].max()
    rec["high52"] = round(float(hi), 2) if not pd.isna(hi) else None
    rec["pctFromHigh"] = round((price / float(hi) - 1) * 100, 2) if rec["high52"] else None
    rec["vol"] = vol_block(c)
    rec["beta"] = {k: beta_vs(c, prices[b["yahoo"]]["Close"]) for k, b in bench_cfg.items() if b["yahoo"] in prices}
    mc, src = info.get("marketCap"), "Yahoo"
    if not mc and fin and fin.get("sharesOutstanding"):
        mc, src = fin["sharesOutstanding"] * price, "SEC 발행주식수 × 종가"
    if not mc and fin and fin["latest"].get("dilutedShares"):
        mc, src = fin["latest"]["dilutedShares"] * price, "SEC 희석주식수 × 종가(근사)"
    rec["mktCap"], rec["mktCapSource"] = (float(mc), src) if mc else (None, None)
    ttm = (fin or {}).get("ttm", {})
    lat = (fin or {}).get("latest", {})
    eps = ttm.get("epsDiluted")
    rec["epsTTM"] = round(eps, 2) if eps is not None else None
    rec["peTTM"] = round(price / eps, 1) if eps and eps > 0 else None
    fpe = info.get("forwardPE")
    rec["fwdPe"] = round(float(fpe), 1) if isinstance(fpe, (int, float)) and fpe > 0 else None
    rec["evEbitda"] = None
    if rec["mktCap"] and ttm.get("opIncome") is not None and ttm.get("dna") is not None:
        ebitda = ttm["opIncome"] + ttm["dna"]
        ev = rec["mktCap"] + (lat.get("totalDebt") or 0) - (lat.get("cashAndSti") or 0)
        rec["evEbitda"] = round(ev / ebitda, 1) if ebitda > 0 else None
    rec["pb"] = round(rec["mktCap"] / lat["equity"], 1) if rec["mktCap"] and lat.get("equity") and lat["equity"] > 0 else None
    rec["psTTM"] = round(rec["mktCap"] / ttm["revenue"], 1) if rec["mktCap"] and ttm.get("revenue") else None
    return rec


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default=str(ROOT / "config.json"))
    ap.add_argument("--out-dir", default=str(ROOT / "site" / "data"))
    ap.add_argument("--tickers", help="쉼표 구분 티커(테스트용) — 지정 시 유니버스 대신 사용")
    ap.add_argument("--max", type=int, default=0, help="지수 비중 상위 N종목만(테스트용)")
    ap.add_argument("--info-budget", type=int, default=250, help="하루 Yahoo 부가정보 신규 조회 한도")
    ap.add_argument("--no-movers", action="store_true")
    args = ap.parse_args()

    cfg = json.loads(Path(args.config).read_text())
    ua = " ".join((os.environ.get("SEC_USER_AGENT") or cfg.get("sec_user_agent", "")).split())
    if not ua or "your-email" in ua:
        sys.exit("SEC_USER_AGENT(이름 이메일)를 설정해 주세요 (SEC 접속 규정).")
    fh_key = os.environ.get("FINNHUB_API_KEY")
    fmp_key = os.environ.get("FMP_API_KEY")
    years = int(cfg.get("history_years", 5))
    nq = int(cfg.get("quarters_to_keep", 12))
    out = Path(args.out_dir)
    sec = SecClient(ua)

    print("① SEC 티커→CIK 매핑")
    tmap_raw = sec.get_json("https://www.sec.gov/files/company_tickers.json", "company_tickers.json", 24)
    sec_map = {v["ticker"].upper(): str(v["cik_str"]).zfill(10) for v in tmap_raw.values()}

    print("② 유니버스 구성")
    overrides = {u["ticker"].upper(): u for u in cfg.get("universe", [])}
    if args.tickers:
        uni = [{"ticker": t.strip().upper(), "name": t.strip().upper(), "sector": (overrides.get(t.strip().upper()) or {}).get("sector", "")}
               for t in args.tickers.split(",") if t.strip()]
        source = "지정 종목"
    elif cfg.get("universe_source") in ("IWB", "YAHOO_TOP"):
        hold = ishares_holdings("IWB") if cfg.get("universe_source") == "IWB" else []
        if hold:
            uni = [{**h, "ticker": map_ticker(h["ticker"], sec_map)} for h in hold]
            source = "Russell 1000 (iShares IWB 보유종목)"
        else:
            cands = universe_candidates()
            uni = [{**c, "ticker": map_ticker(c["ticker"], sec_map), "weight": c.get("marketCap")} for c in cands]
            uni = [u for u in uni if u["ticker"] in sec_map]
            source = "Russell 1000 근사 (미국 상장·미국 기업 시가총액 상위 1,000)"
            if not uni:
                uni = [{"ticker": u["ticker"], "sector": u.get("sector", "")} for u in cfg.get("universe", [])]
                source = "config 유니버스 (스크리너 실패)"
    else:
        uni = [{"ticker": u["ticker"], "sector": u.get("sector", "")} for u in cfg.get("universe", [])]
        source = "config 유니버스"
    seen, uni2 = set(), []
    for u in sorted(uni, key=lambda x: -(x.get("weight") or 0)):
        if u["ticker"] not in seen:
            seen.add(u["ticker"])
            uni2.append(u)
    target = args.max or int(cfg.get("universe_size", 1000))
    for u in uni2:
        if u["ticker"] in overrides and overrides[u["ticker"]].get("sector"):
            u["sector"] = overrides[u["ticker"]]["sector"]
    screen_mode = source.startswith("Russell 1000 근사")
    if screen_mode:
        print("   SEC 등록 정보로 외국 기업 제외 중")
        kept = []
        for u in uni2:
            if len(kept) >= target:
                break
            cik = sec_map.get(u["ticker"])
            try:
                sub = sec.get_json(f"https://data.sec.gov/submissions/CIK{cik}.json", f"sub/{cik}.json", 20)
            except Exception:  # noqa: BLE001
                continue
            if is_us_company(sub):
                if not u.get("sector"):
                    u["sector"] = sic_sector(sub.get("sic"), sub.get("sicDescription"))
                kept.append(u)
        uni = kept
    else:
        uni = uni2[:target] if (args.max or source.startswith("Russell 1000 (")) else uni2
    print(f"   {source}: {len(uni)}종목")

    print("③ 가격 (Yahoo 일괄)")
    bench_cfg = cfg["benchmarks"]
    ysyms = [yahoo_symbol(u["ticker"]) for u in uni] + [b["yahoo"] for b in bench_cfg.values()]
    prices = download_prices_chunked(ysyms, years)
    missing = [s for s in ysyms if s not in prices]
    if missing and fmp_key:
        for s in missing[:60]:
            df = fmp_prices(s, years, fmp_key)
            if df is not None and len(df) > 5:
                prices[s] = df
    miss2 = [s for s in ysyms if s not in prices]
    if miss2:
        warn(f"가격 데이터 없음 {len(miss2)}종목: {', '.join(miss2[:30])}{' …' if len(miss2) > 30 else ''}")

    benchmarks = {}
    for key, b in bench_cfg.items():
        df = prices.get(b["yahoo"])
        if df is None:
            benchmarks[key] = {"name": b["name"], "tv": b["tv"], "level": None}
            continue
        c = df["Close"]
        benchmarks[key] = {"name": b["name"], "tv": b["tv"], "yahoo": b["yahoo"], "level": round(float(c.iloc[-1]), 2),
                           "asOf": c.index[-1].strftime("%Y-%m-%d"), **returns_block(c),
                           "history": {"d": [d.strftime("%Y-%m-%d") for d in c.index], "c": [round(float(x), 2) for x in c]}}

    print("④ SEC 재무·공시 + Yahoo 부가정보")
    z = open_bulk_facts(sec) if len(uni) > 40 else None
    budget = [args.info_budget, 0]
    stocks = []
    for i, u in enumerate(uni, 1):
        t = u["ticker"]
        ys = yahoo_symbol(t)
        if i % 50 == 0 or i == len(uni):
            print(f"   {i}/{len(uni)}")
        info = cached_yahoo_info(ys, budget) if budget[1] < 25 else cached_yahoo_info(ys, [0, 0])
        if budget[1] == 25:
            warn("Yahoo 부가정보 조회가 연속 실패해 오늘은 중단(다음 실행 때 이어서 수집)")
            budget[1] += 1
        cik = sec_map.get(t)
        fin, sub, filings = None, {}, []
        if cik:
            try:
                sub = sec.get_json(f"https://data.sec.gov/submissions/CIK{cik}.json", f"sub/{cik}.json", 20)
                facts = company_facts(sec, z, cik)
                if facts:
                    fin = build_financials(facts, sub.get("fiscalYearEnd"), nq)
                    del facts
                filings = recent_filings(sub, cik)
            except Exception as ex:  # noqa: BLE001
                warn(f"{t} SEC 실패: {ex}")
        if fin:
            fin["cik"] = cik
        rec = stock_record(t, u, prices.get(ys), info, fin, sub, cik, prices, bench_cfg)
        rec["file"] = fkey(t)
        stocks.append(rec)
        df = prices.get(ys)
        if df is not None:
            dump(out / "hist" / f"{rec['file']}.json", history_pack(df))
        cn = company_news(t, fh_key) if (fh_key and i <= 40) else []
        dump(out / "fin" / f"{rec['file']}.json", {"financials": fin, "filings": filings, "news": cn})

    movers = None
    if cfg.get("r2000_movers", True) and not args.no_movers:
        print("⑤ Russell 2000 등락 상·하위")
        movers = small_cap_movers() if screen_mode else r2000_movers()
        if movers and fh_key:
            for row in movers["gainers"] + movers["losers"]:
                nn = company_news(row["ticker"], fh_key, days=3, n=1)
                row["news"] = nn[0] if nn else None

    market_news = []
    if fh_key:
        rows = finnhub_get("news", fh_key, category="general") or []
        market_news = [news_item(x) for x in rows[:12]] if isinstance(rows, list) else []

    now = dt.datetime.now(dt.timezone.utc)
    dump(out / "summary.json", {
        "meta": {
            "generatedAt": now.isoformat(), "generatedAtKST": now.astimezone(KST).strftime("%Y-%m-%d %H:%M KST"),
            "priceAsOf": max((s.get("priceAsOf") or "" for s in stocks), default=None),
            "universe": source, "universeSize": len(stocks),
            "sources": {"prices": "Yahoo Finance 일별 종가(분할 반영·배당 미반영)", "financials": "SEC EDGAR XBRL (GAAP)",
                        "universe": source, "fwdPe": "Yahoo 컨센서스", "news": "Finnhub" if fh_key else None,
                        "movers": movers["source"] if movers else None},
            "warnings": WARNINGS[:200],
        },
        "defaultPortfolio": cfg.get("default_portfolio", []),
        "benchmarks": benchmarks, "stocks": stocks, "movers": movers,
        "news": {"market": market_news},
    })
    print(f"완료 → {out} ({len(stocks)}종목, 경고 {len(WARNINGS)}건)")


if __name__ == "__main__":
    main()
