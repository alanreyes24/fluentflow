import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The manifest the desktop app updates its web bundle from.
 *
 * The desktop shell runs the same Expo web export this server hosts. Rather
 * than wait for a rebuild, it fetches this manifest, downloads any file it
 * does not already have, and checks every one against the hashes here. See
 * `apps/desktop/src/web-bundle.js`, which computes the same `id` for its own
 * bundled export; `apps/desktop/test/web-bundle.test.mjs` holds the two
 * implementations together.
 */
export interface DesktopBundleManifest {
  /** A hash over every file's path and content hash. */
  id: string;
  /** The deployed commit, when the host says which one it is. */
  commit: string | null;
  /** The desktop shell fingerprint this export was built against. */
  shell: string | null;
  files: { path: string; size: number; sha256: string }[];
}

function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

function listFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (directory: string, prefix: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(join(directory, entry.name), relative);
      else if (entry.isFile()) found.push(relative);
    }
  };
  walk(root, '');
  return found.sort();
}

export function bundleId(files: readonly { path: string; sha256: string }[]): string {
  const lines = [...files]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((file) => `${file.path}\0${file.sha256}\n`)
    .join('');
  return sha256(lines);
}

export function desktopBundleManifest(webDir: string, commit: string | null): DesktopBundleManifest {
  const files = listFiles(webDir).map((relative) => {
    const data = readFileSync(join(webDir, ...relative.split('/')));
    return { path: relative, size: data.length, sha256: sha256(data) };
  });

  let shell: string | null = null;
  const shellFile = join(webDir, 'desktop-shell.json');
  if (existsSync(shellFile)) {
    try {
      const parsed = JSON.parse(readFileSync(shellFile, 'utf8')) as { fingerprint?: unknown };
      shell = typeof parsed.fingerprint === 'string' ? parsed.fingerprint : null;
    } catch {
      shell = null;
    }
  }

  return { id: bundleId(files), commit, shell, files };
}
