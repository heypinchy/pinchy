Minimal Ollama-API mock used by Pinchy's E2E tests.

Two deployment modes share the same source (`fake-ollama-server.ts`):

- **Subprocess** — integration tests and Telegram E2E start the server
  in-process via `startFakeOllama()` from a Playwright `globalSetup`
  hook. The assistant reply is the hardcoded `FAKE_RESPONSE` constant.
- **Container** — the setup-wizard E2E (`docker-compose.setup-wizard-test.yml`)
  builds this directory as a sibling service. The container reads the
  `FAKE_OLLAMA_RESPONSE` env var so the wizard spec can assert the same
  canonical "Sure, happy to help..." reply as the API-key provider mocks.
  Default env-var value is unset, so subprocess behaviour is unchanged.

Run locally to debug:

```bash
cd packages/web/e2e/shared/fake-ollama
npm install
FAKE_OLLAMA_RESPONSE='hello' npx tsx fake-ollama-process.ts
curl http://localhost:11435/api/tags
```
