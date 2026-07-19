# Security & edge-traffic notes

This site is a static Astro build deployed via **Cloudflare Workers Static
Assets** (`wrangler.toml`, `npx wrangler deploy`). It has no server, no
database, and no user input — so the security surface is almost entirely
about **filtering noise traffic at the Cloudflare edge** rather than
hardening application code.

## Background: the 4xx / scanner-traffic problem

Cloudflare edge analytics showed **41% of requests returning 4xx**. The
reality is that this site is a static converter tool; very few real paths
404. The bulk of those 4xx responses come from **automated scanner
traffic** probing paths that only exist on other kinds of sites:

- `/.env`, `/.git/config`, `/.aws/credentials`, `/.ssh/*` — secret/config theft
- `/wp-admin/`, `/wp-login.php`, `/wp-config.php`, `/xmlrpc.php` — WordPress exploits
- `/cgi-bin/`, `/vendor/`, `/node_modules/` — legacy / dependency exposure

Against this Astro site every one of those is a 404. They are **non-cacheable
soft-404s**, and at volume they do two things: inflate the 4xx rate, and
*dilute the cache-hit rate* (the cacheable `/_astro/*` and HTML requests get
out-counted by uncacheable 404s).

## What lives in the repo (and what its limits are)

- **`public/robots.txt`** — `Disallow` entries for the same probe paths.
  - ⚠️ **`robots.txt` is hygiene for honest crawlers, not enforcement.**
    Malicious scanners ignore it. It stops *legitimate* bots from generating
    404s against these paths, but it does not stop the attackers themselves.
- **`src/pages/404.astro` → `dist/404.html`** — a branded, cacheable 404 page,
  served by `wrangler.toml`'s `not_found_handling = "404-page"`. This improves
  UX and lets the occasional real 404 be edge-cached, but it does not reduce
  the *count* of scanner 404s.
- **`public/sitemap.xml`** — alias of the generated `sitemap-index.xml` so
  bots probing `/sitemap.xml` get a 200 instead of a 404.

## Enforcement: the WAF custom rule (configure in the Cloudflare dashboard)

WAF rules live in your Cloudflare zone, not in this repo (Workers Static
Assets deploys no Worker code that could intercept these). Configure this in
**Security → WAF → Custom rules**:

- **Rule name:** `block known scanner probe paths`
- **Action:** `Block` (returns **403**). A 403 here is served as a static
  Cloudflare response and is **cacheable and fast**, which both removes these
  requests from the soft-404 count *and* stops them diluting the cache-hit
  rate. (Prefer `Block` over `Managed Challenge` for pure probe paths — there
  is no human to challenge.)
- **Expression:**

  ```
  (
    http.request.uri.path in {
      "/.env", "/.git/config", "/wp-admin/", "/wp-login.php",
      "/xmlrpc.php", "/wp-config.php", "/.aws/credentials", "/cgi-bin/"
    }
  )
  or (starts_with(http.request.uri.path, "/.git/"))
  or (starts_with(http.request.uri.path, "/wp-admin"))
  or (starts_with(http.request.uri.path, "/vendor/"))
  or (starts_with(http.request.uri.path, "/node_modules/"))
  ```

### Optional second rule (use carefully)

A separate, narrowly-scoped **Managed Challenge** rule for tool-style
User-Agents (`curl`, `python-requests`, `scrapy`, `httpx`, etc.) can cut
additional automated load. Keep it on a **separate** rule and scope it
tightly, because challenging `curl` wholesale would also challenge legitimate
HTTP-based health checks and monitors.

```
(http.user_agent contains "curl") or (http.user_agent contains "python-requests") or (http.user_agent contains "scrapy") or (http.user_agent contains "httpx")
```

Action: `Managed Challenge`. Do NOT combine this with the probe-path Block
rule above — keep them separate so you can disable the UA rule independently
if it causes false positives.

## What is intentionally NOT done yet

- **Cache headers on `/_astro/*` and HTML.** Workers Static Assets does **not**
  honor a `public/_headers` file (that's a Cloudflare Pages concept). Raising
  the edge cache TTL on fingerprinted assets requires a minimal edge Worker
  with `run_worker_first` that sets `Cache-Control: public, max-age=31536000,
  immutable` on `/_astro/*` and `max-age=0, must-revalidate` on HTML. That was
  deferred deliberately until the 4xx fix above lands and analytics are
  re-measured — a chunk of the low cache-hit rate is expected to be the
  scanner-404 dilution the WAF rule removes, not a cache-config problem.
