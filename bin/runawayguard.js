#!/usr/bin/env node
import { main } from '../src/cli.js';

main().then(
  (code) => {
    process.exitCode = code;
    // keep-alive sockets and timers must not hold the process open after shutdown
    if (code === 0) setImmediate(() => process.exit(code));
  },
  (err) => {
    console.error(`runawayguard: ${err?.stack || err}`);
    process.exitCode = 1;
  },
);
