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
- Environment variables: `CACHE_TTL_HOURS`, `MAX_CONCURRENCY`, `INCREMENTAL_STOP_AFTER`, `FULL_REFRESH_DAYS`, `LOG_LEVEL`.

## Security

- `.env*` is in both `.gitignore` and `.dockerignore`.
- No endpoint exposes `process.env`.
- `.claude/settings.json` denies shell commands that dump environment variables when Claude Code is assisting with this repo.
- The `~/.claude` mount is read-only.
