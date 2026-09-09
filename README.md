# Ghosh Designs — site

Static site. Hand-written HTML and CSS, one small JavaScript file, no framework,
no build step. Serve the folder and it works (see Local preview below — the
root-relative paths need a server, so opening a file from disk will not do).

```
index.html                 Home
automation/index.html      Landing page — "automation"
websites/index.html        Landing page — "website design"
seo/index.html             Landing page — "SEO"
local-seo/index.html       Landing page — "local SEO"
privacy/index.html         Privacy policy
assets/css/site.css        The whole design system
assets/js/site.js          Nav, tabs, scroll reveals (~110 lines)
assets/img/hero.webp       Hero background (1536w) + hero-sm.webp (1200w)
tools/hero-source.jpg      The original the two WebPs are cut from
tools/prepare-hero.py      Re-cuts them if you replace the original
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

`assets/img/hero.webp` (1536w) and `hero-sm.webp` (1200w, served under 800px)
are cut from `tools/hero-source.jpg`, kept in the repo so they can be
regenerated without hunting for the original. The source is 1536x1024, so it
is scaled up about 1.2x to cover the hero on a large screen — close enough to
native that it holds up.

`tools/` is build input, not site content. If your host publishes the repo
root, exclude that folder in its build settings so the original and the script
are not served.

To replace it, drop the new picture in and re-run the converter. It writes the
same two filenames the stylesheet already points at, so no CSS changes:

```
python3 tools/prepare-hero.py tools/hero-source.jpg
```

The script never upscales, warns past a 250 KB budget, and reports how far the
picture has to be blown up to cover the hero.

What to give it: **2400x1600 is the ideal**. Tall matters more than wide — the
hero box is nearly square on a desktop and very tall on a phone, so a 16:9
picture gets stretched vertically while a 3:2 one does not. Keep the upper two
thirds light, because the heading sits there in dark ink.

The CSS gradients underneath remain as the fallback: if the file ever goes
missing the hero still renders, it just loses the photograph.

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
  focus rings, AA contrast measured on composited colours, `inert` behind the
  open menu, `prefers-reduced-motion` honoured (§9)
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
  a file that does not exist yet. Cropping the hero photograph is the obvious
  source; `prepare-hero.py` will not do it, as it only writes hero widths.

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
