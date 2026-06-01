import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function createStateStore({ fileName, envName, logPrefix }) {
  const defaultPath = path.join(repoRoot, 'state', fileName);
  const statePath = process.env[envName] || path.join(
    process.env.OBELISK_BOTS_STATE_DIR || path.dirname(defaultPath),
    fileName,
  );
  const legacyPath = path.join(os.homedir(), `.${fileName}`);

  function loadState() {
    const sourcePath = fs.existsSync(statePath)
      ? statePath
      : fs.existsSync(legacyPath)
        ? legacyPath
        : null;
    if (!sourcePath) return {};

    try {
      const state = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
      if (sourcePath !== statePath) saveState(state);
      return state;
    } catch {
      return {};
    }
  }

  function saveState(state) {
    try {
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
    } catch (err) {
      console.warn(`[${logPrefix}] state save failed:`, err.message);
    }
  }

  return { loadState, saveState, statePath };
}
