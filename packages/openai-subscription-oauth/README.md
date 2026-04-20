# @pinchy/openai-subscription-oauth

Handles the OpenAI ChatGPT subscription OAuth device-code flow for Pinchy. This package implements the device authorization grant so Pinchy users can authenticate with their existing ChatGPT Plus/Pro subscription and use it as an AI provider — without ever sharing an API key.

## OpenAI OAuth Constants (verified 2026-04-20 from openai/codex source)

- CLIENT_ID: `app_EMoamEEZ73f0CkXaXp7hrann`
- Device code URL: `https://auth.openai.com/api/accounts/deviceauth/usercode`
- Poll token URL: `https://auth.openai.com/api/accounts/deviceauth/token`
- Refresh token URL: `https://auth.openai.com/oauth/token`
- Authorization URL: `https://auth.openai.com/oauth/authorize`
- Scope: `openid profile email offline_access api.connectors.read api.connectors.invoke`
