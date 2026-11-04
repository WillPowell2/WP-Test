# Morning Markets

A personal "mini-Bloomberg" dashboard for the commute. It covers yield curves, credit spreads, equity indices, the VIX and FX, each with a 1M / 3M / 6M / YTD / 1Y / 2Y history slicer. It is one web app that works on a phone and a PC. You can install it on your home screen, and it still opens with the last data it loaded when you have no signal.

## What's on it

| Section | Series | Source | Freshness |
|---|---|---|---|
| Government yields | US Treasury curve 1M–30Y, 10Y real yield, 10Y breakeven, 2s10s | FRED (US Treasury) | End of day |
| | Euro area AAA curve 3M–30Y, 2s10s | ECB Data Portal | End of day |
| | UK gilts 5Y / 10Y / 20Y (par), Bank Rate, 5s20s | Bank of England | End of day |
| Credit spreads | ICE BofA OAS: US IG, US BBB, US HY, Euro HY, EM corporates | FRED | End of day, about 1 day behind |
| Equities & vol | S&P 500, Nasdaq, Dow, Nikkei 225, VIX | FRED | Previous close |
| FX & commodities | GBP/USD, EUR/USD, EUR/GBP, USD/JPY, Brent, Gold | ECB, FRED, Twelve Data | Daily, plus about 15-min delayed quotes if a Twelve Data key is set |

How to use it:

- **Tap any tile** to open a full chart with a crosshair, plus the start, latest, high and low for the selected range.
- **The yield-curve card** shows today's curve against the curve at the start of the range, and a change-by-tenor bar chart in bp underneath.
- **Change colours:** for spreads and the VIX, *tighter/lower* is shown in green. For equities, *up* is green. Yields and FX use neutral colours.

## How it works

```
GitHub Actions (cron) ──► scripts/fetch_data.py ──► site/data/*.json ──► GitHub Pages ──► your phone / PC
```

- No server to run. The fetch script uses only the Python standard library and calls keyless public sources (FRED, ECB, BoE).
- **Schedule:** a full rebuild runs at 05:35 and 22:35 UTC on weekdays. If you add a Twelve Data key, delayed quotes also refresh every 30 minutes from 06:00 to 20:00 UTC.
- **API keys** stay in GitHub Secrets and never reach the browser.
- **Failures:** if a source fails, the rest of the dashboard still updates. The problem is listed under "Data issues" in the page footer.

## Setup (one-off, about 5 minutes)

1. **Merge this branch into `main`.** GitHub only runs scheduled workflows on the default branch.
2. **Turn on Pages:** go to repo **Settings → Pages → Build and deployment → Source: GitHub Actions**. On a free GitHub plan, Pages needs the repo to be public. The data is public market data and keys stay secret, so that's fine.
3. **Optional, for live FX and gold:** create a free key at [twelvedata.com](https://twelvedata.com). Add it under **Settings → Secrets and variables → Actions → New repository secret**, with the name `TWELVEDATA_API_KEY`.
4. **Run the first build:** go to **Actions → Update market data & deploy → Run workflow**. When it finishes, the site is at `https://<your-username>.github.io/<repo-name>/`.
5. **Install it on your phone:**
   - **iPhone:** open the site in Safari → Share → *Add to Home Screen*.
   - **Android:** open it in Chrome → menu → *Install app*.

## Preview locally with demo data

```bash
python3 scripts/make_demo_data.py      # writes SYNTHETIC numbers to site/data/
python3 -m http.server -d site 8000    # open http://localhost:8000
```

The page shows a "Demo data" banner whenever it is using the synthetic file. To fetch real data locally, run `python3 scripts/fetch_data.py` instead.

## Customising

All series and the page layout are defined at the top of `scripts/fetch_data.py`:

- `SERIES` lists every data series. To add a FRED series, add one line such as `fred("BAMLC0A1CAAA", "US AAA OAS", "bp", "bp", good="down", dp=0, scale=100)`.
- `DERIVED_SPREADS` defines curve spreads such as 2s10s.
- `LAYOUT` sets which sections, curves and tiles appear, and in what order.

The front end (`site/`) needs no changes when you add series.

**Live European indices** (FTSE 100, DAX, Euro Stoxx 50): FRED does not carry these, and Twelve Data's free plan does not include index levels. A paid data plan adds them. Map the symbol in `SERIES` with `source="twelvedata"` and it will get both history and delayed quotes.
