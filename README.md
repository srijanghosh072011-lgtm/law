# Ghosh Designs — site

Static site. Hand-written HTML and CSS, one small JavaScript file, no framework,
no build step. Open `index.html` in a browser and it works; deploy the folder
as-is and it works.

```
index.html                 Home
automation/index.html      Landing page — "automation"
websites/index.html        Landing page — "website design"
privacy/index.html         Privacy policy
assets/css/site.css        The whole design system
assets/js/site.js          Nav, tabs, scroll reveals (~110 lines)
assets/img/hero.webp       Hero background (2400w) + hero-sm.webp (1200w)
assets/img/make-hero.py    Regenerates those two files
_headers                   Security headers (Cloudflare Pages / Netlify)
robots.txt, sitemap.xml    Search
SECURITY.md                Pre-launch checklist — walk it before pointing DNS
```

## Landing pages

One page per search intent, rather than one homepage that mentions everything.
Each has its own `<title>`, meta description, canonical, OpenGraph tags and
JSON-LD (`Service` + `BreadcrumbList` + `FAQPage`), and each links to the other
two so a visitor landing cold can find the rest.

To add another (`/seo/`, `/shopify/`, `/local-seo/` …): copy
`automation/index.html`, change the head block, the JSON-LD, the copy, and the
`aria-current="page"` marker in the nav. Then add the URL to `sitemap.xml` and
the nav lists on the other pages. Nothing else to wire up.

## The hero background

`assets/img/hero.webp` is a synthesised out-of-focus sky over a meadow,
produced by `assets/img/make-hero.py` (Pillow, no other dependencies). It is an
original image, so nothing is licensed from anyone and there is no attribution
to carry. 18 KB at 2400px wide; the 1200px file served below 800px is 6 KB.

```
python3 assets/img/make-hero.py assets/img/hero.webp   # writes both sizes
```

Edit the palette or the horizon at the top of that script to re-tune it.

**A custom AI-generated image is planned for the hero** — that is the intended
final artwork, and what is committed now is the stand-in until it arrives.

**To swap in that image (or any photograph)**, drop the file in `assets/img/`
and change one line in `site.css`:

```css
:root { --hero-photo: url("/assets/img/your-photo.webp"); }
```

Pick something light and low-contrast in the upper two thirds — the heading is
dark ink and sits there. Convert to WebP and keep it under about 250 KB. If you
source it from Unsplash or Pexels, both allow commercial use; do not lift an
image off another company's site, which is what their licence forbids.

The gradients underneath stay in place as the fallback, so if the file is ever
missing the hero still renders correctly rather than going blank.

## Before it goes live

Two find-and-replace passes, then the checklist:

1. **Domain.** `https://ghoshdesigns.com` appears in canonical tags, OpenGraph
   URLs, JSON-LD, `robots.txt` and `sitemap.xml`. Replace with the real domain.
2. **Contact address.** `hello@ghoshdesigns.com` is used for every call to
   action. Replace with the real inbox — a custom-domain address, not a
   personal Gmail (SECURITY.md §3).
3. Walk `SECURITY.md` top to bottom.

### Where the checklist already stands

Done in this repo:

- `.gitignore` covers `.env`, `node_modules`, `.DS_Store` (§1)
- No secrets, keys or internal URLs anywhere in the source (§1)
- `_headers` ships HSTS, CSP, X-Content-Type-Options, X-Frame-Options,
  Referrer-Policy, Permissions-Policy, COOP and CORP (§4)
- No contact form, so no form attack surface — every CTA is a `mailto:` link
  and the CSP sets `form-action 'none'` (§5)
- Privacy policy exists, is linked from every footer, and describes what the
  site actually does — no cookies, no analytics, no forms (§6)
- The one raster image is WebP, self-hosted, served at two sizes and
  preloaded (it is the LCP element); every other graphic is inline SVG or
  CSS, so no third-party image host enters the CSP (§7)
- Semantic HTML, skip link, labelled landmarks, keyboard-driven tabs, visible
  focus rings, AA contrast, `prefers-reduced-motion` honoured (§9)
- `robots.txt` and `sitemap.xml` present; OpenGraph and Twitter tags set (§9)
- No `TODO`, `FIXME`, `console.log`, `localhost` or placeholder copy in the
  source (§10)

Still needs a human, because it is hosting and DNS rather than code:

- Deploy to Cloudflare Pages, Netlify or Vercel — `_headers` is ignored by
  plain GitHub Pages, and the CSP is most of the value here (§2)
- Cloudflare in front of the domain, DNSSEC on at the registrar, HTTPS
  enforced, SSL Labs A or better (§2)
- SPF, DKIM and DMARC (`p=quarantine` or stronger) on the sending domain (§3)
- Verify at securityheaders.com after the first deploy (§4)
- Uptime monitoring; Lighthouse run on the live URL (§7)
- Submit to Google Search Console (§9)
- Add a 1200×630 OpenGraph image and an `og:image` tag. The pages ship
  `twitter:card=summary` rather than `summary_large_image` so nothing points at
  a file that does not exist yet. `make-hero.py` can produce the artwork for
  it — change the output size at the top of the script.

### If a contact form is added later

Point the form at Formspree, Netlify Forms or Web3Forms, add a honeypot field,
turn on rate limiting in that dashboard, and add the endpoint host to
`form-action` in `_headers` — the CSP currently blocks all form submission.

## Local preview

```
python3 -m http.server 8000
```

Then open <http://localhost:8000>. Root-relative paths (`/assets/…`) need a
server, so opening the files directly from disk will load them unstyled.
