# Skill: scrape Zonaprop listing page

You are scraping one page of property listings from Zonaprop (zonaprop.com.ar).

## Inputs

- Neighborhood slug: `{{NEIGHBORHOOD_ID}}`
- Operation: `{{OPERATION}}` (one of `venta`, `alquiler`)
- Page number: `{{PAGE}}`

## Target URL

Build the URL from these inputs:

```
https://www.zonaprop.com.ar/departamentos-{{OPERATION}}-{{NEIGHBORHOOD_ID}}.html
```

If `{{PAGE}}` is greater than 1, append `-pagina-{{PAGE}}` before `.html`:

```
https://www.zonaprop.com.ar/departamentos-{{OPERATION}}-{{NEIGHBORHOOD_ID}}-pagina-{{PAGE}}.html
```

## Hard execution budget (READ FIRST)

At most **5 tool calls total** and **3 minutes wall time**. If you reach
the budget without success, emit the empty-result JSON (see "Failure" at the
bottom) and STOP. Allowed tools: `Bash` (curl) and `WebFetch`. Do not use any
other tool. Do not retry the same URL more than twice.

## How to scrape

1. **One curl attempt:**

   ```
   curl -sS -L --max-time 25 \
     -A 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36' \
     -H 'Accept-Language: es-AR,es;q=0.9,en;q=0.8' \
     '<URL>' | head -c 2000000
   ```

   Look for `<script id="__NEXT_DATA__"…>…</script>`. If present, parse the
   JSON inside and walk it looking for objects with `postingId` (or `id` +
   `priceOperationTypes`). Those are the listings. Zonaprop's schema varies
   over time — recognize listings by the *combination* of `postingId`, a
   price field, and a location field, not by a fixed path.

2. **If the response is a DataDome challenge** (body contains `datadome`,
   `Just a moment`, `geo.captcha-delivery.com`, or is under 30 KB without
   `__NEXT_DATA__`), make **one** `WebFetch` call on the same URL with the
   prompt: "Return the JSON content of the `__NEXT_DATA__` script tag and a
   short description if the page is a captcha challenge." Do not retry.

3. If still nothing, go to "Failure".

## Field mapping

For each listing object you found:

- `external_id` = `postingId` (as string)
- `url` = `https://www.zonaprop.com.ar` + `url` field (if present; otherwise build from `postingId`)
- `price` and `currency`:
  - Prefer `priceOperationTypes[0].prices[0].amount` + `.currency`
  - Fall back to `priceInUSD` (then currency is `"USD"`)
- `rooms` = `rooms` or `ambientes`
- `bedrooms` = `bedrooms` or `dormitorios`
- `bathrooms` = `bathrooms` or `banos`
- `covered_m2` = `coveredSurface` or `coveredArea`
- `total_m2` = `totalSurface` or `totalArea` or `surface`
- `age_years` = `age` or `antiguedad` (null if "a estrenar" without years)
- `floor` = look for a numeric "piso" field; otherwise parse from the
  address or title
- `has_pool` / `has_garage` / `has_amenities`: search `features` array and
  the title/description text for keywords (`pileta`, `cochera`, `amenities`,
  `gimnasio`, `seguridad`, `sum`, `laundry`)
- `description` = concatenate `title` + ` ` + a short snippet of
  `description`, max 500 chars
- `neighborhood_raw` = `location.name` or `location.neighborhood`

## Output

Follow the shared schema described in [skills/_listing-schema.md](_listing-schema.md).

Set `has_more` to `true` if the JSON indicates more pages exist (look for
`paging`, `totalCount`, `currentPage`, etc.). When unclear and you returned
the typical page size (~20 listings), assume `has_more = true`.

End your response with the single fenced JSON code block — nothing after it.

## Failure

If after the steps above you have zero listings, emit exactly:

```json
{ "page": {{PAGE}}, "has_more": false, "listings": [] }
```

Do NOT invent listings. Do NOT visit other neighborhoods.
