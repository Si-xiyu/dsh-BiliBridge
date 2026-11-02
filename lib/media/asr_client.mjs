import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BiliError } from '../bili/errors.mjs';

const DAEMON = fileURLToPath(new URL('./asr_daemon.py', import.meta.url));
const transportError = (message) => new BiliError('UPSTREAM_ERROR', message, { data: { daemonFallback: true } });
const allowedCodes = new Set(['INVALID_ARGUMENT', 'DEPENDENCY_MISSING', 'UPSTREAM_ERROR', 'TIMEOUT', 'CANCELLED']);

/** Injectable process factory keeps the state machine testable without Python. */
export function createAsrClient({ spawnProcess = spawn, resolveRuntime = async () => (await import('./asr.mjs')).resolveAsr() } = {}) {
  let daemon;
  let starting;
  let nextId = 0;
  let tail = Promise.resolve();

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
    starting = startDaemon();
    try { return await starting; }
    finally { starting = undefined; }
  }

  async function startDaemon() {
    const runtime = await resolveRuntime();
    let child;
    try {
      child = spawnProcess(runtime.python, [DAEMON, '--model-dir', runtime.modelDir], {
        stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      });
    } catch (error) { throw transportError(`无法启动 ASR daemon: ${error.message}`); }
    const state = { child, runtime, buffer: '', pending: undefined };
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
    const cancellation = new Promise((_, reject) => {
      const stop = (code, message) => {
        stopped = new BiliError(code, message);
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
        try {
          if (stopped) throw stopped;
          const ready = await getDaemon();
          if (stopped) throw stopped;
          state = ready;
          refs(state, true);
          return await new Promise((resolve, reject) => {
            const id = ++nextId;
            state.pending = { id, resolve, reject };
            try {
              state.child.stdin.write(`${JSON.stringify({ id, wav: wavPath, model: model || state.runtime.model, language })}\n`);
            } catch (error) { discard(state, transportError(error.message)); }
          });
        } catch (error) {
          if (stopped || !error.data?.daemonFallback || attempt === 1) throw stopped || error;
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

  return { getDaemon, transcribeViaDaemon };
}

const client = createAsrClient();
export const getDaemon = client.getDaemon;
export const transcribeViaDaemon = client.transcribeViaDaemon;
