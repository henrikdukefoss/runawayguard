// Incremental parser for server-sent events (text/event-stream), as specified in the
// HTML living standard. Fed raw bytes as they arrive; calls onEvent({ event, data }) for
// each complete event. Used only to read usage, never to change what the client receives.

const MAX_LINE = 16 * 1024 * 1024;

export function createSseParser(onEvent) {
  const decoder = new TextDecoder();
  let parts = []; // pieces of the current, unfinished line
  let partsLen = 0;
  let skipLF = false; // the last chunk ended in \r; a \n starting the next one belongs to it
  let data = [];
  let event = '';

  const line = (l) => {
    if (l === '') {
      if (data.length) onEvent({ event, data: data.join('\n') });
      data = [];
      event = '';
      return;
    }
    if (l[0] === ':') return;
    const i = l.indexOf(':');
    const field = i < 0 ? l : l.slice(0, i);
    let value = i < 0 ? '' : l.slice(i + 1);
    if (value[0] === ' ') value = value.slice(1);
    if (field === 'data') data.push(value);
    else if (field === 'event') event = value;
  };

  // Each chunk is scanned once and unfinished lines are kept as pieces, so a long line
  // arriving in many small chunks costs linear time.
  const feed = (text) => {
    let start = 0;
    if (skipLF && text[0] === '\n') start = 1;
    skipLF = false;
    const re = /\r\n|\n|\r/g;
    re.lastIndex = start;
    for (let m; (m = re.exec(text)); ) {
      parts.push(text.slice(start, m.index));
      line(parts.join(''));
      parts = [];
      partsLen = 0;
      start = m.index + m[0].length;
      if (m[0] === '\r' && start === text.length) skipLF = true;
    }
    if (start < text.length) {
      partsLen += text.length - start;
      if (partsLen > MAX_LINE) parts = [], (partsLen = 0);
      else parts.push(text.slice(start));
    }
  };

  return {
    write(chunk) {
      feed(typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true }));
    },
    end() {
      feed(decoder.decode());
      if (parts.length) line(parts.join(''));
      parts = [];
      line('');
    },
  };
}
