# Skill: scrape MercadoLibre Inmuebles listing page

You are scraping one page of property listings from MercadoLibre Argentina
Inmuebles (inmuebles.mercadolibre.com.ar).

## Inputs

- Neighborhood slug: `{{NEIGHBORHOOD_ID}}`
- Neighborhood display name: `{{NEIGHBORHOOD_DISPLAY}}`
- Operation: `{{OPERATION}}` (one of `venta`, `alquiler`)
- Page offset (0-based items): `{{OFFSET}}`

## Hard execution budget (READ FIRST)

You have **at most 5 tool calls total** and **3 minutes wall time** for this
skill. Do NOT exceed them. If you reach the budget without success, emit the
empty-result JSON block (described in the "Failure" section at the bottom)
and STOP.

Do not loop trying variations endlessly. Do not retry the same URL more than
twice. Do not use the Task tool, Edit, Write, or any tool that modifies the
filesystem.

Allowed tools: `Bash` (for `curl` only) and `WebFetch`.

## Target URL and approach

The MercadoLibre public search API at `api.mercadolibre.com/sites/MLA/search`
now requires an OAuth token; do NOT call it. Use the public HTML instead.

**Step 1 — single `curl` attempt:**
Build this URL exactly:

```
https://listado.mercadolibre.com.ar/inmuebles/departamentos/{{OPERATION}}/capital-federal/{{NEIGHBORHOOD_ID}}/_Desde_{{OFFSET_PLUS_1}}_NoIndex_True
```

If `{{OFFSET}}` is 0, you may use the form without `_Desde_`:

```
https://listado.mercadolibre.com.ar/inmuebles/departamentos/{{OPERATION}}/capital-federal/{{NEIGHBORHOOD_ID}}/_NoIndex_True
```

Run exactly one curl with these flags (Bash tool):

```
curl -sS -L --max-time 25 \
  -A 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36' \
  -H 'Accept-Language: es-AR,es;q=0.9,en;q=0.8' \
  '<URL>' | head -c 1500000
```

**Step 2 — decide quickly:**
- If the response is shorter than 20 KB OR contains zero `ui-search-layout__item` strings → the site served a non-listing landing page. Go to "Failure" below.
- Otherwise extract listings as described.

**Step 3 — extract:**
Find `<li class="ui-search-layout__item">` blocks. Each contains:
- A permalink (`<a class="ui-search-link" href="...">`)
- Listing id from the URL (`MLA-12345678-...` or `MLA12345678` → `external_id = "MLA12345678"`)
- Price (`<span class="andes-money-amount__fraction">`) plus optional decimals
- Currency: `US$` / `USD` / `U$S` ⇒ `"USD"`; `$` alone ⇒ `"ARS"`
- Attributes (`<li class="poly-component__attributes-list__item">` or similar) with rooms / bedrooms / bathrooms / m²
- Neighborhood label

**Step 4 — single optional retry:**
If Step 1's curl returned nothing useful, you may call `WebFetch` **once** on
the SAME URL with the prompt: "Return the HTML body of property listing
cards on this page if any. If the page is a landing or captcha, say so."
Do not retry beyond that. Go to Failure if it still has no listings.

## Failure

If after Steps 1–4 you have zero listings, emit exactly this JSON block as
your final response and stop:

```json
{
  "page": {{OFFSET}},
  "has_more": false,
  "listings": []
}
```

Do NOT fabricate listings. Do NOT browse other neighborhoods or operations.

## Field mapping

For each listing:

- `external_id`: prefer the `MLA…` numeric id from the permalink URL
- `url`: absolute permalink
- `price`: numeric value of the fraction span; combine with decimals span
  if present
- `currency`: `"USD"` when the currency symbol contains `US$`/`USD`/`U$S`,
  otherwise `"ARS"`
- `rooms` / `bedrooms` / `bathrooms`: parsed from attribute strings such as
  "2 ambientes", "1 dormitorio", "1 baño"
- `covered_m2`: the value associated with "m² cubiertos" or "m² cubie"
- `total_m2`: the value associated with "m² totales"
- `age_years`: parse "X años" or "a estrenar" (0)
- `floor`: parse "Piso N" from the title or description, "PB" for "Planta Baja"
- `has_pool` / `has_garage` / `has_amenities`: keywords in title/description
  (`pileta`, `piscina`, `cochera`, `garage`, `gimnasio`, `seguridad`,
  `amenities`, `sum`, `laundry`)
- `description`: card title + short snippet, max 500 chars
- `neighborhood_raw`: the location string the card shows, e.g. "Palermo Soho"

## Verify the listing actually belongs to the requested neighborhood

Some MercadoLibre results include adjacent neighborhoods. After parsing, drop
any listing whose `neighborhood_raw` does not mention `{{NEIGHBORHOOD_DISPLAY}}`
or one of its common aliases (case-insensitive substring match). Use Spanish
diacritic-insensitive matching when possible.

## Output

Follow [skills/_listing-schema.md](_listing-schema.md). Set `has_more = true`
when the page shows pagination links beyond this page. End your response with
the single fenced JSON code block — nothing after it.
