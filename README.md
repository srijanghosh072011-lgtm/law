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
contact/index.html         Contact — the only page with the address in it
privacy/index.html         Privacy policy
assets/css/site.css        The whole design system
assets/js/site.js          Nav, tabs, scroll reveals (~110 lines)
assets/img/hero.webp       Hero background (1536w) + hero-sm.webp (1200w)
tools/hero-source.jpg      The original the two WebPs are cut from
tools/prepare-hero.py      Re-cuts them if you replace the original
_headers                   Security headers (Cloudflare Pages / Netlify)
CNAME                      Custom domain for GitHub Pages
.nojekyll                  Stops Pages running Jekyll over the folder
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

The domain (`ghoshdesigns.ca`) and the contact address are both real — no
placeholders left. Walk `SECURITY.md` top to bottom, then note the two items
below.

**Contact goes through `/contact/`, not `mailto:`.** Every CTA on the site
links to that page carrying its subject as `?s=`, and the page offers four
routes: copy the address, open Gmail, open Outlook, or hand off to a mail app.
A bare `mailto:` link does nothing at all on a machine with no mail program
registered, which is most machines now that people use webmail — so a
`mailto:`-only site has dead buttons for a large share of its visitors. The
address appears in the markup exactly once, on that page.

**The contact address is a personal Gmail.** SECURITY.md §3 asks for one on the
custom domain, because a Gmail cannot carry SPF, DKIM or DMARC for
`ghoshdesigns.ca` and it reads as less established on a studio site. It is
here because `hello@ghoshdesigns.ca` is a no-reply used by automation. When a
real mailbox on the domain exists — `srijan@`, `studio@`, anything — it is one
find-and-replace across the six pages.

**It is also in plain text in the markup**, so it will be scraped. A contact
form (see below) removes both problems at once, since the address then never
appears on the page.

### Where the checklist already stands

Done in this repo:

- `.gitignore` covers `.env`, `node_modules`, `.DS_Store` (§1)
- No secrets, keys or internal URLs anywhere in the source (§1)
- Every page carries a `Content-Security-Policy` meta tag and a referrer
  policy, so the two headers that matter most survive on GitHub Pages (§4)
- `_headers` ships the full set — HSTS, CSP, X-Content-Type-Options,
  X-Frame-Options, Referrer-Policy, Permissions-Policy, COOP and CORP — for
  the day this moves to a host that reads it (§4)
- No contact form, so no form attack surface — contact runs through
  `/contact/` and the CSP sets `form-action 'none'` (§5)
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

### Hosting: what GitHub Pages cannot do (§2, §4)

The site is served from GitHub Pages, which does not let you set response
headers — `_headers` is read by Cloudflare Pages and Netlify, and ignored
here. Each page therefore carries the policy it can carry in markup:

```
<meta http-equiv="Content-Security-Policy" content="…">
<meta name="referrer" content="strict-origin-when-cross-origin">
```

That recovers the CSP and the referrer policy. `frame-ancestors` is left out
of the meta version deliberately — it is invalid in a meta tag and browsers
ignore the whole directive with a console warning.

Still missing, and not fixable from inside the repo:

| Header | Effect of its absence |
| --- | --- |
| `Strict-Transport-Security` | First visit over `http://` is downgradeable until Pages' redirect fires |
| `X-Frame-Options` / `frame-ancestors` | The site can be framed, so clickjacking is possible |
| `X-Content-Type-Options` | No MIME-sniffing protection |
| `Permissions-Policy` | Camera, mic, geolocation are not pre-denied |
| `Cross-Origin-Opener-Policy` / `-Resource-Policy` | No cross-origin isolation |

Putting Cloudflare in front of the Pages origin restores every one of them
through Transform Rules, on the free plan, without moving the host. That is
the smallest change that closes this gap. Moving to Cloudflare Pages or
Netlify closes it too, and `_headers` then works as written with no edits.

### Deploying to Pages

`CNAME` holds `ghoshdesigns.ca`. Without it Pages serves the site at
`/<repo-name>/` and every root-relative path (`/assets/…`) 404s. At the
registrar, point the apex at GitHub's four A records (185.199.108–111.153),
add the four AAAA records, and `CNAME www` to
`<user>.github.io`. Then turn on **Enforce HTTPS** in the repository's Pages
settings once the certificate is issued.

`.nojekyll` is required: without it Pages runs Jekyll, which silently drops
files and folders whose names start with `_`.

**Paths are document-relative, not root-relative** (`../assets/…`, not
`/assets/…`). That is deliberate: it means the site renders correctly at the
apex domain, at a project subpath like `user.github.io/repo/`, and from a
local preview, without a base tag or a build step. Root-relative paths break
everywhere except a domain root — the stylesheet 404s and the page renders as
raw markup. If you add a page, match the depth: root pages use `./`, pages one
folder down use `../`.

Canonical tags, `og:url` and the JSON-LD `url`/`@id` fields stay absolute on
purpose. Those name the one true production URL and are never resolved
against the current document, so they must not be relative.

Still needs a human, because it is hosting and DNS rather than code:

- Cloudflare in front of the domain (see above), DNSSEC on at the registrar,
  HTTPS enforced, SSL Labs A or better (§2)
- SPF, DKIM and DMARC (`p=quarantine` or stronger) on the sending domain (§3)
- Verify at securityheaders.com after the first deploy — expect a low grade
  until the header gap above is closed (§4)
- Uptime monitoring; Lighthouse run on the live URL (§7)
- Submit to Google Search Console (§9)
- Add a 1200×630 OpenGraph image and an `og:image` tag. The pages ship
  `twitter:card=summary` rather than `summary_large_image` so nothing points at
  a file that does not exist yet. Cropping the hero photograph is the obvious
  source; `prepare-hero.py` will not do it, as it only writes hero widths.

### If a contact form is added later

It would replace the compose buttons on `/contact/`; the rest of the site
already points there, so no other page changes.

Point the form at Formspree, Netlify Forms or Web3Forms, add a honeypot field,
turn on rate limiting in that dashboard, and add the endpoint host to
`form-action` in **both** `_headers` and the meta CSP in each page — the
policy currently blocks all form submission.

## Local preview

```
python3 -m http.server 8000
```

Then open <http://localhost:8000>. Root-relative paths (`/assets/…`) need a
server, so opening the files directly from disk will load them unstyled.
