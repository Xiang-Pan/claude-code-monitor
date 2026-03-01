# Contributing

Thanks for your interest in contributing to Claude Code Monitor!

## Development Setup

```bash
git clone https://github.com/Xiang-Pan/claude-code-monitor.git
cd claude-code-monitor
npm install
cp config.example.json config.json  # edit with your hosts
npm run dev                         # starts server + Vite dev server
```

The dev server runs on `http://localhost:3456` (API/WS) and `http://localhost:3457` (Vite HMR).

## Project Layout

- **`server/`** — Node.js backend (Express + WebSocket + SSH collectors)
- **`client/src/`** — React frontend (Vite)
  - `components/` — UI components (theme, helpers, cards, tables, etc.)
  - `hooks/` — React hooks (WebSocket, persisted state)
- **`test/`** — Vitest unit tests
- **`scripts/`** — Standalone CLI tools

## Running Tests

```bash
npm test
```

## Guidelines

- Keep dependencies minimal — the project intentionally has only 3 runtime deps.
- Use ES modules (`import`/`export`), not CommonJS.
- No TypeScript — the project uses plain JS for simplicity and zero build step on the server.
- Test pure functions in `server/` (parser, aggregator, ssh-collector).
- Run `npm run build` before submitting to make sure the client builds cleanly.

## Submitting Changes

1. Fork the repo and create a feature branch.
2. Make your changes with clear commit messages.
3. Run `npm test && npm run build` to verify.
4. Open a pull request against `master`.
