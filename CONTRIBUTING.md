# Contributing

Thanks for your interest in Manta. This page covers the build, test,
and pull request workflow. Read [`AGENTS.md`](AGENTS.md) for the
architecture, IPC contract, and release pipeline.

## Build and test

```bash
npm install
npm run typecheck
npm test              # vitest (renderer) plus node:test (server, gateway, scripts)
npm run dev           # main-process and preload changes need a full restart, not HMR
npm run build:mobile  # rebuild the mobile bundle after renderer changes
```

The repo uses Node 22, Electron, React, and opencode. The mobile
bundle lives at `mobile/www/` and is committed to git, so renderer
changes that should land on the phone need
`npm run build:mobile` plus `git add mobile/www` before committing.

## Layout

- `src/main/` Electron main process
- `src/preload/` preload bridges
- `src/renderer/` React renderer (the desktop and mobile UI share this)
- `src/server/` box HTTP + WebSocket server (`manta-server`)
- `src/gateway/` hosted push gateway (`manta-gateway`)
- `mobile/` Capacitor native shells (iOS + Android)
- `website/` static marketing site
- `scripts/` installer, release tooling, prod ops

## Pull requests

1. Branch off `main`:
   `git checkout -b multica/BET-<N>-<short-slug> origin/main`.
2. Commit with `feat(scope): …` / `fix(scope): …` / `refactor(scope): …`
   where scope matches where the change lives (`main`, `renderer`,
   `preload`, `server`, `mobile`, `gateway`, `website`, `docs`).
3. Run `npm run typecheck && npm test` and confirm both pass.
4. Push your branch and open a draft PR against `main`. The reviewer
   handles the merge.

For larger changes, file an issue first and tag it with the same
`BET-<N>` so the change has an audit trail.
