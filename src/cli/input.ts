// ---------------------------------------------------------------------------
// Interactive prompts. Single stdin listener buffered into lines: Bun's
// node:readline/promises hangs on the SECOND sequential question() with
// piped stdin (verified empirically), so we buffer ourselves. Works on
// TTYs (canonical line mode) and pipes alike; EOF resolves as No/"".
// ---------------------------------------------------------------------------

export async function ask(promptText: string): Promise<boolean> {
  process.stdout.write(`${promptText} [y/N] `);
  const line = await readStdinLine();
  const answer = (line ?? "").trim().toLowerCase();
  return answer === "y" || answer === "yes"; // EOF / anything else = No
}

// Free-text prompt (for choices). EOF resolves as "".
export async function askText(promptText: string): Promise<string> {
  process.stdout.write(promptText);
  const line = await readStdinLine();
  return (line ?? "").trim();
}

// Line reader over raw stdin. Bun's node:readline/promises hangs on the
// SECOND sequential question() with piped stdin (verified empirically), so
// we buffer lines ourselves with a single listener. Works on TTYs (canonical
// line mode) and pipes alike; EOF resolves pending reads as null.
let stdinBuf = "";
let stdinDone = false;
let stdinHooked = false;
const lineWaiters: ((line: string | null) => void)[] = [];
const lineQueue: string[] = [];

function hookStdin(): void {
  if (stdinHooked) return;
  stdinHooked = true;
  if (process.stdin.readableEnded) {
    stdinDone = true;
    return;
  }
  process.stdin.on("data", (chunk: Buffer | string) => {
    stdinBuf += chunk.toString();
    let idx: number;
    while ((idx = stdinBuf.indexOf("\n")) >= 0) {
      const line = stdinBuf.slice(0, idx).replace(/\r$/, "");
      stdinBuf = stdinBuf.slice(idx + 1);
      const waiter = lineWaiters.shift();
      if (waiter) waiter(line);
      else lineQueue.push(line);
    }
  });
  const onEnd = (): void => {
    stdinDone = true;
    let waiter: ((line: string | null) => void) | undefined;
    while ((waiter = lineWaiters.shift())) waiter(null);
  };
  process.stdin.on("end", onEnd);
  process.stdin.on("close", onEnd);
}

function readStdinLine(): Promise<string | null> {
  hookStdin();
  const queued = lineQueue.shift();
  if (queued !== undefined) return Promise.resolve(queued);
  if (stdinDone) return Promise.resolve(null);
  return new Promise((resolve) => lineWaiters.push(resolve));
}
