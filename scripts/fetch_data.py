#!/usr/bin/env python3
"""Fetch market data for the dashboard and write site/data/*.json.

Uses only the Python standard library so it runs anywhere (including a bare
GitHub Actions runner) with no `pip install`.

Sources
-------
* FRED (St Louis Fed)  - US Treasury curve, ICE BofA credit spreads, US/JP
                          equity index closes, VIX, Brent. Keyless CSV.
* ECB Data Portal      - euro area AAA government yield curve, EUR FX
                          reference rates. Keyless.
* Bank of England IADB - gilt yields and Bank Rate. Keyless.
* Twelve Data          - OPTIONAL. ~15-min delayed / live quotes and daily
                          history for symbols not covered above. Needs a free
                          API key in the TWELVEDATA_API_KEY environment
                          variable; without it these series are just skipped.

Usage
-----
    python scripts/fetch_data.py --mode full     # rebuild everything
    python scripts/fetch_data.py --mode quotes   # refresh live quotes only

In `quotes` mode the script tries to reuse the history file that is already
published (``--history-url``) so the keyless sources are only hit once a day.
If that is not available it falls back to a full rebuild.

Every source is fetched independently: a failure is logged and recorded in the
output's ``errors`` list, and the rest of the dashboard still builds.
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import io
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "site" / "data"

HISTORY_DAYS = 2 * 366 + 14  # two years plus a margin for the "2Y" view
USER_AGENT = "Mozilla/5.0 (compatible; personal-markets-dashboard/1.0)"

# --------------------------------------------------------------------------
# Series definitions
#
# unit:   how the value is shown       pct | bp | index | fx | price
# change: how a move is shown          bp  | pct | abs
# good:   which direction is coloured green: up | down | none
# dp:     decimal places for the value
# --------------------------------------------------------------------------

def fred(code, name, unit, change, good="none", dp=2, scale=1.0, short=None):
    return dict(source="fred", code=code, name=name, short=short or name, unit=unit,
                change=change, good=good, dp=dp, scale=scale)


def ecb_yc(tenor, name, short):
    return dict(source="ecb_yc", code=tenor, name=name, short=short, unit="pct",
                change="bp", good="none", dp=2)


def boe(code, name, short):
    return dict(source="boe", code=code, name=name, short=short, unit="pct",
                change="bp", good="none", dp=2)


SERIES: dict[str, dict] = {
    # --- US Treasuries (FRED, constant maturity, % ) ----------------------
    "US_1M": fred("DGS1MO", "US 1M T-bill", "pct", "bp", short="1M"),
    "US_3M": fred("DGS3MO", "US 3M T-bill", "pct", "bp", short="3M"),
    "US_6M": fred("DGS6MO", "US 6M T-bill", "pct", "bp", short="6M"),
    "US_1Y": fred("DGS1", "US 1Y", "pct", "bp", short="1Y"),
    "US_2Y": fred("DGS2", "US 2Y Treasury", "pct", "bp", short="2Y"),
    "US_3Y": fred("DGS3", "US 3Y", "pct", "bp", short="3Y"),
    "US_5Y": fred("DGS5", "US 5Y Treasury", "pct", "bp", short="5Y"),
    "US_7Y": fred("DGS7", "US 7Y", "pct", "bp", short="7Y"),
    "US_10Y": fred("DGS10", "US 10Y Treasury", "pct", "bp", short="10Y"),
    "US_20Y": fred("DGS20", "US 20Y", "pct", "bp", short="20Y"),
    "US_30Y": fred("DGS30", "US 30Y Treasury", "pct", "bp", short="30Y"),
    "US_10Y_REAL": fred("DFII10", "US 10Y real (TIPS)", "pct", "bp"),
    "US_10Y_BE": fred("T10YIE", "US 10Y breakeven", "pct", "bp"),

    # --- Euro area AAA curve (ECB, spot rates, %) -------------------------
    "EA_3M": ecb_yc("3M", "EUR AAA 3M", "3M"),
    "EA_6M": ecb_yc("6M", "EUR AAA 6M", "6M"),
    "EA_1Y": ecb_yc("1Y", "EUR AAA 1Y", "1Y"),
    "EA_2Y": ecb_yc("2Y", "EUR AAA 2Y", "2Y"),
    "EA_3Y": ecb_yc("3Y", "EUR AAA 3Y", "3Y"),
    "EA_5Y": ecb_yc("5Y", "EUR AAA 5Y", "5Y"),
    "EA_7Y": ecb_yc("7Y", "EUR AAA 7Y", "7Y"),
    "EA_10Y": ecb_yc("10Y", "EUR AAA 10Y", "10Y"),
    "EA_20Y": ecb_yc("20Y", "EUR AAA 20Y", "20Y"),
    "EA_30Y": ecb_yc("30Y", "EUR AAA 30Y", "30Y"),

    # --- UK gilts (Bank of England IADB, %) -------------------------------
    "UK_BANK": boe("IUDBEDR", "BoE Bank Rate", "Bank Rate"),
    "UK_5Y": boe("IUDSNPY", "UK 5Y gilt (par)", "5Y"),
    "UK_10Y": boe("IUDMNPY", "UK 10Y gilt (par)", "10Y"),
    "UK_20Y": boe("IUDLNPY", "UK 20Y gilt (par)", "20Y"),

    # --- Credit: ICE BofA option-adjusted spreads (FRED gives %, shown bp) -
    "CR_US_IG": fred("BAMLC0A0CM", "US IG corporate OAS", "bp", "bp", good="down", dp=0, scale=100),
    "CR_US_BBB": fred("BAMLC0A4CBBB", "US BBB OAS", "bp", "bp", good="down", dp=0, scale=100),
    "CR_US_HY": fred("BAMLH0A0HYM2", "US high yield OAS", "bp", "bp", good="down", dp=0, scale=100),
    "CR_EU_HY": fred("BAMLHE00EHYIOAS", "Euro high yield OAS", "bp", "bp", good="down", dp=0, scale=100),
    "CR_EM": fred("BAMLEMCBPIOAS", "EM corporate OAS", "bp", "bp", good="down", dp=0, scale=100),

    # --- Equities (FRED daily closes) -------------------------------------
    "EQ_SPX": fred("SP500", "S&P 500", "index", "pct", good="up", dp=0),
    "EQ_NDQ": fred("NASDAQCOM", "Nasdaq Composite", "index", "pct", good="up", dp=0),
    "EQ_DJI": fred("DJIA", "Dow Jones", "index", "pct", good="up", dp=0),
    "EQ_NKY": fred("NIKKEI225", "Nikkei 225", "index", "pct", good="up", dp=0),

    # --- Volatility ---------------------------------------------------------
    "VOL_VIX": fred("VIXCLS", "VIX", "index", "abs", good="down", dp=2),

    # --- FX (ECB reference rates; GBPUSD / USDJPY derived) ----------------
    "FX_EURUSD": dict(source="ecb_fx", code="USD", name="EUR/USD", short="EUR/USD",
                      unit="fx", change="pct", good="none", dp=4, live="EUR/USD"),
    "FX_EURGBP": dict(source="ecb_fx", code="GBP", name="EUR/GBP", short="EUR/GBP",
                      unit="fx", change="pct", good="none", dp=4, live="EUR/GBP"),
    "FX_GBPUSD": dict(source="derived", name="GBP/USD", short="GBP/USD", unit="fx",
                      change="pct", good="none", dp=4, live="GBP/USD"),
    "FX_USDJPY": dict(source="derived", name="USD/JPY", short="USD/JPY", unit="fx",
                      change="pct", good="none", dp=2, live="USD/JPY"),

    # --- Commodities ------------------------------------------------------
    "CM_BRENT": fred("DCOILBRENTEU", "Brent crude ($/bbl)", "price", "pct", dp=2),
    "CM_GOLD": dict(source="twelvedata", code="XAU/USD", name="Gold ($/oz)", short="Gold",
                    unit="price", change="pct", good="none", dp=0, live="XAU/USD"),
}

# Spreads computed from other series: (id, name, long leg, short leg)
DERIVED_SPREADS = [
    ("US_2S10S", "US 2s10s", "US_10Y", "US_2Y"),
    ("EA_2S10S", "EUR AAA 2s10s", "EA_10Y", "EA_2Y"),
    ("UK_5S20S", "UK 5s20s", "UK_20Y", "UK_5Y"),
]

# Twelve Data symbols worth adding if you have a PAID plan (the free plan
# covers US stocks/ETFs, FX and crypto, not index levels). Map a series id to a
# Twelve Data symbol here and it gets live quotes + daily history, e.g.
#   "EQ_UKX": dict(source="twelvedata", code="<symbol>", name="FTSE 100", ...)
# Check the exact symbol with https://api.twelvedata.com/symbol_search?symbol=FTSE

# --------------------------------------------------------------------------
# Dashboard layout (the front end is driven entirely by this)
# --------------------------------------------------------------------------

LAYOUT = [
    {
        "id": "rates", "title": "Government yields",
        "curves": [
            {"id": "US", "title": "US Treasuries",
             "points": ["US_1M", "US_3M", "US_6M", "US_1Y", "US_2Y", "US_3Y", "US_5Y",
                        "US_7Y", "US_10Y", "US_20Y", "US_30Y"]},
            {"id": "UK", "title": "UK gilts",
             "points": ["UK_BANK", "UK_5Y", "UK_10Y", "UK_20Y"]},
            {"id": "EA", "title": "Euro AAA",
             "points": ["EA_3M", "EA_6M", "EA_1Y", "EA_2Y", "EA_3Y", "EA_5Y", "EA_7Y",
                        "EA_10Y", "EA_20Y", "EA_30Y"]},
        ],
        "tiles": ["US_2Y", "US_10Y", "US_30Y", "US_2S10S", "US_10Y_REAL", "US_10Y_BE",
                  "UK_10Y", "UK_5S20S", "EA_2Y", "EA_10Y", "EA_2S10S", "UK_BANK"],
    },
    {"id": "credit", "title": "Credit spreads",
     "tiles": ["CR_US_IG", "CR_US_BBB", "CR_US_HY", "CR_EU_HY", "CR_EM"]},
    {"id": "equity", "title": "Equities & volatility",
     "tiles": ["EQ_SPX", "EQ_NDQ", "EQ_DJI", "EQ_NKY", "VOL_VIX"]},
    {"id": "fx", "title": "FX & commodities",
     "tiles": ["FX_GBPUSD", "FX_EURUSD", "FX_EURGBP", "FX_USDJPY", "CM_BRENT", "CM_GOLD"]},
]

# Tenor in years for curve x-axis positions (Bank Rate sits at overnight).
TENOR_YEARS = {"Bank Rate": 0.003, "1M": 1 / 12, "3M": 0.25, "6M": 0.5, "1Y": 1, "2Y": 2,
               "3Y": 3, "5Y": 5, "7Y": 7, "10Y": 10, "20Y": 20, "30Y": 30}


# --------------------------------------------------------------------------
# HTTP helpers
# --------------------------------------------------------------------------

def http_get(url: str, timeout: int = 45, retries: int = 3) -> str:
    last = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT,
                                                       "Accept": "*/*"})
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.read().decode("utf-8-sig", errors="replace")
        except (urllib.error.URLError, TimeoutError, ConnectionError) as exc:
            last = exc
            time.sleep(2 ** (attempt + 1))
    raise RuntimeError(f"GET failed after {retries} attempts: {url} ({last})")


def to_float(text: str):
    text = (text or "").strip()
    if text in ("", ".", "NA", "N/A", "null"):
        return None
    try:
        return float(text)
    except ValueError:
        return None


# --------------------------------------------------------------------------
# Source fetchers - each returns {date_iso: value}
# --------------------------------------------------------------------------

def fetch_fred(code: str, start: dt.date) -> dict[str, float]:
    url = ("https://fred.stlouisfed.org/graph/fredgraph.csv?"
           + urllib.parse.urlencode({"id": code, "cosd": start.isoformat()}))
    rows = list(csv.reader(io.StringIO(http_get(url))))
    out = {}
    for row in rows[1:]:
        if len(row) >= 2 and (v := to_float(row[1])) is not None:
            out[row[0][:10]] = v
    if not out:
        raise RuntimeError(f"FRED {code}: no observations")
    return out


def fetch_ecb(flow_key: str, start: dt.date) -> dict[str, dict[str, float]]:
    """Return {series_key: {date: value}} for an ECB SDMX key (may contain '+')."""
    url = (f"https://data-api.ecb.europa.eu/service/data/{flow_key}?"
           + urllib.parse.urlencode({"format": "csvdata", "startPeriod": start.isoformat()}))
    reader = csv.DictReader(io.StringIO(http_get(url)))
    out: dict[str, dict[str, float]] = {}
    for row in reader:
        v = to_float(row.get("OBS_VALUE"))
        if v is None:
            continue
        out.setdefault(row.get("KEY", ""), {})[row["TIME_PERIOD"][:10]] = v
    if not out:
        raise RuntimeError(f"ECB {flow_key}: no observations")
    return out


def fetch_boe(codes: list[str], start: dt.date) -> dict[str, dict[str, float]]:
    params = {
        "csv.x": "yes", "Datefrom": start.strftime("%d/%b/%Y"), "Dateto": "now",
        "SeriesCodes": ",".join(codes), "CSVF": "TN", "UsingCodes": "Y",
        "VPD": "Y", "VFD": "N",
    }
    url = ("https://www.bankofengland.co.uk/boeapps/database/_iadb-fromshowcolumns.asp?"
           + urllib.parse.urlencode(params))
    text = http_get(url)
    if "<html" in text[:500].lower():
        raise RuntimeError("BoE returned HTML instead of CSV (request blocked or format changed)")
    rows = list(csv.reader(io.StringIO(text)))
    header = [h.strip().upper() for h in rows[0]]
    out: dict[str, dict[str, float]] = {c: {} for c in codes}
    for row in rows[1:]:
        if not row or not row[0].strip():
            continue
        try:
            d = dt.datetime.strptime(row[0].strip(), "%d %b %Y").date().isoformat()
        except ValueError:
            continue
        for i, col in enumerate(header[1:], start=1):
            if col in out and i < len(row) and (v := to_float(row[i])) is not None:
                out[col][d] = v
    if not any(out.values()):
        raise RuntimeError("BoE: no observations")
    return out


class TwelveData:
    BASE = "https://api.twelvedata.com"
    PER_MINUTE = 8  # free plan limit (credits per minute)

    def __init__(self, key: str):
        self.key = key
        self.used_this_minute = 0
        self.minute_start = time.monotonic()

    def _throttle(self, credits: int):
        if time.monotonic() - self.minute_start > 61:
            self.used_this_minute, self.minute_start = 0, time.monotonic()
        if self.used_this_minute + credits > self.PER_MINUTE:
            wait = 62 - (time.monotonic() - self.minute_start)
            if wait > 0:
                print(f"  twelvedata: rate limit pause {wait:.0f}s")
                time.sleep(wait)
            self.used_this_minute, self.minute_start = 0, time.monotonic()
        self.used_this_minute += credits

    def _get(self, path: str, params: dict, credits: int):
        self._throttle(credits)
        params = dict(params, apikey=self.key)
        data = json.loads(http_get(f"{self.BASE}/{path}?" + urllib.parse.urlencode(params)))
        if isinstance(data, dict) and data.get("status") == "error":
            raise RuntimeError(f"Twelve Data: {data.get('message')}")
        return data

    def daily(self, symbol: str, days: int) -> dict[str, float]:
        data = self._get("time_series", {"symbol": symbol, "interval": "1day",
                                         "outputsize": min(5000, int(days * 5 / 7) + 10)}, 1)
        return {v["datetime"][:10]: float(v["close"]) for v in data.get("values", [])}

    def quotes(self, symbols: list[str]) -> dict[str, dict]:
        out = {}
        for i in range(0, len(symbols), self.PER_MINUTE):
            chunk = symbols[i:i + self.PER_MINUTE]
            data = self._get("quote", {"symbol": ",".join(chunk)}, len(chunk))
            if len(chunk) == 1:
                data = {chunk[0]: data}
            for sym, q in data.items():
                if not isinstance(q, dict) or q.get("status") == "error" or "close" not in q:
                    print(f"  twelvedata quote {sym}: {q.get('message') if isinstance(q, dict) else q}")
                    continue
                ts = q.get("timestamp") or q.get("last_quote_at")
                out[sym] = {
                    "price": float(q["close"]),
                    "prev_close": to_float(q.get("previous_close")),
                    "time": (dt.datetime.fromtimestamp(int(ts), dt.timezone.utc).isoformat()
                             if ts else None),
                    "is_open": q.get("is_market_open"),
                }
        return out


# --------------------------------------------------------------------------
# Build
# --------------------------------------------------------------------------

def log(msg: str):
    print(msg, flush=True)


def build_history(td: TwelveData | None) -> dict:
    start = dt.date.today() - dt.timedelta(days=HISTORY_DAYS)
    data: dict[str, dict[str, float]] = {}
    errors: list[str] = []

    def attempt(label, fn):
        try:
            fn()
        except Exception as exc:  # noqa: BLE001 - keep going, record the failure
            log(f"  ! {label}: {exc}")
            errors.append(f"{label}: {exc}")

    # FRED, one request per series (polite pause between)
    for sid, s in SERIES.items():
        if s["source"] != "fred":
            continue
        def go(sid=sid, s=s):
            raw = fetch_fred(s["code"], start)
            data[sid] = {d: v * s["scale"] for d, v in raw.items()}
            log(f"  fred {s['code']:<16} {len(raw):>4} obs")
        attempt(f"FRED {s['code']}", go)
        time.sleep(0.4)

    # ECB yield curve - one request for all tenors
    yc = {sid: s for sid, s in SERIES.items() if s["source"] == "ecb_yc"}
    def go_yc():
        key = "YC/B.U2.EUR.4F.G_N_A.SV_C_YM." + "+".join(f"SR_{s['code']}" for s in yc.values())
        res = fetch_ecb(key, start)
        for sid, s in yc.items():
            match = next((v for k, v in res.items() if k.endswith(f"SR_{s['code']}")), None)
            if match:
                data[sid] = match
        log(f"  ecb yield curve  {len(res)} tenors")
    attempt("ECB yield curve", go_yc)

    # ECB FX reference rates (quoted as X per EUR)
    fx = {sid: s for sid, s in SERIES.items() if s["source"] == "ecb_fx"}
    def go_fx():
        ccys = sorted({s["code"] for s in fx.values()} | {"USD", "GBP", "JPY"})
        res = fetch_ecb("EXR/D." + "+".join(ccys) + ".EUR.SP00.A", start)
        per_eur = {c: next((v for k, v in res.items() if f".{c}.EUR." in k), {}) for c in ccys}
        for sid, s in fx.items():
            data[sid] = per_eur[s["code"]]
        usd, gbp, jpy = per_eur["USD"], per_eur["GBP"], per_eur["JPY"]
        data["FX_GBPUSD"] = {d: usd[d] / gbp[d] for d in usd if d in gbp and gbp[d]}
        data["FX_USDJPY"] = {d: jpy[d] / usd[d] for d in jpy if d in usd and usd[d]}
        log(f"  ecb fx           {', '.join(ccys)}")
    attempt("ECB FX", go_fx)

    # Bank of England
    bo = {sid: s for sid, s in SERIES.items() if s["source"] == "boe"}
    def go_boe():
        res = fetch_boe([s["code"] for s in bo.values()], start)
        for sid, s in bo.items():
            if res.get(s["code"]):
                data[sid] = res[s["code"]]
        log(f"  boe              {', '.join(s['code'] for s in bo.values())}")
    attempt("Bank of England", go_boe)

    # Twelve Data daily history
    for sid, s in SERIES.items():
        if s["source"] != "twelvedata":
            continue
        if not td:
            errors.append(f"{s['name']}: needs TWELVEDATA_API_KEY")
            continue
        def go_td(sid=sid, s=s):
            data[sid] = td.daily(s["code"], HISTORY_DAYS)
            log(f"  twelvedata {s['code']:<10} {len(data[sid]):>4} obs")
        attempt(f"Twelve Data {s['code']}", go_td)

    # Derived spreads (in bp)
    derived_meta = {}
    for sid, name, long_leg, short_leg in DERIVED_SPREADS:
        a, b = data.get(long_leg, {}), data.get(short_leg, {})
        vals = {d: (a[d] - b[d]) * 100 for d in a if d in b}
        if vals:
            data[sid] = vals
        derived_meta[sid] = dict(name=name, short=name, unit="bp", change="bp",
                                 good="none", dp=0, source="derived")

    series_out = {}
    all_meta = {**SERIES, **derived_meta}
    for sid, meta in all_meta.items():
        obs = data.get(sid)
        entry = {k: meta[k] for k in ("name", "short", "unit", "change", "good", "dp")}
        entry["source"] = describe_source(sid, meta)
        if meta.get("live"):
            entry["live"] = meta["live"]
        if meta.get("short") in TENOR_YEARS:
            entry["tenor"] = TENOR_YEARS[meta["short"]]
        entry["data"] = [[d, round(obs[d], 6)] for d in sorted(obs)] if obs else []
        series_out[sid] = entry

    return {
        "generated": now_iso(),
        "demo": False,
        "layout": LAYOUT,
        "series": series_out,
        "errors": errors,
    }


def describe_source(sid: str, meta: dict) -> str:
    src = meta.get("source")
    if src == "fred":
        return f"FRED {meta['code']}"
    if src == "ecb_yc":
        return "ECB euro area AAA yield curve"
    if src in ("ecb_fx",):
        return "ECB reference rate"
    if src == "boe":
        return f"Bank of England {meta['code']}"
    if src == "twelvedata":
        return f"Twelve Data {meta['code']}"
    if sid.startswith("FX_"):
        return "Derived from ECB reference rates"
    return "Derived"


def build_quotes(td: TwelveData | None) -> dict:
    out = {"generated": now_iso(), "quotes": {}, "errors": []}
    if not td:
        out["errors"].append("No TWELVEDATA_API_KEY set - live quotes disabled")
        return out
    symbols = sorted({s["live"] for s in SERIES.values() if s.get("live")})
    try:
        out["quotes"] = td.quotes(symbols)
        log(f"  twelvedata quotes: {len(out['quotes'])}/{len(symbols)}")
    except Exception as exc:  # noqa: BLE001
        log(f"  ! quotes: {exc}")
        out["errors"].append(str(exc))
    return out


def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()


def try_reuse_history(url: str | None) -> dict | None:
    if not url:
        return None
    try:
        hist = json.loads(http_get(url, retries=1))
        age = dt.datetime.now(dt.timezone.utc) - dt.datetime.fromisoformat(hist["generated"])
        if hist.get("demo") or age > dt.timedelta(hours=30):
            log(f"  published history unusable (demo={hist.get('demo')}, age={age})")
            return None
        return hist
    except Exception as exc:  # noqa: BLE001
        log(f"  could not reuse published history: {exc}")
        return None


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--mode", choices=["full", "quotes"], default="full")
    ap.add_argument("--history-url", help="URL of the currently published data/history.json")
    ap.add_argument("--out", default=str(OUT_DIR))
    args = ap.parse_args()

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    key = os.environ.get("TWELVEDATA_API_KEY", "").strip()
    td = TwelveData(key) if key else None

    history = try_reuse_history(args.history_url) if args.mode == "quotes" else None
    if history is None:
        log("Building full history...")
        history = build_history(td)
    else:
        log("Reusing published history; refreshing quotes only.")

    log("Fetching live quotes...")
    quotes = build_quotes(td)

    (out_dir / "history.json").write_text(json.dumps(history, separators=(",", ":")))
    (out_dir / "quotes.json").write_text(json.dumps(quotes, separators=(",", ":")))

    filled = sum(1 for s in history["series"].values() if s["data"])
    log(f"Wrote {out_dir}: {filled}/{len(history['series'])} series with data, "
        f"{len(quotes['quotes'])} live quotes, {len(history['errors'])} errors.")
    # Fail the run only if essentially nothing worked, so a single flaky
    # source never takes the whole dashboard down.
    return 0 if filled >= len(history["series"]) // 3 else 1


if __name__ == "__main__":
    sys.exit(main())
