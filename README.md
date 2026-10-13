# runawayguard

A spend limit for coding agents that run on your own API key. runawayguard is a small local
proxy: your agent sends its requests through it, it prices each response at API list prices,
and once the limit is reached it answers new requests with HTTP 402, so the agent stops.

```sh
npx github:henrikdukefoss/runawayguard --limit 5 --upstream https://api.anthropic.com
```

Then start your agent against it, in another terminal:

```sh
ANTHROPIC_BASE_URL=http://127.0.0.1:8402 ENABLE_TOOL_SEARCH=true claude
```

Node 18 or newer. No dependencies, no account. Requests and API keys pass through untouched and
are never stored.

## Sample session

A Claude Code session with a $1.50 limit, rendered by `npm run sample`. The upstream is a local
fake API with made-up usage, shown here as api.anthropic.com; no real requests were made.

```text
$ npx github:henrikdukefoss/runawayguard --limit 1.50 --upstream anthropic --offline
runawayguard 0.1.0

  proxy      http://127.0.0.1:8402  ->  https://api.anthropic.com
  limit      $1.50 per session, warning at $1.20, then HTTP 402
  prices     LiteLLM (bundled), 2026-10-13

  Point your agent at the proxy, for example:
    Claude Code    ANTHROPIC_BASE_URL=http://127.0.0.1:8402 ENABLE_TOOL_SEARCH=true claude

  Ctrl+C stops the proxy and prints a summary.

14:02:08  claude-haiku-5-5               812 in     38 out   $0.0001     $0.00  0%
14:02:17  claude-opus-5-5              40.6K in   1.8K out   $0.2376     $0.23  15%
14:02:58  claude-opus-5-5              48.1K in   2.3K out   $0.1019     $0.33  22%
14:03:35  claude-opus-5-5              60.7K in   3.9K out   $0.1536     $0.49  32%
14:04:27  claude-opus-5-5              66.9K in   1.2K out   $0.0688     $0.56  37%
14:04:31  claude-haiku-5-5              1.5K in     61 out   $0.0002     $0.56  37%
14:05:37  claude-opus-5-5              81.9K in   4.5K out   $0.1794     $0.74  49%
14:06:15  claude-opus-5-5              90.5K in   2.8K out   $0.1166     $0.85  57%
14:07:26  claude-opus-5-5             106.8K in   5.1K out   $0.2033     $1.06  70%
14:08:10  claude-opus-5-5             116.2K in   3.3K out   $0.1362     $1.19  79%
14:09:08  claude-opus-5-5             130.0K in   4.9K out   $0.1912     $1.38  92%
runawayguard: over 80% of the $1.50 session limit used.
14:09:43  claude-opus-5-5             137.8K in   3.0K out   $0.1263     $1.51  101%
runawayguard: $1.50 session limit reached. New requests are blocked with HTTP 402.
runawayguard: blocked POST /v1/messages (HTTP 402).
^C
runawayguard stopped after 10m

  MODEL                        REQUESTS    TOKENS  CACHE READ       USD
  claude-opus-5-5                    10    912.5K      736.3K     $1.51
  claude-haiku-5-5                    2      2.4K           0     $0.00
  TOTAL                              12    914.9K      736.3K     $1.51
  Tokens include input, output and cache reads and writes.

  2 requests were blocked at the $1.50 session limit.
  List prices from LiteLLM (bundled), 2026-10-13. Your provider's invoice is the final word.

runawayguard, made by Standard Compute (standardcompute.com)

```

That is the output when stderr is a file or a pipe. In a terminal the request lines are replaced
by one meter line that updates in place, and warnings stay above it:

```text
$1.19 of $1.50 session  ━━━━━━━━━━━━━━━━────  79%  10 requests  last claude-opus-5-5 $0.1362
```

`docs/sample-session.txt` holds the same transcript.

## Usage

```sh
npx github:henrikdukefoss/runawayguard --limit 5 --upstream anthropic
npx github:henrikdukefoss/runawayguard --limit 20 --per day --upstream openai
npx github:henrikdukefoss/runawayguard --limit 5 --upstream https://openrouter.ai/api --log usage.jsonl
npx github:henrikdukefoss/runawayguard --dry-run --upstream anthropic     # meter only
```

| Option | Meaning |
| --- | --- |
| `--limit <usd>` | stop at this many dollars, for example `5` or `12.50` (required unless `--dry-run`) |
| `--upstream <url>` | the API to forward to; `anthropic`, `openai` and `openrouter` are shortcuts for `https://api.anthropic.com`, `https://api.openai.com` and `https://openrouter.ai/api` |
| `--per <period>` | `session` (default): since runawayguard started. `day`: the local calendar day, kept across restarts |
| `--warn-at <ratio>` | print a warning at this share of the limit, default `0.8`; `0` turns it off |
| `--port <n>` | local port, default `8402`; `0` picks a free one |
| `--log <file>` | append one JSON line per request with model, token counts and cost |
| `--dry-run` | meter and warn, never block |
| `--offline` | use the bundled price table, no price download |
| `--no-color` | plain output |

The proxy listens on 127.0.0.1 only. All output goes to stderr. Ctrl+C stops it and prints the
summary.

The request path is appended to the upstream URL. A `/v1` at the end of `--upstream` is not
doubled, so `https://api.openai.com` and `https://api.openai.com/v1` both work.

## Point your agent at it

Anthropic clients take the base URL without `/v1`; OpenAI clients take it with `/v1`. Run the
proxy with the matching `--upstream`. Each setting below was checked against the agent's
documentation or source code in October 2026.

| Agent | Setting | Source |
| --- | --- | --- |
| Claude Code | `ANTHROPIC_BASE_URL=http://127.0.0.1:8402`, no `/v1` | [LLM gateway docs](https://code.claude.com/docs/en/llm-gateway-connect) |
| Codex CLI | a `[model_providers]` entry with `base_url = "http://127.0.0.1:8402/v1"`, see below | [config reference](https://learn.chatgpt.com/docs/config-file/config-reference) |
| OpenCode | `provider.anthropic.options.baseURL` or `provider.openai.options.baseURL` set to `http://127.0.0.1:8402/v1` in `opencode.json` | [providers](https://opencode.ai/docs/providers/) |
| Cline | Anthropic: tick "Use custom base URL" and enter `http://127.0.0.1:8402`. OpenAI Compatible: Base URL `http://127.0.0.1:8402/v1` | [Anthropic](https://docs.cline.bot/provider-config/anthropic), [OpenAI Compatible](https://docs.cline.bot/provider-config/openai-compatible) |
| Roo Code | Anthropic: "Use custom base URL" `http://127.0.0.1:8402`. OpenAI Compatible: `http://127.0.0.1:8402/v1` | [Anthropic](https://roocodeinc.github.io/Roo-Code/providers/anthropic) |
| Aider | `ANTHROPIC_API_BASE=http://127.0.0.1:8402` (no `/v1`), or `OPENAI_API_BASE=http://127.0.0.1:8402/v1`, see below | [OpenAI compatible APIs](https://aider.chat/docs/llms/openai-compat.html) |
| Pi | `~/.pi/agent/models.json`: `{"providers":{"anthropic":{"baseUrl":"http://127.0.0.1:8402"}}}`, or `"openai":{"baseUrl":"http://127.0.0.1:8402/v1"}` | [pi-mono](https://github.com/badlogic/pi-mono), `models.json` overrides |

**Claude Code.** With a base URL that is not api.anthropic.com, Claude Code turns MCP tool search
off by default, which loads every MCP tool schema into every request.
runawayguard forwards requests unchanged, so turn it back on with `ENABLE_TOOL_SEARCH=true`
([env vars](https://code.claude.com/docs/en/env-vars)). Use an API key (`ANTHROPIC_API_KEY`).
If you are logged in with a Claude subscription and set no key, the traffic still goes through
the proxy, but it is billed to your subscription, not at the list prices shown.

**Codex CLI.** Codex ignores `OPENAI_BASE_URL`. Its built-in `openai` provider has an
`openai_base_url` setting, but it tries a WebSocket connection first, which runawayguard refuses
because it cannot meter it; Codex then falls back to HTTP only after its retries. A provider
entry that speaks HTTP streaming avoids that. In `~/.codex/config.toml`:

```toml
model_provider = "runawayguard"

[model_providers.runawayguard]
name = "OpenAI via runawayguard"
base_url = "http://127.0.0.1:8402/v1"
wire_api = "responses"
env_key = "OPENAI_API_KEY"
```

**OpenCode.**

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "anthropic": { "options": { "baseURL": "http://127.0.0.1:8402/v1" } }
  }
}
```

OpenCode's development branch tries a WebSocket for OpenAI models first; after the refused
connection it continues over HTTP for the rest of the session.

**Aider.** Through a proxy, Aider streams OpenAI-style chat completions without asking for usage
(`stream_options.include_usage`), so runawayguard cannot price them and says so. Use Aider with
an Anthropic model through `ANTHROPIC_API_BASE`, or add the option yourself in
`.aider.model.settings.yml`:

```yaml
- name: openai/gpt-5
  extra_params:
    stream_options:
      include_usage: true
```

## What happens at the limit

- The limit is checked before each request. Once spending reaches it, every new request to
  `/v1/messages`, `/v1/chat/completions` or `/v1/responses` gets HTTP 402 and is not sent upstream:

  ```json
  {"type":"error","error":{"type":"spend_limit_reached","code":"spend_limit_reached","message":"runawayguard: $5.00 session limit reached ($5.03 spent). Restart runawayguard with a higher --limit to continue."}}
  ```

  The body reads as an error to both Anthropic and OpenAI clients. The response carries
  `x-should-retry: false`, which the official Anthropic and OpenAI SDKs obey, and 402 is not a
  status they retry on their own.
- Requests already running are allowed to finish, so the total can end above the limit by the
  cost of the last requests, as in the sample.
- Free requests such as model lists and `count_tokens` still pass. Codex's
  `/v1/responses/compact` is treated like `/v1/responses`.
- `--per day` keeps the day's total in `~/.local/state/runawayguard/spend/<date>.jsonl` (one
  timestamp and amount per request). Every runawayguard on the machine adds to the same day, so
  an Anthropic and an OpenAI proxy share one daily budget. It resets at local midnight.
- When the agent cancels a response (Esc in Claude Code), runawayguard stops the upstream request
  too and counts the usage reported up to that point. If the API drops a stream, the agent's
  connection is closed as well, so it does not wait on a stream that will never finish.

## How the cost is worked out

- Usage is read from each response as it passes: the `usage` object of a JSON response, or the
  stream events that carry it (`message_start` and `message_delta` for Anthropic, the final usage
  chunk for chat completions, `response.completed` for the Responses API). gzip, deflate and
  brotli responses are decoded on a side copy; the agent gets the original bytes. On metered
  requests, `Accept-Encoding` is narrowed to those three so every response can be read.
- Uncached input, output, cache reads, 5-minute and 1-hour cache writes are each priced at their
  own rate, with long-context rates when the prompt is over the model's threshold.
- Prices come from LiteLLM's public [model price list](https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json)
  (MIT licensed), fetched at most once a day and cached in `~/.cache/runawayguard`. `--offline`,
  or a failed download with no cache, uses the snapshot in `src/prices-fallback.json`.
- A model with no list price is counted in tokens and adds $0 to the limit; runawayguard prints
  a notice the first time. A response without usage is not counted either: the first one gets a
  notice and the meter keeps a count. Prices are never guessed.
- Not priced: server-side tool fees such as web search, and anything outside the three APIs
  above. List prices are pay-as-you-go prices; discounts, credits and batch pricing are not
  applied.
- Dollars on screen are cut to whole cents, never rounded up.

## Privacy

- Requests go from your agent to runawayguard on 127.0.0.1 and from there to the upstream you
  chose. Nothing else is contacted except raw.githubusercontent.com for the price list
  (`--offline` skips it).
- Headers, including `Authorization` and `x-api-key`, are forwarded as they are. Keys are never
  stored, printed or logged.
- Prompts and responses are never written anywhere. A side copy of each response is read in
  memory for its usage and dropped. `--log` records time, method, path without query string,
  status, model, token counts and cost, nothing else.

## Not supported yet

- WebSocket transports (refused, see Codex above), the Gemini API, Bedrock and Vertex endpoints,
  and batch APIs. Requests to other paths pass through and are not metered.
- One upstream per proxy. Run two on different ports for Anthropic and OpenAI.

## Already on a flat plan?

Flat-budget gateways such as [Standard Compute](https://standardcompute.com) stop at a budget on
the server, so you may not need this.

## Contributing

```sh
git clone https://github.com/henrikdukefoss/runawayguard
cd runawayguard
npm test            # node:test against a fake upstream, no install step, no network
```

- The proxy is `src/proxy.js`, usage parsing `src/usage.js` and `src/sse.js`, totals and the day
  ledger `src/budget.js`, output `src/render.js`.
- Tests start a fake Anthropic/OpenAI server on 127.0.0.1. Never commit real keys or traffic.
- `npm run sample` rebuilds `docs/sample-session.txt`; `npm run update-prices` refreshes the
  bundled price snapshot.
- Keep it dependency free.

## License

MIT

---

Made by [Standard Compute](https://standardcompute.com).
