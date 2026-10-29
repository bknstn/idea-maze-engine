import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

import Database from "better-sqlite3";

const workspaceRoot = resolve(process.env.IDEA_MAZE_HOME ?? "/data");
const backupRoot = resolve(process.env.IDEA_MAZE_BACKUP_HOME ?? "/backups");
const databaseRelativePath = join("data", "lab.db");
const artifactsRelativePath = "artifacts";

async function main() {
  const [, , operation, name] = process.argv;
  if ((operation !== "backup" && operation !== "restore") || !isSafeName(name)) {
    throw new Error("Usage: node data-transfer.mjs backup|restore BACKUP_NAME");
  }
  if (operation === "backup") await createBackup(name);
  else await restoreBackup(name);
}

async function createBackup(name) {
  const sourceDatabase = join(workspaceRoot, databaseRelativePath);
  if (!isRegularFile(sourceDatabase)) throw new Error("The workspace database is not available.");
  mkdirSync(backupRoot, { recursive: true, mode: 0o700 });

  const finalDirectory = join(backupRoot, name);
  if (existsSync(finalDirectory)) throw new Error("A backup with that name already exists.");
  const stagingDirectory = join(backupRoot, `.${name}.${randomUUID()}.partial`);
  mkdirSync(stagingDirectory, { mode: 0o700 });
  try {
    const stagingDatabase = join(stagingDirectory, databaseRelativePath);
    mkdirSync(join(stagingDirectory, "data"), { recursive: true, mode: 0o700 });
    const database = new Database(sourceDatabase, { readonly: true, fileMustExist: true });
    try {
      await database.backup(stagingDatabase);
    } finally {
      database.close();
    }
    chmodSync(stagingDatabase, 0o600);

    const sourceArtifacts = join(workspaceRoot, artifactsRelativePath);
    const stagingArtifacts = join(stagingDirectory, artifactsRelativePath);
    mkdirSync(stagingArtifacts, { mode: 0o700 });
    if (existsSync(sourceArtifacts)) copyTree(sourceArtifacts, stagingArtifacts);
    const manifest = {
      formatVersion: 1,
      createdAt: new Date().toISOString(),
      databaseSha256: sha256File(stagingDatabase),
      artifactFileCount: countFiles(stagingArtifacts),
    };
    writeFileSync(join(stagingDirectory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    renameSync(stagingDirectory, finalDirectory);
  } catch (error) {
    rmSync(stagingDirectory, { recursive: true, force: true });
    throw error;
  }
  process.stdout.write(`Created consistent workspace backup ${name}.\n`);
}

async function restoreBackup(name) {
  const backupDirectory = join(backupRoot, name);
  const backupDatabase = join(backupDirectory, databaseRelativePath);
  const backupArtifacts = join(backupDirectory, artifactsRelativePath);
  const manifestPath = join(backupDirectory, "manifest.json");
  if (!isRegularFile(backupDatabase) || !isRegularFile(manifestPath)) {
    throw new Error("The selected backup is incomplete.");
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (!manifest || manifest.formatVersion !== 1 || manifest.databaseSha256 !== sha256File(backupDatabase) ||
      !Number.isSafeInteger(manifest.artifactFileCount) || manifest.artifactFileCount < 0) {
    throw new Error("The selected backup failed its integrity check.");
  }
  if (!isDirectory(backupArtifacts) || countFiles(backupArtifacts) !== manifest.artifactFileCount) {
    throw new Error("The selected backup artifacts failed their integrity check.");
  }

  const targetDatabase = join(workspaceRoot, databaseRelativePath);
  const targetArtifacts = join(workspaceRoot, artifactsRelativePath);
  const targetWal = `${targetDatabase}-wal`;
  const targetShm = `${targetDatabase}-shm`;
  if (existsSync(targetDatabase) || existsSync(targetWal) || existsSync(targetShm) || existsSync(targetArtifacts)) {
    throw new Error("Restore requires an empty workspace with no database, SQLite sidecars, or artifacts directory.");
  }

  const stagingDirectory = join(workspaceRoot, `.restore-${randomUUID()}`);
  mkdirSync(stagingDirectory, { mode: 0o700 });
  let databaseInstalled = false;
  let artifactsInstalled = false;
  try {
    const stagedDatabase = join(stagingDirectory, "lab.db");
    copyFileSync(backupDatabase, stagedDatabase);
    chmodSync(stagedDatabase, 0o600);
    const check = new Database(stagedDatabase, { readonly: true, fileMustExist: true });
    try {
      const rows = check.pragma("quick_check");
      if (!Array.isArray(rows) || rows.length !== 1 || rows[0]?.quick_check !== "ok") {
        throw new Error("The selected backup database failed SQLite integrity verification.");
      }
    } finally {
      check.close();
    }
    const stagedArtifacts = join(stagingDirectory, "artifacts");
    mkdirSync(stagedArtifacts, { mode: 0o700 });
    copyTree(backupArtifacts, stagedArtifacts);

    mkdirSync(join(workspaceRoot, "data"), { recursive: true, mode: 0o700 });
    if (existsSync(targetDatabase) || existsSync(targetWal) || existsSync(targetShm) || existsSync(targetArtifacts)) {
      throw new Error("The workspace changed while restore was being prepared.");
    }
    renameSync(stagedArtifacts, targetArtifacts);
    artifactsInstalled = true;
    renameSync(stagedDatabase, targetDatabase);
    databaseInstalled = true;
  } catch (error) {
    if (databaseInstalled) rmSync(targetDatabase, { force: true });
    if (artifactsInstalled) rmSync(targetArtifacts, { recursive: true, force: true });
    throw error;
  } finally {
    rmSync(stagingDirectory, { recursive: true, force: true });
  }
  process.stdout.write(`Restored workspace backup ${name} into the empty workspace.\n`);
}

function copyTree(source, destination) {
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    const info = lstatSync(from);
    if (info.isSymbolicLink()) throw new Error("Backup paths cannot contain symbolic links.");
    if (info.isDirectory()) {
      mkdirSync(to, { mode: 0o700 });
      copyTree(from, to);
    } else if (info.isFile()) {
      copyFileSync(from, to);
      chmodSync(to, 0o600);
    } else {
      throw new Error("Backup paths may contain only regular files and directories.");
    }
  }
}

function countFiles(directory) {
  let total = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const current = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error("Backup paths cannot contain symbolic links.");
    if (entry.isDirectory()) total += countFiles(current);
    else if (entry.isFile()) total += 1;
    else throw new Error("Backup paths may contain only regular files and directories.");
  }
  return total;
}

function isSafeName(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(value);
}

function isRegularFile(path) {
  try { return lstatSync(path).isFile(); } catch { return false; }
}

function isDirectory(path) {
  try { return lstatSync(path).isDirectory(); } catch { return false; }
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

main().catch(() => {
  process.stderr.write("Workspace backup or restore failed. Check the selected paths and file permissions.\n");
  process.exitCode = 1;
});
