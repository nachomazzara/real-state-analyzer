# real-state-analyzer

Property analyzer for CABA / GBA Norte (Zonaprop, ArgenProp, Remax, MercadoLibre).
Computes USD/m² by neighborhood, room count, amenities and age, and ranks properties by yield.

## Run

```
docker compose up --build
```

Then open [http://localhost:3000](http://localhost:3000).

The SQLite database lives at `./data/analyzer.db` (mounted as a volume).

### Authenticating the Claude CLI (one-time setup)

The agent-based scrapers (Zonaprop, Remax, MercadoLibre) spawn `claude`
subprocesses inside the container. The container needs to reach the Anthropic
API on your behalf. Pick whichever auth path matches your host:

- **Linux host** with `claude login` already run: the compose file mounts
  `~/.claude` into the container; the file-based credentials are picked up
  automatically.
- **macOS host** (credentials live in the Keychain, not in a file):
  1. On the host run `claude setup-token` and copy the long-lived OAuth token.
  2. `cp .env.example .env` and set `CLAUDE_CODE_OAUTH_TOKEN=…`.
  3. `docker compose up --build`.

If neither path is configured, the three agent-based scrapers fail with an
auth error but the ArgenProp scraper continues to work and the rest of the
pipeline (stats, ranking, UI) functions normally.

## Business rules

- **Homogenized m²** = covered + uncovered × 0.5
- **Rental yield ≥ 5%**: for available units, `(monthly USD rent × 12) / sale price USD`
- **Build yield ≥ 5%**: for off-plan / under-construction units, the gap between the unit's `USD/m²` and the median `USD/m²` for "a estrenar disponible" listings in the same neighborhood + rooms + amenities
- **Off-plan / construction** units are included only when the corresponding toggle is on
- **Multi-neighborhood**: search accepts a list of neighborhoods; stats are computed per neighborhood plus an aggregate
- **ARS → USD** conversion via dolarapi.com (MEP / bolsa rate)
- **Floor (piso)** of the unit is extracted when present, either from structured attributes or parsed from the address / description

## Sources

| Source       | Status            | How it works                                                                                                                |
|--------------|--------------------|-----------------------------------------------------------------------------------------------------------------------------|
| ArgenProp    | ✅ HTTP            | Plain `fetch` + regex over the card markup (`data-item-card`, `card__main-features`, `card__address`). Fast and stable.     |
| MercadoLibre | 🤖 Claude agent    | Public API now requires OAuth (returns 403). A `claude` CLI subprocess driven by a per-source skill navigates the public listings pages and returns a JSON document. |
| Remax        | 🤖 Claude agent    | SPA whose internal API changes often. Delegated to a `claude` CLI subprocess + skill so changes don't require code edits.   |
| Zonaprop    | 🤖 Claude agent    | DataDome blocks plain HTTP. Delegated to a `claude` CLI subprocess + skill.                                                  |

Skill prompts live in `skills/*.md` and can be edited without touching the Node code.

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

## Security

- `.env*` is in both `.gitignore` and `.dockerignore`.
- No endpoint exposes `process.env`.
- `.claude/settings.json` denies shell commands that dump environment variables when Claude Code is assisting with this repo.
- The `~/.claude` mount is read-only.
