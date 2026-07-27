# Security

Manta is a self-hosted tool that holds box tokens, secrets-by-reference,
and VAPID keys on the Linux box or Mac running `manta-server`. Treat
any vulnerability report as in-scope until we say otherwise.

## Reporting a vulnerability

Email `security@mantaui.com` (preferred) or open a private security
advisory on GitHub:
<https://github.com/antoinedc/MantaUI/security/advisories/new>.

Please include:

- A description of the issue and the impact you can demonstrate
- Reproduction steps, including any code, configuration, or HTTP
  requests needed to trigger it
- The affected commit SHA or release version
- Whether the issue is exploitable remotely or only on the local box

Do not post full details to a public GitHub issue, public Discord, or
social media until we have shipped a fix and a CVE (where applicable)
or agreed a disclosure window with you.

## Response

We aim to acknowledge new reports within 72 hours and to publish a
fix within 30 days for high-severity issues, faster where there is an
active exploit in the wild. Coordinated disclosure is the default.

## Supported versions

The latest minor release line receives security fixes. Older lines
receive fixes only at the maintainer's discretion; please upgrade.

## Scope

In scope: `src/server/`, `src/main/`, `src/preload/`, `src/renderer/`,
`src/gateway/`, the installer (`scripts/install.sh`,
`scripts/install-lib.mjs`), and the agent tools in
`docs/opencode-tools/`. Out of scope: bugs in the upstream opencode or
Claude Code binaries themselves, and bugs in third-party npm packages
we do not control.
