# ONZE

A static shop front for football shirts. Ten club colourways, a live customiser
with name/number screening, and no build step — open `index.html` and it runs.

```
index.html          hero, collection grid, print room, sizing, FAQ, list form
customize.html      the customiser: colourway, size, name, number, bag
privacy.html        privacy policy
terms.html          terms, including the personalisation and returns rules
_headers            security headers for Netlify / Cloudflare Pages
assets/css/main.css the whole stylesheet
assets/js/kits.js   colourway data + the SVG shirt renderer
assets/js/moderation.js  name and number screening
assets/js/app.js    nav, scroll reveals, accent retinting, homepage modules
assets/js/customizer.js  the customiser page
assets/fonts/       Archivo + Instrument Serif, self-hosted (OFL 1.1)
test/               moderation test suite
SECURITY.md         pre-launch checklist — walk it before pointing the domain
```

## Running it

Any static server. There is no toolchain, no dependencies, no build.

```bash
python3 -m http.server 8000     # then open http://localhost:8000
node test/moderation.test.mjs   # 33 moderation cases
```

ES modules need to be served over HTTP — opening `index.html` off the
filesystem will fail on CORS.

## About the shirt images

The shirts are **original vector artwork**, drawn from scratch in
`assets/js/kits.js`: silhouette, stripe geometry, collar and cuff trim. One
renderer produces every image on the site, including the live customiser
preview, which is why the preview matches the product exactly.

They are not photographs, and deliberately so. Product photography from Nike,
adidas, Puma or a club store is those companies' copyright — republishing it on
a shop you are selling from is infringement, not a grey area, and it is the kind
of thing that gets a storefront taken down rather than emailed about. The same
goes for crests, badges and sponsor marks, which are registered trade marks. So
none of them appear anywhere here.

Club names are used as plain colourway descriptors, which is ordinary practice,
and both the footer and `terms.html` carry a clear statement that ONZE is not
affiliated with or endorsed by any club or manufacturer. **Worth knowing:** using
club names to sell shirts still carries trade mark risk, and how much depends on
where you trade and what you are actually selling. It is worth an hour with a
solicitor before you take money.

If you want photography later, shoot your own. Drop the files in
`assets/img/` and swap `renderKit()` for an `<img>` in the two places it is
called — the data shape does not need to change.

## Before you launch

Walk `SECURITY.md` end to end. Three things in this repo need your input:

1. **`FORM_ENDPOINT`** in `assets/js/app.js` is empty. Until you set it to a
   form backend (Formspree, Web3Forms, Netlify Forms), the list form tells
   people the list is not open rather than quietly dropping addresses. Add that
   host to `connect-src` in `_headers` at the same time.
2. **The domain.** `onze.store` is used as the canonical host in every
   `<link rel="canonical">`, the OpenGraph tags, `robots.txt` and `sitemap.xml`.
   Search and replace it.
3. **`assets/img/og.png`** is referenced by the social tags but not committed —
   export a 1200×630 card and add it.

Also: `_headers` only works on a host that supports custom headers. Plain
GitHub Pages ignores it, which loses the CSP and HSTS.

## Copy rules

The product copy makes **no claim about the condition, origin, or provenance of
the shirts** — not that they are new, not that they are anything else, and
nothing about where they come from. That is deliberate and load-bearing. The
copy sells design, fit, customisation and service instead.

Keep it that way when you edit. A claim you cannot back is the one thing here
that turns a trading standards complaint into a straightforward loss. If you
later can back a claim, make it explicitly and make it true.

## Editing

**A new colourway** — add an entry to `KITS` in `assets/js/kits.js`. The grid,
the customiser dropdown, the marquee and the rival-name rules all read from that
array, so nothing else needs touching. Six pattern types are available: `solid`,
`stripes`, `hoops`, `hechter`, `sleeves`, `tonal`.

**The blocklist** — `assets/js/moderation.js`. The severe and hate tiers are
ROT13-encoded so the repo does not contain a readable wall of slurs; encode new
entries the same way. `LEGENDS` maps a player name to the colourways it is
allowed on, which is what refuses Ronaldo on a Barcelona shirt. Rival *club*
names are derived from `KITS` automatically.

Add a case to `test/moderation.test.mjs` for anything you change.

**Screening runs in the browser**, which makes it a first pass, not a
guarantee — anyone can bypass client-side JavaScript. Re-run
`checkPersonalisation` server-side when you add checkout, before the order
reaches the press.

## Not built yet

No checkout. The bag is `localStorage` only and does not survive a device
change. No bag page — the counter is in the nav. Add these when there is a
payment provider to connect them to.
