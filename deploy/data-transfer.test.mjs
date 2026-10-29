import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import Database from "better-sqlite3";

const transferScript = fileURLToPath(new URL("./data-transfer.mjs", import.meta.url));

function makeSandbox(t) {
  const root = mkdtempSync(join(tmpdir(), "idea-maze-transfer-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function makeWorkspace(root, { database = true, artifacts = true } = {}) {
  if (database) {
    const databasePath = join(root, "data", "lab.db");
    mkdirSync(dirname(databasePath), { recursive: true });
    const db = new Database(databasePath);
    db.exec("CREATE TABLE synthetic_records (id TEXT PRIMARY KEY, value TEXT NOT NULL)");
    db.prepare("INSERT INTO synthetic_records (id, value) VALUES (?, ?)").run("fixture-1", "synthetic restore value");
    db.close();
  }
  if (artifacts) {
    mkdirSync(join(root, "artifacts"), { recursive: true });
    writeFileSync(join(root, "artifacts", "brief.md"), "Synthetic artifact for restore verification.\n");
  }
}

function transfer(operation, name, workspace, backups) {
  return spawnSync(process.execPath, [transferScript, operation, name], {
    encoding: "utf8",
    env: {
      ...process.env,
      IDEA_MAZE_HOME: workspace,
      IDEA_MAZE_BACKUP_HOME: backups,
    },
  });
}

function createBackup(t, name = "synthetic-backup") {
  const root = makeSandbox(t);
  const workspace = join(root, "workspace");
  const backups = join(root, "backups");
  mkdirSync(workspace);
  mkdirSync(backups);
  makeWorkspace(workspace);
  const writer = new Database(join(workspace, "data", "lab.db"));
  writer.pragma("journal_mode = WAL");
  writer.prepare("INSERT INTO synthetic_records (id, value) VALUES (?, ?)").run("fixture-wal", "committed in the active WAL");
  try {
    const result = transfer("backup", name, workspace, backups);
    assert.equal(result.status, 0, result.stderr);
  } finally {
    writer.close();
  }
  return { root, workspace, backups, name };
}

test("creates a SQLite-consistent snapshot and restores synthetic data and artifacts", (t) => {
  const { root, backups, name } = createBackup(t);
  const restoredWorkspace = join(root, "restored");
  mkdirSync(restoredWorkspace);

  const result = transfer("restore", name, restoredWorkspace, backups);
  assert.equal(result.status, 0, result.stderr);

  const db = new Database(join(restoredWorkspace, "data", "lab.db"), { readonly: true, fileMustExist: true });
  try {
    assert.deepEqual(db.prepare("SELECT id, value FROM synthetic_records").get(), {
      id: "fixture-1",
      value: "synthetic restore value",
    });
    assert.deepEqual(db.prepare("SELECT id, value FROM synthetic_records WHERE id = ?").get("fixture-wal"), {
      id: "fixture-wal",
      value: "committed in the active WAL",
    });
    assert.deepEqual(db.pragma("quick_check"), [{ quick_check: "ok" }]);
  } finally {
    db.close();
  }
  assert.equal(readFileSync(join(restoredWorkspace, "artifacts", "brief.md"), "utf8"), "Synthetic artifact for restore verification.\n");
});

test("refuses workspaces containing a database or stale SQLite WAL/SHM sidecars", (t) => {
  const { root, backups, name } = createBackup(t);
  const existing = join(root, "existing");
  mkdirSync(existing);
  makeWorkspace(existing, { artifacts: false });
  const nonempty = transfer("restore", name, existing, backups);
  assert.notEqual(nonempty.status, 0);
  assert.match(nonempty.stderr, /failed/i);
  const existingDb = new Database(join(existing, "data", "lab.db"), { readonly: true });
  try {
    assert.equal(existingDb.prepare("SELECT value FROM synthetic_records").get().value, "synthetic restore value");
  } finally {
    existingDb.close();
  }

  for (const suffix of ["-wal", "-shm"]) {
    const stale = join(root, `stale${suffix.slice(1)}`);
    mkdirSync(join(stale, "data"), { recursive: true });
    writeFileSync(join(stale, "data", `lab.db${suffix}`), "stale synthetic sidecar");
    const rejected = transfer("restore", name, stale, backups);
    assert.notEqual(rejected.status, 0, `restore should reject ${suffix}`);
    assert.match(rejected.stderr, /failed/i);
    assert.equal(readFileSync(join(stale, "data", `lab.db${suffix}`), "utf8"), "stale synthetic sidecar");
    assert.equal(exists(join(stale, "data", "lab.db")), false);
  }
});

test("rejects corrupt database snapshots and artifact symlinks", (t) => {
  const fixture = createBackup(t, "corrupt-fixture");
  const backupDatabase = join(fixture.backups, fixture.name, "data", "lab.db");
  writeFileSync(backupDatabase, "not a SQLite database");
  const manifestPath = join(fixture.backups, fixture.name, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.databaseSha256 = createHash("sha256").update(readFileSync(backupDatabase)).digest("hex");
  writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
  const restoreTarget = join(fixture.root, "corrupt-restore");
  mkdirSync(restoreTarget);
  const corrupt = transfer("restore", fixture.name, restoreTarget, fixture.backups);
  assert.notEqual(corrupt.status, 0);
  assert.equal(exists(join(restoreTarget, "data", "lab.db")), false);

  const symlinkSandbox = makeSandbox(t);
  const workspace = join(symlinkSandbox, "workspace");
  const backups = join(symlinkSandbox, "backups");
  mkdirSync(workspace);
  mkdirSync(backups);
  makeWorkspace(workspace, { artifacts: false });
  mkdirSync(join(workspace, "artifacts"));
  const syntheticTarget = join(symlinkSandbox, "outside.txt");
  writeFileSync(syntheticTarget, "synthetic target");
  symlinkSync(syntheticTarget, join(workspace, "artifacts", "linked.txt"));
  const rejected = transfer("backup", "symlink-fixture", workspace, backups);
  assert.notEqual(rejected.status, 0);
  assert.equal(exists(join(backups, "symlink-fixture")), false);
});

function exists(path) {
  try { readFileSync(path); return true; } catch { return false; }
}
