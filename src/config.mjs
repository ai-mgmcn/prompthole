// All environment- and path-dependent settings in one place.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const config = {
  root,
  publicDir: path.join(root, 'public'),
  dataDir: process.env.PROMPTHOLE_DATA || path.join(root, 'data'),
  port: Number(process.env.PROMPTHOLE_PORT || 8787),
  host: process.env.PROMPTHOLE_HOST || '127.0.0.1', // loopback unless you are inside a container (then 0.0.0.0 + publish only to 127.0.0.1)
  maxEvents: 5000,
  // Rule libraries offered by "Import rules". Overridable so tests never touch the network.
  presets: {
    gitleaks: process.env.PROMPTHOLE_PRESET_GITLEAKS_URL || 'https://raw.githubusercontent.com/gitleaks/gitleaks/master/config/gitleaks.toml',
    'secrets-db': process.env.PROMPTHOLE_PRESET_SECRETSDB_URL || 'https://raw.githubusercontent.com/mazen160/secrets-patterns-db/master/db/rules-stable.yml',
  },
};

export const DEFAULT_UPSTREAMS = [
  { id: 'anthropic', label: 'Claude Code / Anthropic', prefix: 'anthropic', url: 'https://api.anthropic.com', env: 'ANTHROPIC_BASE_URL', suffix: '', format: 'anthropic' },
  { id: 'openai', label: 'OpenAI SDK / Codex CLI', prefix: 'openai', url: 'https://api.openai.com', env: 'OPENAI_BASE_URL', suffix: '/v1', format: 'openai' },
  { id: 'gemini', label: 'Gemini', prefix: 'gemini', url: 'https://generativelanguage.googleapis.com', env: 'GOOGLE_GEMINI_BASE_URL', suffix: '', format: 'gemini' },
  { id: 'lmstudio', label: 'LM Studio (local)', prefix: 'lmstudio', url: 'http://127.0.0.1:1234', env: '', suffix: '/v1', format: 'openai' },
];
