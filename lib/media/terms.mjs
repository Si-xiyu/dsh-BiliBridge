/**
 * 从视频元数据里取领域词，供 OCR 词表与 ASR 提示使用。
 *
 * 不做中文分词（没有词典依赖）：只取可靠边界的片段——
 * 拉丁词/型号（Git、C++、Vue3、RTX4090）、书名号/方括号/引号里的名称、#话题#、UP 主名。
 */

const LATIN = /[A-Za-z][A-Za-z0-9+#._-]*[A-Za-z0-9+#]|[A-Za-z]{2,}/g;
const QUOTED = /[《【「『“"]([^《》【】「」『』“”"]{1,24})[》】」』”"]/g;
const HASHTAG = /#([^#\s]{1,24})#/g;
const STOP = new Set(['the', 'and', 'for', 'with', 'you', 'are', 'this', 'that', 'from', 'http', 'https', 'www', 'com', 'bilibili', 'BV']);

function push(out, seen, value) {
  const term = String(value ?? '').trim();
  if (term.length < 2 || term.length > 24) return;
  const key = term.toLowerCase();
  if (seen.has(key) || STOP.has(term) || STOP.has(key)) return;
  seen.add(key);
  out.push(term);
}

/**
 * @param {{title?:string, desc?:string, owner?:{name?:string}}} video
 * @param {{limit?:number}} [options]
 * @returns {string[]} 去重后的领域词，按出现顺序（标题优先）
 */
export function domainTerms(video, { limit = 30 } = {}) {
  const out = [];
  const seen = new Set();
  // 简介可能很长且带链接，只看前 500 字；链接先去掉，避免把域名当成术语。
  const texts = [video?.title, String(video?.desc ?? '').slice(0, 500).replace(/https?:\/\/\S+/g, ' ')];
  for (const text of texts) {
    const value = String(text ?? '');
    for (const match of value.matchAll(QUOTED)) push(out, seen, match[1]);
    for (const match of value.matchAll(HASHTAG)) push(out, seen, match[1]);
    for (const match of value.matchAll(LATIN)) push(out, seen, match[0]);
  }
  push(out, seen, video?.owner?.name);
  return out.slice(0, limit);
}

/** Whisper 的 prompt 上限约 224 token；中文按 1 字≈1 token 保守截断。 */
export const ASR_PROMPT_MAX_CHARS = 160;

/**
 * ASR 上下文提示：保留"简体中文"引导句，追加标题与领域词。
 * 非中文转写只给标题与词表，不加中文引导句。
 */
export function asrPrompt(video, language = 'zh') {
  const zh = language === 'zh';
  const parts = [];
  if (zh) parts.push('以下是普通话的句子，用简体中文书写。');
  const title = String(video?.title ?? '').replace(/\s+/g, ' ').trim();
  if (title) parts.push(zh ? `视频标题：${title}。` : `${title}.`);
  const terms = domainTerms(video, { limit: 20 });
  if (terms.length) parts.push(zh ? `相关词：${terms.join('、')}。` : `${terms.join(', ')}.`);
  let prompt = parts.join('');
  if ([...prompt].length > ASR_PROMPT_MAX_CHARS) prompt = [...prompt].slice(0, ASR_PROMPT_MAX_CHARS).join('');
  return prompt || null;
}

/**
 * ASR 提示（A1）：默认不注入元数据 prompt，只保留 daemon 的内置简体引导句。
 *
 * 实测：
 * - hotwords 单独或与 prompt 同时传，会让 180–240s 窗口退化成 1–3 段（CER 0.57–0.59）；
 * - prompt-only 在 6 个 held-out 视频 × 2 窗口上没有净收益（均值 0.1528 vs 0.1486，5 负/3 胜/1 平）。
 * 因此元数据 prompt 默认关闭，仅保留显式 opt-in 入口供后续实验；hotwords 不恢复。
 */
export function asrHints(video, language = 'zh', { metadata = false } = {}) {
  if (!metadata) return {};
  const prompt = asrPrompt(video, language);
  return prompt ? { prompt } : {};
}
