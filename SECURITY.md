# SECURITY.md — Pre-Launch Checklist

**How to use this file:** Drop it into every client project on day one. Before you hand the site over or point the domain at it, walk through every box. Don't launch with any unchecked.

This is built for static and lightly-dynamic sites (hand-coded HTML, Tailwind, simple contact forms). Sites with logins, payments, or user accounts need the extended checklist at the bottom.

-----

## 1. The repo

- [ ] Repository is **private** (or, if public, has been scanned with `gitleaks` and contains zero secrets)
- [ ] `.gitignore` excludes `.env`, `.env.local`, `node_modules`, `.DS_Store`, and any local config files
- [ ] No API keys, SMTP passwords, or hosting tokens anywhere in git history
- [ ] No client-specific URLs, commit hashes, or repo paths exposed on the live site (check `view-source:` for leaks)
- [ ] Repo name is professional (avoid `idk`, `test`, `temp`)

## 2. Hosting & DNS

- [ ] Site is on a host that supports custom headers (Cloudflare Pages, Netlify, Vercel — NOT plain GitHub Pages)
- [ ] Cloudflare is in front of the domain (free tier is fine — gives WAF, DDoS protection, CDN)
- [ ] DNSSEC is enabled at the registrar
- [ ] HTTPS is enforced (HTTP redirects to HTTPS automatically)
- [ ] SSL/TLS certificate scores **A or A+** at [ssllabs.com/ssltest](https://www.ssllabs.com/ssltest/)

## 3. Email & domain

- [ ] Contact email uses the custom domain (e.g. `hello@clientdomain.com`), not a personal Gmail
- [ ] **SPF** record is set on the domain
- [ ] **DKIM** record is set (whoever sends mail for the domain)
- [ ] **DMARC** record is set to at least `p=quarantine`
- [ ] Verified at [mxtoolbox.com](https://mxtoolbox.com)

## 4. Security headers

- [ ] `_headers` (or `vercel.json`) file is deployed with: HSTS, X-Content-Type-Options, X-Frame-Options, Referrer-Policy, Permissions-Policy, Content-Security-Policy
- [ ] Site scores **A or higher** at [securityheaders.com](https://securityheaders.com)
- [ ] CSP includes only the third-party domains the site actually uses (Unsplash, Google Fonts, Formspree, analytics — whatever applies)

## 5. Contact form

- [ ] Form has spam protection: Cloudflare Turnstile, hCaptcha, OR a honeypot field
- [ ] Form backend (Formspree, Netlify Forms, Web3Forms, etc.) has rate-limiting turned on in its dashboard
- [ ] Form submits over HTTPS only
- [ ] Form's `action` attribute matches your CSP `form-action` directive
- [ ] Test submission actually arrives at the right inbox

## 6. Legal & privacy

- [ ] Privacy policy page exists, linked from the footer
- [ ] Privacy policy reflects the actual data collected (don't ship a template with placeholder text)
- [ ] If selling products: terms of service + refund policy linked from footer
- [ ] Cookie banner ONLY if you actually set non-essential cookies (most static sites don't need one)

## 7. Performance & uptime

- [ ] Lighthouse score 90+ across the board (mobile and desktop)
- [ ] Images optimized (WebP or AVIF, lazy-loaded below the fold)
- [ ] Uptime monitoring is set up — [UptimeRobot](https://uptimerobot.com) or [BetterStack](https://betterstack.com) free tier
- [ ] Error tracking is set up if there's any JS — [Sentry](https://sentry.io) free tier

## 8. Backups & recovery

- [ ] The git repo IS the backup of the code (verify you can redeploy from scratch in under 30 min)
- [ ] If there's a CMS or database: automated daily backups stored OFF the production server
- [ ] You've personally tested restoring a backup at least once
- [ ] DNS records are documented somewhere outside the registrar (screenshot or text file)

## 9. Accessibility & SEO basics

(Not security per se, but a broken/inaccessible site damages the same business reputation a hack would.)

- [ ] Every image has meaningful `alt` text
- [ ] Color contrast passes WCAG AA
- [ ] Semantic HTML (proper `<h1>`, `<nav>`, `<main>`, `<footer>`)
- [ ] `robots.txt` and `sitemap.xml` exist and are correct
- [ ] OpenGraph + Twitter card meta tags are set
- [ ] Site is submitted to Google Search Console

## 10. Final sweep

- [ ] View-source the homepage and search for: TODO, FIXME, console.log, localhost, dev URLs, commit hashes, internal notes
- [ ] All placeholder content removed ("Lorem ipsum," "Your name here," etc.)
- [ ] All external links open with `rel="noopener noreferrer"` if they use `target="_blank"`
- [ ] Sent the live URL to a friend on a different device and asked them to break it

-----

## Extended checklist (only if the site has logins, payments, or user data)

- [ ] Passwords hashed with **bcrypt** or **argon2** (never MD5/SHA1, never plaintext)
- [ ] MFA available (and required for admin accounts)
- [ ] Session cookies are `Secure`, `HttpOnly`, `SameSite=Lax` or `Strict`
- [ ] Rate-limiting on login, signup, password-reset endpoints
- [ ] All database queries use parameterized statements (no string-concatenated SQL)
- [ ] All user input is validated server-side AND output-encoded when rendered
- [ ] CSRF tokens on every state-changing request
- [ ] Dependencies audited (`npm audit`, `pip-audit`, etc.) — zero high/critical CVEs
- [ ] **Payments** go through Stripe Checkout or equivalent — site never touches raw card data
- [ ] OWASP ZAP scan completed against staging, all medium-or-higher findings resolved

-----

## Ongoing maintenance (every month)

- [ ] Re-run `npm audit` / dependency scan
- [ ] Re-run [securityheaders.com](https://securityheaders.com) and [ssllabs.com](https://www.ssllabs.com/ssltest/)
- [ ] Test a backup restore
- [ ] Review form submissions for unusual patterns (spam spikes, scraping attempts)
- [ ] Rotate any API keys older than 90 days

-----

*Last reviewed: June 1, 2026 · Maintained by Ghosh Designs*
