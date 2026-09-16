# Security

FluentFlow is a vibe-coded personal project, not a security-audited service.
There is no dedicated security team or guaranteed response time.

## Reporting a problem

Use **Security → Report a vulnerability** on this GitHub repository if private
reporting is enabled. If that option is unavailable, open an issue asking for a
private contact channel without including exploit details, credentials, or
personal data. Do not post secrets in a public issue.

## Running and sharing the app

- Keep the local development API on your machine. Its permissive tokens and
  in-memory store are intended for development. It refuses local mode when
  `NODE_ENV=production`, but that guard is not a deployment security review.
- Keep Gemini keys, Firebase admin credentials, and signing material out of
  Git and client bundles. `EXPO_PUBLIC_*` values are public.
- Review and test Firebase rules in your own project before enabling sync for
  other people. Use your own project, API keys, and desktop update feed.
- Review dependency advisories before deploying a server or distributing builds.

## Known dependency advisories

The pre-publication check on 2026-09-15 found advisories in both lockfiles:

| Dependency tree | Moderate | High | Critical |
| --- | ---: | ---: | ---: |
| Root workspaces | 25 | 5 | 0 |
| Desktop | 0 | 11 | 1 |

These are npm's affected-package counts, including transitive dependencies,
not a count of distinct exploitable bugs. The root findings include the
Markdown rendering dependencies and Puppeteer tooling, plus Expo and Firebase
dependency chains. The desktop findings include `tar` through the packaging
toolchain. Some suggested fixes require major upgrades; some currently have no
fix reported by npm. They remain unresolved by the publication cleanup.

Recheck the actual dependency trees rather than treating this snapshot as a
current security assessment:

```bash
npm audit
npm --prefix apps/desktop audit
```

Before making a private history public, scan the history as well as the current
files. For example, with [Gitleaks](https://github.com/gitleaks/gitleaks):

```bash
gitleaks git --redact --log-opts=--all .
```

A clean scan cannot prove there are no secrets. If a real credential was
committed, revoke it before addressing the history. Review release assets and
GitHub settings separately; a source scan does not cover them.
