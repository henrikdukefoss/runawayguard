#!/usr/bin/env node
// Writes docs/sample-session.txt: a scripted Claude Code session through runawayguard with a
// $1.50 limit. The upstream is a local fake that streams Anthropic events with made-up
// usage, priced from the bundled price table, on a fake clock. No real API is contacted.
// The fake upstream address and the random port are shown as https://api.anthropic.com and
// 8402; nothing else in the output is changed.
process.env.TZ = 'UTC';

import { writeFileSync } from 'node:fs';
import { main } from '../src/cli.js';
import { fakeUpstream, post, sse, tmp, until } from '../test/helpers.js';

// One agent turn each. Context grows as the session goes on.
const OPUS = 'claude-opus-5-5';
const HAIKU = 'claude-haiku-5-5';
const turns = [
  { model: HAIKU, input: 812, out: 38, read: 0, write: 0 },
  { model: OPUS, input: 2210, out: 1840, read: 0, write: 38400 },
  { model: OPUS, input: 640, out: 2310, read: 38400, write: 9100 },
  { model: OPUS, input: 420, out: 3920, read: 47500, write: 12800 },
  { model: OPUS, input: 380, out: 1210, read: 60300, write: 6200 },
  { model: HAIKU, input: 1490, out: 61, read: 0, write: 0 },
  { model: OPUS, input: 510, out: 4480, read: 66500, write: 14900 },
  { model: OPUS, input: 290, out: 2760, read: 81400, write: 8800 },
  { model: OPUS, input: 330, out: 5120, read: 90200, write: 16300 },
  { model: OPUS, input: 270, out: 3340, read: 106500, write: 9400 },
  { model: OPUS, input: 440, out: 4890, read: 115900, write: 13700 },
  { model: OPUS, input: 310, out: 2980, read: 129600, write: 7900 },
  { model: OPUS, input: 300, out: 1500, read: 137500, write: 5000 },
  { model: OPUS, input: 300, out: 1500, read: 137500, write: 5000 },
];

const events = (t) => [
  { event: 'message_start', data: { type: 'message_start', message: { id: 'msg', type: 'message', role: 'assistant', model: t.model, content: [], usage: { input_tokens: t.input, cache_read_input_tokens: t.read, cache_creation_input_tokens: t.write, output_tokens: 1 } } } },
  { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '...' } } },
  { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: t.out } } },
  { event: 'message_stop', data: { type: 'message_stop' } },
];

let i = 0;
const up = await fakeUpstream((req, res) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end(sse(events(turns[i++])));
});

let clock = Date.parse('2026-10-13T14:02:05Z');
const now = () => clock;
let out = '';
const stderr = { write: (s) => (out += s), isTTY: false };
const ac = new AbortController();
const args = ['--limit', '1.50', '--upstream', up.url, '--port', '0', '--offline'];
const done = main(args, { env: { XDG_CACHE_HOME: tmp(), XDG_STATE_HOME: tmp() }, stderr, signal: ac.signal, now });
await until(() => /proxy +http:\/\/127\.0\.0\.1:\d+/.test(out));
const url = /proxy +(http:\/\/127\.0\.0\.1:\d+)/.exec(out)[1];

const gaps = [3, 9, 41, 37, 52, 4, 66, 38, 71, 44, 58, 35, 12, 6];
for (let n = 0; n < turns.length; n++) {
  clock += gaps[n] * 1000;
  await post(url, '/v1/messages?beta=true', { model: turns[n].model, stream: true });
}
clock += 2 * 60 * 1000;
ac.abort();
await done;
await up.close();

const text = `$ npx github:henrikdukefoss/runawayguard --limit 1.50 --upstream anthropic --offline\n${out.replace(/\n\nrunawayguard stopped/, '\n^C\nrunawayguard stopped')}`
  .replaceAll(url, 'http://127.0.0.1:8402')
  .replaceAll(up.url, 'https://api.anthropic.com')
  // with a real Anthropic upstream only the Claude Code hint is shown
  .replace(/\n +OpenAI-style .*/, '');
writeFileSync(new URL('../docs/sample-session.txt', import.meta.url), text);
console.log(text);
