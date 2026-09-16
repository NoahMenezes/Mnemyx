import {
  statSync,
  openSync,
  readSync,
  closeSync,
  readFileSync,
} from "node:fs";

// ---------------------------------------------------------------------------
// Bounded file reads. Shell history and the exit-code log are append-mostly,
// unbounded user files — a HISTFILESIZE=unlimited user can grow them past
// hundreds of MB, and readFileSync-wh whole would stall startup or OOM it.
// readTailWindow caps the read by taking the TAIL (recency wins: the newest
// commands matter most) and drops a leading partial line so parsers never
// see a fragment. Returns null when the file is missing/unreadable.
// ---------------------------------------------------------------------------

export function readTailWindow(
  path: string,
  maxBytes: number
): string | null {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return null;
  }
  if (size <= maxBytes) {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  }
  const start = size - maxBytes;
  const buf = Buffer.alloc(maxBytes);
  let fd = -1;
  try {
    fd = openSync(path, "r");
    let read = 0;
    while (read < maxBytes) {
      const n = readSync(fd, buf, read, maxBytes - read, start + read);
      if (n === 0) break; // raced truncation; take what we got
      read += n;
    }
    let text = buf.subarray(0, read).toString("utf8");
    const nl = text.indexOf("\n");
    if (nl >= 0) text = text.slice(nl + 1);
    console.error(
      `[mnemyx] ${path} exceeds ${maxBytes} bytes — indexing the most recent window`
    );
    return text;
  } catch {
    return null;
  } finally {
    if (fd >= 0) {
      try {
        closeSync(fd);
      } catch {
        // Best effort; the read already succeeded or failed above.
      }
    }
  }
}
