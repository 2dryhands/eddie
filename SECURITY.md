# Security policy

## Supported versions

Only the latest release on the `main` branch gets security fixes.

## Reporting a vulnerability

Please do not open a public issue for a security problem.

Report it privately through GitHub: the repository's **Security** tab →
**Report a vulnerability**
(<https://github.com/2dryhands/eddie/security/advisories/new>).

Include what you did, what happened, and the Eddie version (`package.json`).
You should get a first answer within 7 days. Once a fix ships, the advisory is
published and you are credited unless you ask not to be.

## What Eddie protects

Eddie is a local tool. Its security model:

- The server binds to `127.0.0.1` only and rejects requests whose `Host` or
  `Origin` header is not a loopback address (DNS-rebinding guard).
- The page under review renders in a sandboxed iframe without
  `allow-same-origin`, so its scripts cannot reach the canvas around it.
- The package has no runtime dependencies. Mermaid loads from a pinned CDN
  version and is optional.

In scope: anything that lets a web page, another site or a reviewed file read
or change files, feedback or sessions it should not, or run code outside the
sandboxed frame.

Out of scope: other programs running as the same local user — they can already
read Eddie's state and files directly.
