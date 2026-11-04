#!/usr/bin/env python3
"""Write SYNTHETIC demo data to site/data/ so the UI can be previewed offline.

The numbers are random walks around plausible levels - they are NOT market
data. The page shows a "Demo data" banner whenever it loads this file.
"""

import datetime as dt
import json
import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fetch_data as fd  # noqa: E402

LEVELS = {
    "US_1M": 3.9, "US_3M": 3.85, "US_6M": 3.75, "US_1Y": 3.6, "US_2Y": 3.5, "US_3Y": 3.5,
    "US_5Y": 3.65, "US_7Y": 3.85, "US_10Y": 4.1, "US_20Y": 4.6, "US_30Y": 4.7,
    "US_10Y_REAL": 1.8, "US_10Y_BE": 2.3,
    "EA_3M": 1.9, "EA_6M": 1.9, "EA_1Y": 1.95, "EA_2Y": 2.0, "EA_3Y": 2.1, "EA_5Y": 2.3,
    "EA_7Y": 2.45, "EA_10Y": 2.65, "EA_20Y": 2.95, "EA_30Y": 3.0,
    "UK_BANK": 4.0, "UK_5Y": 3.9, "UK_10Y": 4.45, "UK_20Y": 5.0,
    "CR_US_IG": 82, "CR_US_BBB": 105, "CR_US_HY": 290, "CR_EU_HY": 310, "CR_EM": 170,
    "EQ_SPX": 6700, "EQ_NDQ": 22500, "EQ_DJI": 46500, "EQ_NKY": 48000, "VOL_VIX": 17,
    "FX_EURUSD": 1.15, "FX_EURGBP": 0.87, "CM_BRENT": 66, "CM_GOLD": 3950,
}
VOL = {"pct": 0.035, "bp": 0.012, "index": 0.009, "fx": 0.004, "price": 0.013}


def main():
    rng = random.Random(42)
    hist = {"generated": fd.now_iso(), "demo": True, "layout": fd.LAYOUT, "series": {}, "errors": []}
    today = dt.date.today()
    days = [today - dt.timedelta(days=i) for i in range(fd.HISTORY_DAYS, 0, -1)]
    days = [d for d in days if d.weekday() < 5]
    common = [rng.gauss(0, 1) for _ in days]  # shared rates factor so curves move together

    raw = {}
    for sid, level in LEVELS.items():
        meta = fd.SERIES[sid]
        vol = VOL[meta["unit"]] * (0.6 if sid == "UK_BANK" else 1)
        if sid == "VOL_VIX":
            vol = 0.06
        x, path = level, []
        for i, d in enumerate(days[::-1]):  # walk backwards from today's level
            shock = 0.7 * common[i] + 0.7 * rng.gauss(0, 1) if meta["unit"] == "pct" else rng.gauss(0, 1)
            path.append([d.isoformat(), x])
            x = x - vol * shock if meta["unit"] == "pct" else x * (1 - vol * shock)
            if sid == "VOL_VIX":
                x = max(10, min(45, x + (17 - x) * 0.05))
        raw[sid] = path[::-1]

    raw["FX_GBPUSD"] = [[d, u / g] for (d, u), (_, g) in zip(raw["FX_EURUSD"], raw["FX_EURGBP"])]
    raw["FX_USDJPY"] = [[d, 152 * (1 + 0.02 * (u - 1.15) / 0.05)] for d, u in raw["FX_EURUSD"]]

    meta_all = dict(fd.SERIES)
    for sid, name, a, b in fd.DERIVED_SPREADS:
        da = dict(raw[a]); db = dict(raw[b])
        raw[sid] = [[d, (da[d] - db[d]) * 100] for d in da if d in db]
        meta_all[sid] = dict(name=name, short=name, unit="bp", change="bp", good="none", dp=0, source="derived")

    for sid, meta in meta_all.items():
        entry = {k: meta[k] for k in ("name", "short", "unit", "change", "good", "dp")}
        entry["source"] = "Synthetic demo data"
        if meta.get("live"):
            entry["live"] = meta["live"]
        if meta.get("short") in fd.TENOR_YEARS:
            entry["tenor"] = fd.TENOR_YEARS[meta["short"]]
        entry["data"] = [[d, round(v, 5)] for d, v in raw.get(sid, [])]
        hist["series"][sid] = entry

    now = dt.datetime.now(dt.timezone.utc).replace(microsecond=0)
    quotes = {"generated": fd.now_iso(), "demo": True, "errors": [], "quotes": {}}
    for sym, sid in (("GBP/USD", "FX_GBPUSD"), ("EUR/USD", "FX_EURUSD"), ("XAU/USD", "CM_GOLD")):
        last = hist["series"][sid]["data"][-1][1]
        quotes["quotes"][sym] = {"price": round(last * 1.002, 5), "prev_close": last,
                                 "time": (now - dt.timedelta(minutes=15)).isoformat(), "is_open": True}

    fd.OUT_DIR.mkdir(parents=True, exist_ok=True)
    (fd.OUT_DIR / "history.json").write_text(json.dumps(hist, separators=(",", ":")))
    (fd.OUT_DIR / "quotes.json").write_text(json.dumps(quotes, separators=(",", ":")))
    print(f"Wrote demo data to {fd.OUT_DIR}")


if __name__ == "__main__":
    main()
