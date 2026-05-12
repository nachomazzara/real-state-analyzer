# Skill: scrape Remax listing page

You are scraping one page of property listings from Remax Argentina (remax.com.ar).

## Inputs

- Neighborhood slug: `{{NEIGHBORHOOD_ID}}`
- Operation: `{{OPERATION}}` (one of `venta`, `alquiler`)
- Page number: `{{PAGE}}`

## Hard execution budget (READ FIRST)

At most **6 tool calls total** and **3 minutes wall time**. If you reach the
budget without success, emit the empty-result JSON (see "Failure" at the
bottom) and STOP. Allowed tools: `Bash` (curl) and `WebFetch`. Do not retry
the same URL more than twice.

## Target URL and API

Remax Argentina is a SPA backed by an internal JSON API. Its shape changes
over time, so adapt rather than hard-coding — but cap your attempts.

1. **First curl** the HTML page (one call):
   ```
   curl -sS -L --max-time 25 \
     -A 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36' \
     -H 'Accept-Language: es-AR,es;q=0.9,en;q=0.8' \
     'https://www.remax.com.ar/listings/{{REMAX_OP}}?page={{PAGE}}&type=departamento&locations={{NEIGHBORHOOD_ID}}' \
     | head -c 2000000
   ```
   Where `{{REMAX_OP}}` is `buy` for venta, `rent` for alquiler.

   Look in the HTML for an embedded JSON object: `window.__INITIAL_STATE__`,
   `window.__NEXT_DATA__`, or `__NUXT__`. Or any inline JSON with an array
   of objects containing `listingId`/`slug`/`priceUsd`.

2. **If the HTML is just the SPA shell** with no embedded listings, try ONE
   `WebFetch` on the same URL with prompt: "Return any inline JSON
   containing property listings, and the URLs of any /api/ or /proxy/
   endpoints called by the bundled JS."

3. **At most two additional curls** (total budget = 4 of your 6 calls) to
   API endpoints discovered in step 2 (e.g. `https://api.remax.com.ar/api/proxy/Listings?...`).
   Stop after the first one returns parseable JSON with listings.

## Field mapping

For each listing:

- `external_id` = `id` or `listingId` or `slug` (as string)
- `url` = `https://www.remax.com.ar/listings/<slug>` when `slug` is available
- `price`, `currency`:
  - Prefer `priceUsd` → currency `"USD"`
  - Fall back to `price.amount` + `price.currency`
- `rooms`, `bedrooms`, `bathrooms`: `totalRooms`/`rooms`, `bedrooms`, `bathrooms`
- `covered_m2` = `dimensionCovered` or `dimensions.covered`
- `total_m2` = `dimensionTotalBuilt` or `totalSurface` or `dimensions.total`
- `age_years` = `age` or `antiguedad`
- `floor` = look for `floor`, `unitFloor`, `piso`; otherwise null
- `has_pool` / `has_garage` / `has_amenities`: from the `features`/`amenities`
  array and the description text (keywords `pileta`, `cochera`, `parking`,
  `gimnasio`, `seguridad`, `sum`, `laundry`, `amenities`)
- `description` = `title` + " " + short `description` snippet, max 500 chars
- `neighborhood_raw` = `location.name` or `address.neighborhood`

## Output

Follow the schema in [skills/_listing-schema.md](_listing-schema.md). When
you've returned all the listings from this page, end with the single fenced
JSON code block and nothing after it. Set `has_more` based on whether the
API/JSON response indicates more pages exist; when unclear and you returned
≥10 listings, assume `has_more = true`.

If you cannot find any listings (the page is fully blocked or the API has
changed beyond recognition), return an empty `listings` array and `has_more = false`. Do not fabricate data.
