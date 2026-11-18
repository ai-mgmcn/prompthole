// Logos next to tool, provider and model names. The PNGs live in /icons (served locally, nothing is fetched from the internet).
// A name is matched against RULES in order; the first match wins. No match -> a coloured letter, so every name still gets a mark.
// To add one: drop a 64px PNG into public/icons and add a line here.
import { esc } from './dom.js';

export const RULES = [
  // coding tools and clients (before the model families, because "Claude Code" must not become plain "Claude")
  [/claude[ -]?(code|cli)/, 'claudecode'], [/codex/, 'codex'], [/gemini[ -]?cli/, 'geminicli'], [/antigravity/, 'antigravity'],
  [/cline/, 'cline'], [/roo[ -]?code|\broo\b/, 'roocode'], [/kilo/, 'kilocode'], [/cursor/, 'cursor'], [/windsurf|codeium/, 'windsurf'], [/\btrae\b/, 'trae'],
  [/qoder/, 'qoder'], [/\bkiro\b/, 'kiro'], [/junie/, 'junie'], [/\bgoose\b/, 'goose'], [/opencode/, 'opencode'], [/^amp$|ampcode/, 'amp'],
  [/devin/, 'devin'], [/replit/, 'replit'], [/lovable/, 'lovable'], [/^v0$/, 'v0'], [/copilot/, 'githubcopilot'],
  // platforms and routers
  [/lm[ -]?studio/, 'lmstudio'], [/ollama/, 'ollama'], [/openrouter/, 'openrouter'], [/vllm/, 'vllm'], [/open[ -]?webui/, 'openwebui'],
  [/bedrock/, 'bedrock'], [/azure/, 'azure'], [/hugging/, 'huggingface'], [/together/, 'together'], [/fireworks/, 'fireworks'], [/groq/, 'groq'],
  [/cerebras/, 'cerebras'], [/sambanova/, 'sambanova'], [/siliconflow|siliconcloud/, 'siliconcloud'], [/volcengine|volcano/, 'volcengine'], [/deepinfra/, 'deepinfra'],
  [/replicate/, 'replicate'], [/modelscope/, 'modelscope'], [/novita/, 'novita'], [/\bppio\b/, 'ppio'], [/anyscale/, 'anyscale'],
  // image / video models (before openai so "dall-e" and "sora" get their own mark)
  [/dall[ -]?e/, 'dalle'], [/\bsora\b/, 'sora'], [/midjourney/, 'midjourney'], [/stability|stable[ -]?diffusion|sdxl/, 'stability'], [/\bflux\b/, 'flux'],
  [/kling/, 'kling'], [/hailuo/, 'hailuo'], [/runway/, 'runway'],
  // model families, United States and elsewhere
  [/openai|chatgpt|gpt|(^|[^a-z])o[134](-|$)|davinci|whisper|text-embedding/, 'openai'], [/anthropic|\bclaude|opus|sonnet|haiku/, (n) => (/anthropic/.test(n) && !/claude/.test(n) ? 'anthropic' : 'claude')],
  [/gemma/, 'gemma'], [/gemini|palm|bard/, 'gemini'], [/google|genai/, 'google'], [/llama|meta/, 'meta'], [/grok/, 'grok'], [/\bxai\b|x\.ai/, 'xai'],
  [/^copilot$|microsoft copilot/, 'copilot'], [/microsoft|(^|[^a-z])phi-?\d/, 'microsoft'], [/cohere|command-?(r|a|light)|embed-(english|multilingual)/, 'cohere'], [/perplexity|sonar/, 'perplexity'],
  [/nvidia|nemotron/, 'nvidia'], [/\bnova\b|titan/, 'nova'], [/amazon|\baws\b/, 'aws'], [/github/, 'github'], [/vercel/, 'vercel'], [/jina/, 'jina'], [/voyage/, 'voyage'], [/mistral|mixtral|codestral|ministral|pixtral|magistral|devstral/, 'mistral'], [/ai21|jamba/, 'ai21'],
  // model families, China
  [/qwen|qwq|tongyi/, 'qwen'], [/deepseek/, 'deepseek'], [/kimi/, 'kimi'], [/moonshot/, 'moonshot'], [/chatglm/, 'chatglm'], [/glm-?[\d.]*v\b/, 'glmv'], [/\bz\.?ai\b/, 'zai'],
  [/glm|zhipu/, 'zhipu'], [/doubao|seed-/, 'doubao'], [/bytedance/, 'bytedance'],
  [/minimax|abab/, 'minimax'], [/(^|[^a-z])yi-/, 'yi'], [/baichuan/, 'baichuan'], [/hunyuan/, 'hunyuan'], [/tencent/, 'tencent'], [/ernie|wenxin/, 'wenxin'], [/baidu/, 'baidu'],
  [/\bspark\b|xunfei|iflytek/, 'spark'], [/internlm/, 'internlm'], [/(^|[^a-z])step-|stepfun/, 'stepfun'], [/longcat|meituan/, 'longcat'], [/mimo|xiaomi/, 'xiaomimimo'],
  [/sensenova|sensechat/, 'sensenova'], [/alibaba|aliyun|dashscope/, 'alibaba'],
];

const hue = (s) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };

// the file name (without .png) for a name, or null
export function iconFor(name) {
  const n = String(name || '').toLowerCase();
  if (!n || n === 'unknown' || n === '—') return null;
  for (const [re, to] of RULES) if (re.test(n)) return typeof to === 'function' ? to(n) : to;
  return null;
}

// the default icon: a coloured letter (the same name always gets the same colour), or "?" when there is nothing to show
export function letterIcon(name) {
  const s = String(name || '').trim();
  if (!s || s === '—' || s.toLowerCase() === 'unknown') return '<span class="ico mono" style="background:var(--line2)">?</span>';
  return `<span class="ico mono" style="background:hsl(${hue(s.toLowerCase())} 42% 40%)">${esc(s.replace(/[^A-Za-z0-9一-鿿]/g, '').charAt(0).toUpperCase() || '?')}</span>`;
}

// small image, or the default icon when there is no logo for this name
export function icon(name) {
  const f = iconFor(name);
  return f ? `<img class="ico" src="/icons/${f}.png" alt="" width="16" height="16" loading="lazy" data-n="${esc(name)}">` : letterIcon(name);
}

// If a logo file is missing or fails to load, show the default icon instead of a broken image.
// (An inline onerror= would be blocked by the dashboard's Content-Security-Policy, so this listens for the error event instead.)
export function onIconError(e) {
  const el = e.target;
  if (el?.classList?.contains('ico') && el.tagName === 'IMG') el.outerHTML = letterIcon(el.dataset?.n);
}
if (typeof document !== 'undefined') document.addEventListener('error', onIconError, true); // image errors do not bubble, so capture

// icon + text, as one unit
export const withIcon = (name, label = name) => `<span class="ic">${icon(name)}<span>${esc(label)}</span></span>`;
