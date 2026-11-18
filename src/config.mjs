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
  maxEvents: Math.max(100, Number(process.env.PROMPTHOLE_MAX_EVENTS || 5000)),   // recent requests kept in memory for the dashboard (the audit files keep everything)
  auditDays: Math.max(0, Number(process.env.PROMPTHOLE_AUDIT_DAYS || 0)),        // audit files older than this many days are deleted; 0 keeps them forever
  // limits that keep one request from hurting everyone else
  maxBodyBytes: Number(process.env.PROMPTHOLE_MAX_BODY_MB || 64) * 1024 * 1024,   // largest request body PromptHole will buffer and scan
  scanTimeoutMs: Number(process.env.PROMPTHOLE_SCAN_TIMEOUT_MS || 3000),          // a scan that takes longer is stopped (see onScanTimeout)
  scanWorkers: Number(process.env.PROMPTHOLE_SCAN_WORKERS || 0) || undefined,     // default: CPU count - 1, between 1 and 4
  onScanTimeout: process.env.PROMPTHOLE_ON_SCAN_TIMEOUT === 'allow' ? 'allow' : 'block', // block = fail closed (safe default for a protection gateway)
  upstreamIdleMs: Number(process.env.PROMPTHOLE_UPSTREAM_IDLE_SECONDS || 900) * 1000, // abort an upstream connection that sends nothing for this long
  allowPrivateUrls: process.env.PROMPTHOLE_ALLOW_PRIVATE_URLS === '1', // let "Import from link" reach internal hosts (default: public links only)
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
