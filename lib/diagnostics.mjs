/**
 * 安装自检：离线聚合“这台机器上缺什么、装了什么”。
 *
 * 不联网、不下载模型、不跑 OCR/ASR 推理；存储检查会按需创建数据目录并写一个临时文件（随即删除），
 * 其余均为只读探测。
 * 纯聚合：环境（env/platform）与外部探测（readers）都可注入，单测不碰真实安装。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BiliError } from './bili/errors.mjs';
import { readJson } from './bili/store.mjs';
import { resolveToolchain } from './media/ffmpeg.mjs';
import { resolveAsr } from './media/asr.mjs';
import { ocrAvailability, ocrEngineFor } from './media/ocr.mjs';
import { visionBinaryPath, visionHelperState } from './media/vision-ocr.mjs';

const LIB_DIR = dirname(fileURLToPath(import.meta.url));
/** 仓库根目录：diagnostics.mjs 在 lib/ 下，上一级就是包根。 */
export const pluginRoot = dirname(LIB_DIR);

/** 插件版本：直接读 package.json，不依赖宿主注入。 */
export function readPluginVersion() {
  try {
    return JSON.parse(readFileSync(join(pluginRoot, 'package.json'), 'utf8')).version ?? null;
  } catch {
    return null;
  }
}

/**
 * 用桩 ctx 跑一次 apply()，收集注册的工具名。
 * 只注册、不执行；工具需要 host 才能跑，这里不碰网络与磁盘。
 */
export async function collectToolNames() {
  // 动态导入：lib/index.js 会 import settings-api，而 settings-api 又要 import 本模块，
  // 静态导入会形成 ESM 循环。这里延迟到调用时再解析，避免初始化顺序依赖。
  const { apply } = await import('./index.js');
  const names = [];
  apply({
    tools: { register(def) { if (def?.name) names.push(def.name); } },
    on() {},
    inject() {},
  });
  return names;
}

let cachedToolCount;
/** 已注册工具数（成功一次后缓存；注册失败不缓存，便于下次重试）。 */
export async function countRegisteredTools() {
  if (cachedToolCount === undefined) cachedToolCount = (await collectToolNames()).length;
  return cachedToolCount;
}

let cachedIdentity;
/** 设置页与 doctor 共用的安装身份。 */
export async function collectIdentity() {
  if (!cachedIdentity) {
    cachedIdentity = {
      version: readPluginVersion(),
      modulePath: pluginRoot,
      toolCount: await countRegisteredTools(),
    };
  }
  return cachedIdentity;
}

function dataDirFrom(env, platform) {
  return env.BILI_DATA_DIR || join(env.DSH_HOME || join(homedir(), '.dsh'), 'bilibili');
}

function firstLine(text) {
  return String(text ?? '').split(/\r?\n/)[0]?.trim() || null;
}

function probeBinaryVersion(bin, args = ['-version']) {
  if (!bin) return null;
  try {
    const result = spawnSync(bin, args, { encoding: 'utf8', timeout: 2000, windowsHide: true });
    if (result.error || result.status !== 0) return null;
    return firstLine(result.stdout);
  } catch {
    return null;
  }
}

/** 在模型目录里找已下载的权重；只读，不触发下载。 */
async function scanModelFiles(dir, depth = 0, budget = { entries: 0 }) {
  if (!dir || depth > 4) return [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found = [];
  for (const entry of entries) {
    if (budget.entries++ > 2000) break;
    // HuggingFace 缓存把权重放在 blobs/，snapshots/ 里是符号链接；只认这个文件名，
    // 不跟随目录链接，避免扫描跑出模型目录。
    if (entry.name === 'model.bin') {
      // HF 的 snapshots 里 model.bin 是符号链接；必须跟随一层确认目标真的存在，
      // 悬空链接或同名目录都不能算"已下载"。
      try {
        const info = await stat(join(dir, entry.name));
        if (info.isFile()) found.push(join(dir, entry.name));
      } catch {}
      continue;
    }
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) found.push(...await scanModelFiles(join(dir, entry.name), depth + 1, budget));
  }
  return found;
}

function section(id, label, required, { ok, code = 'OK', detail = '', ...extra }) {
  return { id, label, ok: Boolean(ok), code, detail, required, ...extra };
}

async function runtimeSection({ platform, identity }) {
  const nodeMajor = Number(String(process.versions?.node ?? process.version).split('.')[0]);
  const base = `${process.version} · ${platform}/${process.arch}`;
  // Node 版本是"必需项"；插件身份只是信息，取不到不应让安装自检失败
  // （例如 sharp 未装时导入入口会失败，但 sharp 是可选能力）。
  if (Number.isFinite(nodeMajor) && nodeMajor < 20) {
    return section('runtime', '运行时与模块', true, {
      ok: false, code: 'NODE_UNSUPPORTED',
      detail: `${base}；Node 需要 ≥ 20（当前 ${process.version}）`,
    });
  }
  if (!identity) {
    return section('runtime', '运行时与模块', true, {
      ok: true, code: 'IDENTITY_UNKNOWN',
      detail: `${base} · 插件身份未知（入口导入失败，见 sharp/依赖项）`,
    });
  }
  return section('runtime', '运行时与模块', true, {
    ok: true,
    detail: `${base} · 插件 ${identity.version ?? 'unknown'} · ${identity.toolCount} 个工具 · ${identity.modulePath}`,
  });
}

async function ffmpegSection({ env, platform, readers }) {
  const resolve = readers.toolchain ?? (() => resolveToolchain({ force: true }));
  try {
    const toolchain = await resolve({ force: true, env, platform });
    const version = (readers.ffmpegVersion ?? probeBinaryVersion)(toolchain.ffmpeg);
    // Windows 上 gnutls 构建不读系统证书库：没有 caFile 时能解析二进制，但 HTTPS 抽帧/音频会失败。
    const caMissing = platform === 'win32' && !toolchain.caFile;
    const caDetail = toolchain.caFile
      ? ` · CA ${toolchain.caFile}`
      : platform === 'win32'
        ? ' · CA 未配置（Windows 上 HTTPS 抽帧/音频会证书失败，设置 ffmpegCaFile）'
        : ' · CA 使用系统默认';
    return section('ffmpeg', 'ffmpeg（精确抽帧）', false, {
      ok: !caMissing,
      code: caMissing ? 'CA_MISSING' : 'OK',
      detail: `${toolchain.ffmpeg}${version ? ` · ${version}` : '（无法读取版本）'}${caDetail}`,
    });
  } catch (error) {
    return section('ffmpeg', 'ffmpeg（精确抽帧）', false, {
      ok: false,
      code: error instanceof BiliError ? error.code : 'DEPENDENCY_MISSING',
      detail: `${error?.message ?? error}（缺省时画面降级为故事板）`,
    });
  }
}

/** 显式路径：绝对路径、家目录、当前目录或盘符开头。 */
function explicitPathLike(value) {
  return value.startsWith('.') || value.startsWith('~') ||
    value.startsWith('/') || value.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(value);
}

/**
 * faster-whisper 的尺寸别名 → HF 仓库 ID。
 * 别名不一定等于缓存目录后缀（例如 large → Systran/faster-whisper-large-v3），
 * 这里与 faster_whisper.utils._MODELS 对齐；升级依赖时要同步。
 */
const WHISPER_REPOS = {
  'tiny.en': 'Systran/faster-whisper-tiny.en',
  tiny: 'Systran/faster-whisper-tiny',
  'base.en': 'Systran/faster-whisper-base.en',
  base: 'Systran/faster-whisper-base',
  'small.en': 'Systran/faster-whisper-small.en',
  small: 'Systran/faster-whisper-small',
  'medium.en': 'Systran/faster-whisper-medium.en',
  medium: 'Systran/faster-whisper-medium',
  'large-v1': 'Systran/faster-whisper-large-v1',
  'large-v2': 'Systran/faster-whisper-large-v2',
  'large-v3': 'Systran/faster-whisper-large-v3',
  large: 'Systran/faster-whisper-large-v3',
  'distil-small.en': 'Systran/faster-distil-whisper-small.en',
  'distil-medium.en': 'Systran/faster-distil-whisper-medium.en',
  'distil-large-v2': 'Systran/faster-distil-whisper-large-v2',
  'distil-large-v3': 'Systran/faster-distil-whisper-large-v3',
  'large-v3-turbo': 'mobiuslabsgmbh/faster-whisper-large-v3-turbo',
  turbo: 'mobiuslabsgmbh/faster-whisper-large-v3-turbo',
};

/**
 * 只读判断“当前配置的模型”是否已在本机。
 *
 * HF 缓存目录名形如 `models--Systran--faster-whisper-small`，只按整个目录里
 * 任意 model.bin 判断会把别的模型误当成已就绪（例如缓存了 tiny、配置的是 small）。
 */
export async function isAsrModelReady({ model, modelDir, cwd = process.cwd() } = {}) {
  if (!model || typeof model !== 'string') return { ready: false, detail: '未配置模型' };
  // faster-whisper 会先看 model 是不是已存在的目录；相对目录（custom-whisper、models/x）也适用。
  const localDir = explicitPathLike(model) ? model : join(cwd, model);
  try {
    const info = await stat(localDir);
    if (info.isDirectory()) {
      const files = await scanModelFiles(localDir);
      if (files.length > 0) return { ready: true, detail: `本地目录 ${localDir}` };
    }
  } catch {}
  // 模型可能是：尺寸别名（small）、HF 仓库 ID（Systran/faster-whisper-small）或本地路径。
  // 仓库 ID 含 '/'，不能当路径处理；HF 缓存目录会把 '/' 变成 '--' 并加 models-- 前缀。
  const explicitPath = explicitPathLike(model);
  const repoId = !explicitPath ? (WHISPER_REPOS[model] ?? (model.includes('/') ? model : null)) : null;
  const repoCache = repoId ? `models--${repoId.replace(/[\\/]/g, '--')}` : null;
  const candidates = [];
  if (explicitPath) candidates.push(model);
  if (modelDir) {
    if (explicitPath) candidates.push(join(modelDir, model));
    if (repoCache) candidates.push(join(modelDir, repoCache));
    try {
      const entries = await readdir(modelDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        // 尺寸别名按后缀匹配：small 命中 models--Systran--faster-whisper-small。
        if (!repoCache && entry.name.endsWith(model)) candidates.push(join(modelDir, entry.name));
      }
    } catch {}
  }
  for (const dir of candidates) {
    const files = await scanModelFiles(dir);
    if (files.length > 0) return { ready: true, detail: `${files.length} 个权重文件` };
  }
  return { ready: false, detail: '未找到匹配当前模型的权重' };
}

async function asrSection({ env, platform, readers }) {
  const resolve = readers.asr ?? (() => resolveAsr({ force: true }));
  try {
    const asr = await resolve({ force: true, env, platform });
    const state = await (readers.modelReady ?? isAsrModelReady)(asr);
    const ready = Boolean(state?.ready);
    return section('asr', 'ASR（本地转写）', false, {
      ok: ready,
      code: ready ? 'OK' : 'MODEL_MISSING',
      detail: ready
        ? `${asr.python} · 模型 ${asr.model} · ${state.detail ?? '已就绪'}`
        : `运行时 ${asr.python} 可用；模型 ${asr.model} 未就绪（${state?.detail ?? asr.modelDir}；首次转写会下载）`,
    });
  } catch (error) {
    return section('asr', 'ASR（本地转写）', false, {
      ok: false,
      code: error instanceof BiliError ? error.code : 'DEPENDENCY_MISSING',
      detail: `${error?.message ?? error}（无字幕时 bilibili_transcribe 不可用）`,
    });
  }
}

async function sharpSection({ platform, readers }) {
  try {
    const versions = readers.sharpVersions
      ? await readers.sharpVersions()
      : createRequire(import.meta.url)('sharp').versions ?? {};
    const binding = `${platform}-${process.arch}`;
    return section('sharp', 'sharp（图片处理）', false, {
      ok: true,
      detail: `sharp ${versions.sharp ?? '?'} · libvips ${versions.vips ?? versions.libvips ?? '?'} · ${binding}`,
    });
  } catch (error) {
    return section('sharp', 'sharp（图片处理）', false, {
      ok: false, code: 'DEPENDENCY_MISSING',
      detail: `${error?.message ?? error}（缺 npm install 或平台绑定）`,
    });
  }
}

async function ocrSection({ env, platform, readers }) {
  const engineReader = readers.ocrEngine ?? ocrEngineFor;
  const engine = await engineReader(platform);
  if (!engine) {
    return section('ocr', 'OCR（硬字幕/画面文字）', false, {
      ok: false, code: 'UNSUPPORTED',
      detail: `平台 ${platform} 未接入 OCR 引擎（可选能力，缺省降级）`,
    });
  }
  if (platform === 'win32') {
    // 引擎存在不等于能跑：Windows 依赖 powershell.exe，用与设置页相同的可用性检查。
    const view = await (readers.ocrAvailability ?? ocrAvailability)();
    return section('ocr', 'OCR（硬字幕/画面文字）', false, {
      ok: Boolean(view?.available),
      code: view?.available ? 'OK' : 'DEPENDENCY_MISSING',
      detail: view?.available
        ? `${engine}（系统自带）`
        : `${engine} 不可用：${view?.reason ?? '缺少系统组件'}`,
    });
  }
  if (platform !== 'darwin') {
    return section('ocr', 'OCR（硬字幕/画面文字）', false, {
      ok: true, detail: `${engine}（系统自带）`,
    });
  }
  // 只看文件存在不够：Swift 源码改过之后 stamp 会失配，此时已有二进制不可用。
  const state = await (readers.visionState ?? visionHelperState)();
  const swiftc = await (readers.swiftc ?? probeSwiftc)();
  const swiftOk = typeof swiftc === 'object' ? Boolean(swiftc.ok) : Boolean(swiftc);
  const swiftVersion = typeof swiftc === 'object' ? swiftc.version : null;
  return section('ocr', 'OCR（硬字幕/画面文字）', false, {
    ok: state.compiled || swiftOk,
    code: state.compiled ? 'OK' : swiftOk ? 'BUILD_PENDING' : 'DEPENDENCY_MISSING',
    detail: state.compiled
      ? `Apple Vision · ${state.binary}`
      : swiftOk
        ? `Apple Vision 助手${state.stale ? '已过期（源码变了）' : '尚未编译'}（首次 OCR 自动编译；swiftc ${swiftVersion ?? '可用'}）`
        : `缺少 swiftc 且 ${state.binary} 不可用${state.stale ? '（stamp 与源码不匹配）' : '（不存在）'}；xcode-select --install`,
  });
}

function check(id, label, { ok, code = 'OK', detail = '' }) {
  return { id, label, ok: Boolean(ok), code, detail };
}

async function storageSection({ env, platform, readers }) {
  if (readers.storage) {
    const view = await readers.storage({ env, platform });
    return section('storage', '本地存储', true, view);
  }
  const dir = dataDirFrom(env, platform);
  const checks = [];

  let created = false;
  try {
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      created = true;
    }
    const probe = join(dir, `.doctor-${process.pid}-${Date.now()}.tmp`);
    await writeFile(probe, 'ok', { mode: 0o600 });
    await unlink(probe);
    checks.push(check('dataDir', '数据目录可写', {
      ok: true, detail: `${dir}${created ? '（已创建）' : ''}`,
    }));
  } catch (error) {
    checks.push(check('dataDir', '数据目录可写', {
      ok: false, code: 'DIR_UNWRITABLE', detail: `${dir}：${error?.message ?? error}`,
    }));
  }

  const credentials = join(dir, 'credentials.json');
  if (platform === 'win32') {
    checks.push(check('credentials', '凭据文件权限', {
      ok: true, code: 'SKIPPED', detail: 'Windows 用 ACL 收紧，跳过 POSIX 0600 检查',
    }));
  } else if (!existsSync(credentials)) {
    checks.push(check('credentials', '凭据文件权限', {
      ok: true, code: 'ABSENT', detail: '尚无凭据文件（未登录）',
    }));
  } else {
    try {
      const info = await stat(credentials);
      const mode = info.mode & 0o777;
      const tight = (mode & 0o077) === 0;
      checks.push(check('credentials', '凭据文件权限', {
        ok: tight,
        code: tight ? 'OK' : 'CREDENTIALS_PERMISSIONS',
        detail: `${(mode & 0o777).toString(8).padStart(3, '0')}${tight ? '' : '（应为 600）'}`,
      }));
    } catch (error) {
      checks.push(check('credentials', '凭据文件权限', {
        ok: false, code: 'INTERNAL_ERROR', detail: error?.message ?? String(error),
      }));
    }
  }

  const config = join(dir, 'config.json');
  if (!existsSync(config)) {
    checks.push(check('config', 'config.json', {
      ok: true, code: 'ABSENT', detail: '未创建（使用缺省值）',
    }));
  } else {
    const parsed = await readJson(config, null);
    const valid = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed);
    checks.push(check('config', 'config.json', {
      ok: valid,
      code: valid ? 'OK' : 'CONFIG_INVALID',
      detail: valid ? '解析通过' : '解析失败：请检查 JSON',
    }));
  }

  const failed = checks.find((item) => !item.ok);
  return section('storage', '本地存储', true, {
    ok: !failed,
    code: failed?.code ?? 'OK',
    detail: checks.map((item) => `${item.label}：${item.detail}`).join('；'),
    checks,
  });
}

async function loginSection({ env, platform, readers }) {
  if (readers.login) {
    const view = await readers.login({ env, platform });
    return section('login', '登录态（离线）', false, view);
  }
  const credentials = await readJson(join(dataDirFrom(env, platform), 'credentials.json'), null);
  const cookies = credentials?.cookies;
  const hasCredentials = Boolean(cookies && typeof cookies === 'object' && Object.keys(cookies).length > 0);
  if (!hasCredentials) {
    return section('login', '登录态（离线）', false, {
      ok: true, code: 'NOT_LOGGED_IN',
      detail: '未登录；doctor 不访问网络，登录请用 bilibili_auth_begin 扫码',
    });
  }
  const savedAt = Number(credentials?.savedAt);
  const age = Number.isFinite(savedAt) && savedAt > 0
    ? `${Math.max(0, Math.round((Date.now() - savedAt) / 3600_000))} 小时前`
    : '时间未知';
  return section('login', '登录态（离线）', false, {
    ok: true,
    detail: `已保存凭据（${Object.keys(cookies).length} 个 Cookie，保存于 ${age}）`,
  });
}

function probeSwiftc() {
  const version = probeBinaryVersion('swiftc', ['--version']);
  return { ok: Boolean(version), version };
}

/**
 * 汇总安装自检。
 *
 * `env` 与 `platform` 用于存储/登录路径与平台分支；真正执行外部命令的探测
 * （ffmpeg/ASR/Vision）针对当前进程，单测请用 `readers` 覆盖。
 * @param {{env?: NodeJS.ProcessEnv, platform?: string, readers?: object}} [options]
 * @returns {Promise<{ok: boolean, sections: Array<object>, summary: {pass: number, fail: number, skipped: number, requiredFailed: number}>}>}
 */
async function runSection(id, label, required, fn) {
  try {
    return await fn();
  } catch (error) {
    // 单个探测抛异常不能让整张体检表消失：标记这一项失败即可。
    return section(id, label, required, {
      ok: false,
      code: error instanceof BiliError ? error.code : 'INTERNAL_ERROR',
      detail: error?.message ?? String(error),
    });
  }
}

export async function collectDiagnostics({ env = process.env, platform = process.platform, readers = {} } = {}) {
  let identity = null;
  try { identity = await (readers.identity ?? collectIdentity)(); }
  catch { identity = null; }
  const sections = await Promise.all([
    runSection('runtime', '运行时与模块', true, () => runtimeSection({ platform, identity })),
    runSection('ffmpeg', 'ffmpeg（精确抽帧）', false, () => ffmpegSection({ env, platform, readers })),
    runSection('asr', 'ASR（本地转写）', false, () => asrSection({ env, platform, readers })),
    runSection('sharp', 'sharp（图片处理）', false, () => sharpSection({ platform, readers })),
    runSection('ocr', 'OCR（硬字幕/画面文字）', false, () => ocrSection({ env, platform, readers })),
    runSection('storage', '本地存储', true, () => storageSection({ env, platform, readers })),
    runSection('login', '登录态（离线）', false, () => loginSection({ env, platform, readers })),
  ]);

  const summary = { pass: 0, fail: 0, skipped: 0, requiredFailed: 0 };
  for (const item of sections) {
    // 段内也可能有被跳过的子检查（例如 Windows 跳过 POSIX 0600），汇总要算进去。
    summary.skipped += (item.checks ?? []).filter((check) => check.code === 'SKIPPED').length;
    if (item.code === 'SKIPPED') summary.skipped++;
    else if (item.ok) summary.pass++;
    else {
      summary.fail++;
      if (item.required) summary.requiredFailed++;
    }
  }
  return { ok: summary.requiredFailed === 0, identity, sections, summary };
}
