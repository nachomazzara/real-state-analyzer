# real-state-analyzer

Property analyzer for CABA / GBA Norte. Aggregates listings from **ArgenProp,
Remax, Zonaprop** (via the UI) and **MercadoLibre** (via a standalone CLI —
see [HOW_TO_SCRAP_ML.md](HOW_TO_SCRAP_ML.md)). Computes USD/m² by
neighborhood, room count, amenities and age, and ranks properties by yield.
Includes a searchable, filterable ranking table and an interactive map view
with per-listing markers coloured by yield.

## Quick start

```bash
# 1. Clone + enter the repo, then create your .env (used for CLI runs; the
#    Docker container also reads it as a fallback).
cp .env.example .env
# Edit .env — set CLAUDE_CODE_OAUTH_TOKEN if you're on macOS (see below).

# 2. Boot everything.
docker compose up --build

# 3. Open http://localhost:3000 in your browser.
#    - Type a barrio in the search box (e.g. "núñez") + press Enter.
#    - Set filters (min yield, ambientes, cochera, etc), click "Analizar".
#    - Watch the job progress, then browse the ranking + map views.
```

The SQLite database lives at `./data/analyzer.db` (mounted as a Docker
volume — survives container rebuilds). All scraped listings, cursors,
geocodes and saved analyses persist there.

### Prerequisites

- **Docker + docker compose** (Docker Desktop or equivalent).
- **Node 20+** on the host — needed only if you plan to run the CLI
  scripts directly (see below). The web UI + Docker workflow doesn't
  require Node on the host.
- **Google Chrome** (stable channel) — needed only for the MercadoLibre
  workflow, which attaches to your real Chrome via CDP. See
  [HOW_TO_SCRAP_ML.md](HOW_TO_SCRAP_ML.md).
- **Anthropic account** — for the Claude-agent scrapers (Zonaprop, Remax).
  Free-tier is enough for casual use.

### Authenticating the Claude CLI (one-time setup)

The agent-based scrapers (Zonaprop, Remax) spawn `claude` subprocesses
inside the container. The container needs to reach the Anthropic API on
your behalf. Pick whichever auth path matches your host:

- **Linux host** with `claude login` already run: the compose file mounts
  `~/.claude` into the container; the file-based credentials are picked up
  automatically.
- **macOS host** (credentials live in the Keychain, not in a file):
  1. On the host run `claude setup-token` and copy the long-lived OAuth token.
  2. In `.env` set `CLAUDE_CODE_OAUTH_TOKEN=…`.
  3. `docker compose up --build`.

If neither path is configured, the two agent-based scrapers fail with an
auth error but the ArgenProp scraper continues to work and the rest of the
pipeline (stats, ranking, UI, geocoding) functions normally.

### Verifying the setup

Once the container is up, hit these sanity checks:

```bash
curl -s http://localhost:3000/healthz          # → {"ok":true}
curl -s http://localhost:3000/api/fx | head    # → { "usd_ars": 1234.5, … }
curl -s "http://localhost:3000/api/sources?neighborhoods=nunez" | head
```

Then load the UI, type "núñez" in the barrio search, and click "Analizar".
If the job runs and stats appear within ~2 minutes, you're wired up.

## Business rules

- **Homogenized m²** = covered + uncovered × 0.5
- **Rental yield ≥ 5%**: for available units, `(monthly USD rent × 12) / sale price USD`
- **Build yield ≥ 5%**: for off-plan / under-construction units, the gap between the unit's `USD/m²` and the median `USD/m²` for "a estrenar disponible" listings in the same neighborhood + rooms + amenities
- **Off-plan / construction** units are included only when the corresponding toggle is on
- **Multi-neighborhood**: search accepts a list of neighborhoods; stats are computed per neighborhood plus an aggregate
- **ARS → USD** conversion via dolarapi.com (MEP / bolsa rate)
- **Floor (piso)** of the unit is extracted when present, either from structured attributes or parsed from the address / description

## Sources

| Source       | Status                          | How it works                                                                                                                |
|--------------|---------------------------------|-----------------------------------------------------------------------------------------------------------------------------|
| ArgenProp    | ✅ HTTP                         | Plain `fetch` + regex over the card markup (`data-item-card`, `card__main-features`, `card__address`). Fast and stable.     |
| MercadoLibre | 🔧 Manual CLI ([HOW_TO_SCRAP_ML.md](HOW_TO_SCRAP_ML.md)) | Anti-bot fingerprints any Playwright Chrome. Excluded from the UI; runs only via `scripts/scrape-ml.js` which CDP-attaches to a user-launched Chrome. |
| Remax        | 🤖 Claude agent                 | SPA whose internal API changes often. Delegated to a `claude` CLI subprocess + skill so changes don't require code edits.   |
| Zonaprop     | 🤖 Claude agent                 | DataDome blocks plain HTTP. Delegated to a `claude` CLI subprocess + skill.                                                  |

Skill prompts live in `skills/*.md` and can be edited without touching the Node code.

## UI features

- **Saved analyses** — every search you run (barrios + filter combo) gets
  a stable UUID. Recent ones appear under "Análisis recientes" so you can
  jump back into an analysis without rebuilding the filters.
- **Multi-selection with tabs** — click "+ agregar" on any recent analysis
  to add it to the currently-open selection. Each analysis becomes a tab.
  - **Ranking + map merge across all selected tabs** (dedup by listing id),
    so you can compare properties from multiple searches in one view.
  - **Stats and "Estado por fuente" show the ACTIVE tab only** — click a
    tab header to switch.
  - Close a tab with the `×` to remove it from the selection; use "Nuevo
    análisis" to clear everything.
  - The whole selection persists in `localStorage` and restores on reload.
- **Map view** (`Tabla / Mapa` toggle above the ranking) — Leaflet + OSM
  tiles, no API key. Each property is a price-pill marker coloured by
  yield: green ≥8%, lime ≥6%, amber ≥5%, gray otherwise. Neighborhood
  polygons are drawn from `data/caba-barrios.json` (fetched via
  `scripts/build-caba-barrios.js` from the official GCBA dataset — GBA
  Norte barrios have no polygon and show markers only).
  - **Hover** a marker: full listing detail (price, ambientes, m²,
    yield, address). Compare pins side by side without clicking.
  - **Click** a marker: opens the listing URL directly in a new tab.
  - **Already-viewed markers** get a **violet border** (like a browser's
    visited-link colour) and a `✓` prefix so you can scan a busy map and
    see which you've already opened without losing the yield-colour
    signal. Persists in `localStorage`. Clear it via DevTools →
    Application → Local Storage → key `viewedListings`.
- **Analysis id + CLI copy buttons** — the "Análisis activo" panel shows
  the UUID and two buttons: `copiar id` and `copiar comando` (drops
  `node --env-file=.env scripts/run-analysis.js <id>` into your clipboard,
  ready to paste in a terminal).

## Geocoding

Addresses come back from the scrapers as raw seller-typed strings — full of
marketing prefixes, postal codes, building names, missing alturas, typos and
inconsistent intersection syntax. The pipeline turns those into `lat/lng`
through three layers in `src/pipeline/geocode.js`:

1. **Cleaner** (`cleanAddressForGeocoding`) — strips marketing prefixes,
   normalizes intersection separators (`&` / `e` / `esquina` → `y`), handles
   `Entre X y Y` cross-street references, collapses `STREET Al N` to
   `STREET N`, drops `Piso / Unidad / Depto` suffixes. Returns a canonical
   `STREET ALTURA` or `STREET y STREET` form, or `null` when there's no
   parsable address.
2. **Providers** — USIG (the official GCBA geocoder, CABA-only, no auth) as
   the primary, Nominatim (OpenStreetMap, AR-wide) as fallback. Several
   recovery passes run between them: `±altura` sweep (±1, ±2, …, ±200) for
   off-by-N alturas; Damerau-Levenshtein fuzzy match against the official
   CABA street catalog (`data/caba-streets.json`) for typos; progressive
   word-strip for listings that prepend a building name; `LAST, FIRST →
   FIRST LAST` swap when USIG resolves a catalog "Quiroga, Horacio" form
   to a same-named street in another AMBA partido.
3. **Zonaprop map fallback** — when text geocoding fails on a Zonaprop
   listing, `fetchMapCoords()` in `src/scrapers/zonaprop.js` opens the
   detail page in Playwright, clicks the `#article-map` widget so Google
   Maps hydrates inline, and parses lat/lng from the `maps.google.com/maps?ll=`
   anchors. Ground truth, ~5-15s per call, gated by
   `ZONAPROP_MAP_FALLBACK_CONCURRENCY` (default 2).

Recovery branches use a tighter CABA-proper bounds check when the raw text
mentions `Capital Federal` / `CABA`, so listings whose street name also
exists in Almirante Brown / Lanús / Vicente López get retried instead of
silently accepted at the wrong corner. Successful geocodes are cached in
the `geocode_cache` SQLite table keyed by the raw address text.

A standalone bench at `scripts/test-geocoder.js` runs the full pipeline
against every address in the DB and writes failures to `output_error.txt`
with the cleaned form and a classification (`cleaner-rejected`,
`intersection`, `title-text`, …) — useful when iterating on the cleaner.

## Neighborhoods & sub-zones

**Neighborhoods** are configured up-front in `data/neighborhoods.json`
(id, display name, aliases, per-source ids like `remax_location_id`). The
scraper passes a `neighborhood` object into `iterateListings()`, and every
listing it yields is tagged with `neighborhood = <id>`. There's no automatic
neighborhood inference from coordinates — if you want a new barrio scraped,
add it to that JSON.

**Sub-zones** are computed *after* geocoding in `src/pipeline/subzone.js` +
`subzone-labels.js`. Three passes:

1. **H3 cell assignment** — every `(lat, lng)` is mapped to an
   [H3](https://h3geo.org) cell at resolution 8 (~460m edge, ~0.7km²).
   The cell id (e.g. `882c1a3057fffff`) is stored as `sub_zone` on the
   listing. Resolution chosen empirically: res 8 gives 15-20 raw cells per
   big barrio which compresses cleanly to 3-5 final zones; res 9 was too
   fragmented (140 cells in Núñez, half with <3 listings).
2. **Avenue corridor overrides** — listings whose address contains a
   configured substring (e.g. `libertador`, `figueroa alcorta`) get pinned
   to a fixed `sub_zone` id like `av-libertador-nunez` *before* the merge
   pass, so premium avenues with a distinctly different price profile
   don't dissolve into the surrounding barrio. Configured per-barrio in
   `data/avenue-corridors.json`.
3. **Auto-merge sparse cells** — any cell with <300 listings gets absorbed
   into its densest H3 neighbor (ring-1 hexes first, ring-2 fallback,
   largest-cell-in-barrio as last resort). Iterates to convergence. Avenue
   corridors are skipped — they always survive even when small.

After all merges settle, each surviving cell gets a **human-readable label**:
the top-2 most-mentioned street names in that cell joined with `&`
(e.g. `Cabildo & Vidal`). Corridors use their configured label
(`Av. del Libertador (Núñez)`). Manual overrides go in an optional
`data/subzone-overrides.json` keyed by cell id.

The rent-match cascade falls back across these tiers when a listing's own
zone has too few comparables:
`sub_zone` → neighbor cells (ring 1, ring 2) → whole neighborhood → city.

## API

| Method | Path                                                          | Description                                                       |
|--------|----------------------------------------------------------------|-------------------------------------------------------------------|
| GET    | `/healthz`                                                     | Container health probe                                            |
| GET    | `/api/fx`                                                      | Current MEP rate                                                  |
| GET    | `/api/neighborhoods`                                           | Available neighborhoods                                           |
| POST   | `/api/search`                                                  | Body: `{ neighborhoods, include_pozo?, include_construccion?, force? }` — returns a `job_id` |
| GET    | `/api/jobs/:id`                                                | Job status and progress                                           |
| GET    | `/api/stats?neighborhoods=palermo,belgrano`                    | Per-neighborhood stats plus aggregate                             |
| GET    | `/api/properties?neighborhoods=palermo&min_yield=0.05`         | Ranked properties                                                 |

## Layout

```
src/
├── config.js          Config from env vars (safe defaults)
├── logger.js          Pino with redaction of sensitive fields
├── db.js              SQLite schema and migrations
├── fx.js              MEP rate (1h cache)
├── browser.js         Lazy Playwright pool
├── agent.js           Spawns `claude` CLI subprocesses for skill-driven scraping
├── server.js          Express, routes and static files
├── jobs.js            Job runner (in-memory + persisted)
├── scrapers/          One file per source, exposing iterateListings()
├── pipeline/          normalize, homogenize, filter, stats, rent-match, yield-rank, persist, orchestrator
└── routes/            One file per HTTP endpoint
public/                Vanilla HTML/JS/CSS UI
skills/                Markdown skills consumed by `agent.js`
seed/                  neighborhoods.json + rent-fallback.json (copied to data/ by the entrypoint)
docker/                entrypoint.sh
data/                  Docker volume (analyzer.db + seeded JSON files)
```

## Customization

- Edit `data/rent-fallback.json` to refine fallback rent estimates per neighborhood × room count.
- Edit `data/neighborhoods.json` to add neighborhoods or aliases.
- Edit `skills/*.md` to tune how the Claude-based scrapers navigate each site.
- Environment variables: `CACHE_TTL_HOURS`, `MAX_CONCURRENCY`, `INCREMENTAL_STOP_AFTER`, `FULL_REFRESH_DAYS`, `LOG_LEVEL`, `GEO_CONCURRENCY` (text-geocoder workers, default 8), `ZONAPROP_MAP_FALLBACK_CONCURRENCY` (parallel Playwright map fallbacks, default 2).

## Running an analysis from the CLI / CI

Every saved analysis has a stable UUID that appears in the UI ("Análisis
activo" card and the recent-analyses list) with copy buttons. Take that id
and run:

```
node --env-file=.env scripts/run-analysis.js <analysis-id>
```

By default this runs all three phases (**scrape → enrich → geocode**) for
all four sources, on every barrio in the analysis. Two filters let you
trim it down to whatever the CI step needs:

| Flag | Meaning |
|---|---|
| `--phase=enrich`            | Run only the enrich phase (skip scrape + geocode). Comma-separated subset of `scrape,enrich,geocode`. |
| `--source=zonaprop`         | Run only this source's pipeline. Comma-separated subset of `zonaprop,argenprop,remax`. |
| `--skip-scrape` etc.        | Shorthand inverse of `--phase`. |
| `--force`                   | Bypass the 24h `enrich_attempted_at` cooldown. |
| `--limit=N`                 | Cap listings per source per barrio (default 10000). |

> MercadoLibre is **not** handled by this script — its anti-bot wall needs
> CDP-attach to a user-launched Chrome. See [HOW_TO_SCRAP_ML.md](HOW_TO_SCRAP_ML.md)
> and use `scripts/scrape-ml.js` instead.

## Security

- `.env*` is in both `.gitignore` and `.dockerignore`.
- No endpoint exposes `process.env`.
- `.claude/settings.json` denies shell commands that dump environment variables when Claude Code is assisting with this repo.
- The `~/.claude` mount is read-only.
