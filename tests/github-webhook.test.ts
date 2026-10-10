import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, Status } from "discord.js";
import { describe, expect, it } from "vitest";
import type { AppConfig } from "../src/config.js";
import { createDatabase } from "../src/db/database.js";
import { startGithubWebhookServer } from "../src/github-webhook.js";

// Exercise the real HTTP handler, Discord readiness implementation, and SQLite.
describe("bot HTTP health", () => {
  it("tracks gateway readiness and SQLite, even without webhook credentials", async () => {
    const directory = mkdtempSync(join(tmpdir(), "akron-health-"));
    const database = createDatabase(join(directory, "bot.sqlite"));
    const client = new Client({ intents: [] });
    const errors: unknown[] = [];
    const server = startGithubWebhookServer({
      client,
      db: database.db,
      config: { githubWebhookPort: 0, githubWebhookSecret: "" } as AppConfig,
      async onError(error) { errors.push(error); }
    });
    try {
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected TCP listener.");
      const url = `http://127.0.0.1:${address.port}`;
      const request = () => fetch(`${url}/health`);
      expect((await request()).status).toBe(503);
      client.ws.status = Status.Ready;
      const healthy = await request();
      expect(healthy.status).toBe(200);
      expect(healthy.headers.get("cache-control")).toBe("no-store");
      expect(await healthy.json()).toEqual({ ready: true });
      client.ws.status = Status.Disconnected;
      expect((await request()).status).toBe(503);
      client.ws.status = Status.Ready;
      database.sqlite.close();
      const unavailable = await request();
      expect(unavailable.status).toBe(503);
      expect(await unavailable.json()).toEqual({ ready: false });
      expect((await fetch(`${url}/github/webhook`, { method: "POST" })).status).toBe(404);
      expect((await fetch(`${url}/health`, { method: "POST" })).status).toBe(404);
      expect(errors).toEqual([]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await client.destroy();
      if (database.sqlite.open) database.sqlite.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
