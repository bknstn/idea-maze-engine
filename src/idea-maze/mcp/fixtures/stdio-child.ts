/** Executable test child: injects a synthetic app and owns its shutdown. */

import { pathToFileURL } from "node:url";

import { createFakeResearchApplication } from "./fake-application.js";
import { startStdioResearchServer } from "../stdio.js";

async function main(): Promise<void> {
  const fixture = createFakeResearchApplication({ workDelayMilliseconds: 250 });
  const handle = await startStdioResearchServer(fixture.app, {
    onShutdown: fixture.shutdown,
  });
  process.once("SIGTERM", () => {
    void handle.close().catch(() => { process.exitCode = 1; });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch(() => {
    // Keep startup diagnostics on stderr and avoid reflecting injected errors.
    process.stderr.write("The synthetic stdio MCP fixture failed to start.\n");
    process.exitCode = 1;
  });
}
