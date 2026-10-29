import { appendFileSync, readFileSync } from "node:fs";

const searchEndpoint = "https://api.tavily.com/search";
const modeFile = process.env.IDEA_MAZE_SMOKE_MODE_FILE;
const callLog = process.env.IDEA_MAZE_SMOKE_CALL_LOG;
const ambientFetch = globalThis.fetch;

globalThis.fetch = async (input, init = {}) => {
  const requestedUrl = input instanceof URL ? input.href : String(input);
  if (requestedUrl === "http://127.0.0.1:8787/healthz") {
    return ambientFetch(input, init);
  }
  if (requestedUrl !== searchEndpoint) {
    throw new Error("The packaging smoke fixture blocks all unmocked outbound fetches.");
  }
  appendFileSync(callLog, "search\n", { mode: 0o600 });

  const mode = readFileSync(modeFile, "utf8").trim();
  if (mode === "block") {
    await waitForRelease(modeFile, init.signal);
  }
  return new Response(JSON.stringify({ results: [] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};

function waitForRelease(path, signal) {
  return new Promise((resolve, reject) => {
    let timer;
    const cleanup = () => {
      if (timer) clearInterval(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(signal.reason ?? new DOMException("Synthetic provider stopped", "AbortError"));
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    timer = setInterval(() => {
      if (readFileSync(path, "utf8").trim() === "release") {
        cleanup();
        resolve();
      }
    }, 25);
  });
}

// This file is mounted only by deploy/smoke-test.mjs; production images do not
// copy it. Keep this fallback reference explicit for auditability.
void ambientFetch;
