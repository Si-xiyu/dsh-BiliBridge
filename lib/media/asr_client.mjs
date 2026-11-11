import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BiliError } from '../bili/errors.mjs';

const DAEMON = fileURLToPath(new URL('./asr_daemon.py', import.meta.url));
const transportError = (message) => new BiliError('UPSTREAM_ERROR', message, { data: { daemonFallback: true } });
const allowedCodes = new Set(['INVALID_ARGUMENT', 'DEPENDENCY_MISSING', 'UPSTREAM_ERROR', 'TIMEOUT', 'CANCELLED']);
// 设置里改了 asrPython/asrModelDir 后必须重启 daemon：解释器与 --model-dir 在启动时固定。
const RESET_MESSAGE = 'ASR 运行时已变更，守护进程已重启';
// 已写进 stdin 的请求可能已经被 daemon 执行完：上层据此不能退款（submitted）。
const resetCancellation = (submitted = false) => new BiliError('CANCELLED', RESET_MESSAGE, submitted ? { data: { submitted: true } } : undefined);

/** Injectable process factory keeps the state machine testable without Python. */
export function createAsrClient({ spawnProcess = spawn, resolveRuntime = async () => (await import('./asr.mjs')).resolveAsr() } = {}) {
  let daemon;
  let starting;
  let nextId = 0;
  let tail = Promise.resolve();
  // 每次 resetDaemon 递增；启动中的 daemon 完成后发现自己已过期就自我丢弃，
  // 否则“保存设置时正好在启动”会留下一个用旧路径的常驻进程。
  let generation = 0;

  function refs(state, active) {
    for (const handle of [state.child, state.child.stdin, state.child.stdout, state.child.stderr]) {
      handle?.[active ? 'ref' : 'unref']?.();
    }
  }

  function discard(state, error) {
    if (state.closed) return;
    state.closed = true;
    if (daemon === state) daemon = undefined;
    state.pending?.reject(error);
    state.pending = undefined;
    try { state.child.kill('SIGKILL'); } catch {}
  }

  async function getDaemon() {
    if (daemon) return daemon;
    if (starting) return starting;
    const attempt = startDaemon(generation);
    starting = attempt;
    try { return await attempt; }
    // 只有自己还是当前启动句柄时才清空：resetDaemon 之后可能已经有新一轮启动。
    finally { if (starting === attempt) starting = undefined; }
  }

  async function startDaemon(epoch) {
    const runtime = await resolveRuntime();
    // reset 发生在解析运行时期间：连进程都不要起。
    if (epoch !== generation) throw resetCancellation();
    let child;
    try {
      // 镜像地址从运行时带过来（config.json#hfEndpoint / HF_ENDPOINT），
      // 否则 daemon 首次下载模型会直连 huggingface.co 卡死。
      const env = { ...process.env };
      if (runtime.hfEndpoint) env.HF_ENDPOINT = runtime.hfEndpoint;
      child = spawnProcess(runtime.python, [DAEMON, '--model-dir', runtime.modelDir], {
        stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env,
      });
    } catch (error) { throw transportError(`无法启动 ASR daemon: ${error.message}`); }
    const state = { child, runtime, buffer: '', pending: undefined };
    if (epoch !== generation) {
      // 启动期间被 resetDaemon 作废：不要把这个用旧路径起的进程挂成常驻 daemon。
      state.closed = true;
      try { child.kill('SIGKILL'); } catch {}
      throw resetCancellation();
    }
    daemon = state;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (state.closed) return;
      state.buffer += chunk;
      if (state.buffer.length > 16 * 1024 * 1024) {
        discard(state, transportError('ASR daemon response too large'));
        return;
      }
      let end;
      while ((end = state.buffer.indexOf('\n')) >= 0) {
        const line = state.buffer.slice(0, end);
        state.buffer = state.buffer.slice(end + 1);
        let response;
        try {
          response = JSON.parse(line);
          if (!state.pending || response.id !== state.pending.id || typeof response.ok !== 'boolean' ||
              (response.ok ? !response.payload || !Array.isArray(response.payload.segments) :
                typeof response.code !== 'string' || typeof response.message !== 'string')) throw new Error('invalid envelope');
        } catch {
          discard(state, transportError('ASR daemon 协议异常'));
          return;
        }
        const pending = state.pending;
        state.pending = undefined;
        if (response.ok) pending.resolve(response.payload);
        else pending.reject(new BiliError(allowedCodes.has(response.code) ? response.code : 'UPSTREAM_ERROR', response.message));
      }
    });
    // Drain logs without retaining potentially large model download output.
    child.stderr.resume();
    child.stdin.on('error', (error) => discard(state, transportError(`ASR daemon stdin: ${error.message}`)));
    child.on('error', (error) => discard(state, transportError(`ASR daemon 启动失败: ${error.message}`)));
    child.on('exit', (code) => discard(state, transportError(`ASR daemon 退出: ${code}`)));
    child.stdout.on('end', () => discard(state, transportError('ASR daemon stdout 已关闭')));
    refs(state, false);
    return state;
  }

  async function execute({ wavPath, model, language = 'auto', signal, timeoutMs = 120_000 }) {
    let state;
    let stopped;
    let timer;
    let onAbort;
    // 请求是否已经写进 daemon。超时/取消也必须带这个信息：
    // 已提交的请求可能真的跑完了，上层据此决定能不能退款。
    let sentFlag = false;
    const cancellation = new Promise((_, reject) => {
      const stop = (code, message) => {
        stopped = new BiliError(code, message, sentFlag ? { data: { submitted: true } } : undefined);
        if (state) discard(state, stopped);
        reject(stopped);
      };
      onAbort = () => stop('CANCELLED', 'ASR 已被取消');
      timer = setTimeout(() => stop('TIMEOUT', 'ASR daemon 请求超时'), timeoutMs);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
    const work = async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        // sent 表示请求已经写进 daemon：此后失败属于“结果未知”，
        // 再重试或回退会让同一段音频被算两三次，所以只允许在发送前重试。
        let sent = false;
        try {
          if (stopped) throw stopped;
          const ready = await getDaemon();
          if (stopped) throw stopped;
          state = ready;
          // resetDaemon 可能正好发生在 getDaemon 的 await 期间：此时进程已被丢弃，
          // 再写 stdin 会永远等不到回应（挂死），直接按“已重启”取消。
          if (state.closed) throw resetCancellation();
          refs(state, true);
          return await new Promise((resolve, reject) => {
            const id = ++nextId;
            const pending = { id, resolve, reject, sent: false };
            state.pending = pending;
            try {
              state.child.stdin.write(`${JSON.stringify({ id, wav: wavPath, model: model || state.runtime.model, language })}\n`);
              // 写入成功 = 请求可能已经被 daemon 执行；resetDaemon 必须保留这个标记。
              pending.sent = true;
              sent = true;
              sentFlag = true;
            } catch (error) { discard(state, transportError(error.message)); }
          });
        } catch (error) {
          if (stopped) throw stopped;
          if (!error.data?.daemonFallback) throw error;
          // 已发送的请求不重放：包成不可回退的错误，让上层直接如实上报。
          // submitted=true 也告诉上游“这段音频可能已经真的被算过”，退款要谨慎。
          if (sent) {
            throw new BiliError('UPSTREAM_ERROR', `${error.message}（请求已提交，结果未知，不重放）`, {
              data: { submitted: true },
            });
          }
          if (attempt === 1) throw error;
        } finally {
          if (state && daemon === state) refs(state, false);
        }
      }
    };
    try { return await Promise.race([work(), cancellation]); }
    finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  function transcribeViaDaemon(options = {}) {
    const { signal } = options;
    // A queued cancellation removes only this caller; it must not kill another caller's work.
    let abort;
    const cancelled = new Promise((_, reject) => {
      abort = () => reject(new BiliError('CANCELLED', 'ASR 已被取消'));
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
    const job = tail.then(() => {
      signal?.removeEventListener('abort', abort);
      if (signal?.aborted) throw new BiliError('CANCELLED', 'ASR 已被取消');
      return execute(options);
    });
    tail = job.catch(() => {});
    return Promise.race([job, cancelled]).finally(() => signal?.removeEventListener('abort', abort));
  }

  /**
   * 丢弃当前 daemon（含启动中的那一个）：杀子进程、清状态，并结束在途请求，
   * 下一次 transcribe 会用最新的 asrPython/asrModelDir 重新 spawn。
   * 在途请求：已写进 stdin 的标 data.submitted=true（可能真的被算过，不能退款）；
   * 尚未写入的保持可退款。
   * 只影响常驻进程；asr.mjs 的运行时缓存由 resetAsrCache 单独负责。
   */
  function resetDaemon() {
    generation += 1;
    starting = undefined;
    const state = daemon;
    daemon = undefined;
    if (state) discard(state, resetCancellation(state.pending?.sent === true));
  }

  return { getDaemon, transcribeViaDaemon, resetDaemon };
}

const client = createAsrClient();
export const getDaemon = client.getDaemon;
export const transcribeViaDaemon = client.transcribeViaDaemon;
/** 设置页改了 ASR 运行路径后调用：丢弃常驻 daemon，下次转写重新启动。 */
export const resetDaemon = client.resetDaemon;
