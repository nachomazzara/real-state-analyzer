# Shared listing schema

Every scraping skill must emit a single fenced JSON block at the very end of
its response, with the following shape. Use `null` for any field you cannot
determine; never invent values. Do NOT include narration after the final code
block.

```json
{
  "page": 1,
  "has_more": true,
  "listings": [
    {
      "external_id": "string — the portal's own listing id",
      "url": "string — absolute URL to the listing detail page",
      "price": 123000,
      "currency": "USD" or "ARS",
      "rooms": 2,
      "bedrooms": 1,
      "bathrooms": 1,
      "covered_m2": 45,
      "uncovered_m2": 8,
      "total_m2": 53,
      "age_years": 12,
      "floor": "5" or "PB" or null,
      "has_pool": true,
      "has_garage": false,
      "has_amenities": true,
      "amenities": ["pileta", "gimnasio", "seguridad"],
      "description": "short title or description (max 500 chars)",
      "neighborhood_raw": "string as labeled by the site"
    }
  ]
}
```

Field rules:

- `external_id` and `url` are mandatory. Skip any listing that lacks them.
- Sale prices in Argentina are usually USD; rentals are usually ARS. Always
  populate `currency` from what the site explicitly states — never guess.
- `covered_m2` and `total_m2` may differ. If the site only shows total,
  populate `total_m2` and leave `covered_m2` null. The pipeline will compute
  the homogenized area downstream.
- `floor` is the unit's floor in the building (the apartment "piso"), e.g.
  "5" for fifth floor, "PB" for planta baja. Use null when the listing is a
  house, PH, or doesn't disclose it.
- Off-plan or under-construction listings: include them; the pipeline will
  classify them via the `description` field. Make sure phrases like "en pozo",
  "en construcción", "preventa", "entrega 2027" appear in `description` when
  the site indicates them, so the classifier can pick them up.

Pagination: set `has_more` to true if there are more pages of results
beyond this batch. The orchestrator may invoke you again with an incremented
`{{PAGE}}`.

Volume per call: aim for one page of results (typically 20–50 listings). Do
not try to scrape every page in a single invocation — the orchestrator
controls pagination.
