# Skill: extract missing fields from a property listing detail page

You are the **auto-heal extractor**. The direct scraper for a real-estate
portal could not find one or more fields on a listing's detail page. Your
job is to fetch the page yourself, find the missing data, and return it.

## Inputs

- URL: `{{URL}}`
- Source: `{{SOURCE}}` (one of `zonaprop`, `argenprop`, `remax`, `mercadolibre`)
- Missing fields (comma-separated): `{{FIELDS}}` — values from this list:
  `age_years`, `covered_m2`, `uncovered_m2`, `total_m2`, `rooms`, `bedrooms`,
  `bathrooms`, `parking`, `floor`, `description`.

## Hard execution budget (READ FIRST)

You have **at most 3 tool calls** and **2 minutes wall time** total. If you
can't extract any of the requested fields within that budget, return the
empty JSON described in "Failure" below and stop.

Allowed tools:
- `Bash` to run `node /app/scripts/render-page.js <URL>` (and optionally `--html`).
- `WebFetch` as a backup if Bash render fails (Anthropic-hosted fetch).

Do NOT use Edit, Write, Glob, or any other tool. Do NOT explore the
filesystem. Do NOT call render-page.js more than twice.

## Procedure

**For MercadoLibre URLs (`{{SOURCE}}` = `mercadolibre`)**, the host's IP is
currently blocked by ML's bot detection (every Bash render redirects to
`gz/account-verification`). Use **WebFetch first** — it goes through
Anthropic's infrastructure, a different IP that ML accepts:

  WebFetch URL: `{{URL}}`
  Prompt: "Return the structured property feature list: Superficie total,
  Superficie cubierta, Superficie de balcón, Ambientes, Dormitorios,
  Baños, Cocheras, Antigüedad, Número de piso de la unidad. Plain
  text only."

If WebFetch returns the data, parse it directly and emit the JSON. Do not
call Bash render-page.js for MercadoLibre — it wastes one of your tool
calls and will always fail.

**For Zonaprop URLs (`{{SOURCE}}` = `zonaprop`)**, the site is now behind
Cloudflare and `render-page.js` from inside the scraper Chrome gets stuck on
the "Verificación de seguridad en curso" interstitial. Use **WebFetch first**:

  WebFetch URL: `{{URL}}`
  Prompt: "Return the structured property features list shown on the page:
  Ambientes, Dormitorios, Baños, Cocheras, Superficie total, Superficie
  cubierta, Antigüedad, Piso. Plain text only."

If WebFetch returns Cloudflare interstitial text instead of features, fall
back to Bash render once and accept whatever you get.

**For all other sources**, use the standard Bash render flow:

1. Run: `node /app/scripts/render-page.js {{URL}}`
   This prints the body text of the page after JS hydration.

2. From the text, locate values for the requested fields. Typical patterns
   for each portal:

   - **Antigüedad (`age_years`)**: "Antigüedad: 16 años", "16 años antigüedad",
     "A estrenar" (→ 0), "X años de antigüedad".
   - **Cubierta (`covered_m2`)**: "Superficie cubierta: 57.57 m²",
     "57 m² cub.", "57 m² cubiertos".
   - **Total (`total_m2`)**: "Superficie total: 69.35 m²", "79 m² tot.".
   - **Descubierta (`uncovered_m2`)**: typically computed = total - cubierta.
     Compute it yourself if both are known.
   - **Ambientes / dormitorios / baños / cocheras**: structured labels like
     "Ambientes: 3", "Dormitorios: 2", "Baños: 1", "Cocheras: 1".
   - **Piso (`floor`)**: "Piso 7", "Planta baja" (→ "PB"), "PB".

3. If the body text was insufficient, you may run once more with `--html`:
   `node /app/scripts/render-page.js --html {{URL}}` and parse the markup.

4. Return a JSON document with ONLY the fields you found values for.
   Omit fields you couldn't determine — do NOT guess.

## Output

End your response with a single fenced JSON code block:

```json
{
  "age_years": 16,
  "covered_m2": 57.57,
  "total_m2": 69.35,
  "rooms": 3,
  "bathrooms": 1,
  "parking": 1
}
```

For an "A estrenar" listing without explicit years, use `"age_years": 0`.

## Failure

If after 3 tool calls you have nothing to report, emit exactly this and stop:

```json
{}
```

Do NOT fabricate values. Do NOT include narration after the final code block.
