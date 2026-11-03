/**
 * 客户端半边：DSH「设置」里的「B站工具」section。
 *
 * 机制与 dsh-bili-whale 相同：宿主用 `window.__ModuleLoader__.load` 加载这个 bundle，
 * 只提供 `react`，没有打包链；样式用内联 <style> + 宿主 CSS 变量跟随主题。
 *
 * 数据一律走同源 HTTP（/bilibili-bridge/api/*），本文件不读文件、不碰凭据。
 * 仪表盘展示运行状态；设置副本仅在保存时写回共用配置。
 */
window.__ModuleLoader__.load({
  id: 'dsh-bilibili-bridge',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const React = require('react');
    const { createElement: h, useCallback, useEffect, useRef, useState } = React;

    const API = '/bilibili-bridge/api';
    const CSS_ID = 'dsh-bilibili-bridge/section.css';
    const CSS = [
      '.blb{max-width:760px;display:flex;flex-direction:column;gap:6px;color:var(--dsw-alias-label-primary)}',
      '.blb-head{display:flex;align-items:center;justify-content:space-between;gap:12px}',
      '.blb-title{margin:0;font-size:16px;font-weight:500;line-height:24px}',
      '.blb-intro{margin:0 0 4px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary)}',
      '.blb-group{margin-top:14px;font-size:13px;font-weight:600;line-height:20px}',
      '.blb-rows{display:flex;flex-direction:column}',
      '.blb-row{display:flex;justify-content:space-between;align-items:flex-start;gap:12px 20px;',
      'padding:10px 0;border-bottom:.5px solid var(--dsw-alias-border-l2);flex-wrap:wrap}',
      '.blb-row:last-child{border-bottom:none}',
      '.blb-row>div:first-child{flex:1;min-width:190px}',
      '.blb-label{font-size:13px;line-height:19px}',
      '.blb-value{font-size:12.5px;line-height:19px;word-break:break-all;text-align:right}',
      '.blb-hint{margin-top:3px;font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-tertiary)}',
      '.blb-btn{border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:transparent;',
      'color:var(--dsw-alias-label-primary);height:28px;padding:0 12px;cursor:pointer;font-size:12.5px}',
      '.blb-input{width:120px;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:4px 8px;background:var(--dsw-alias-background-primary);color:var(--dsw-alias-label-primary)}',
      '.blb-switch{accent-color:var(--dsw-alias-brand-primary)}',
      '.blb-btn:disabled{opacity:.5;cursor:default}',
      '.blb-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:8px 0 4px}',
      '.blb-avatar{width:40px;height:40px;border-radius:50%;object-fit:cover;background:rgba(127,127,127,.14)}',
      '.blb-err{margin-top:8px;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary)}',
      '.blb-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px}',
    ].join('');

    function useStyleOnce() {
      useEffect(() => {
        if (typeof document === 'undefined') return;
        if (document.getElementById(CSS_ID)) return;
        const el = document.createElement('style');
        el.id = CSS_ID;
        el.textContent = CSS;
        document.head.appendChild(el);
      }, []);
    }

    function Row({ label, hint, children }) {
      return h('div', { className: 'blb-row' },
        h('div', null,
          h('div', { className: 'blb-label' }, label),
          hint ? h('div', { className: 'blb-hint' }, hint) : null),
        h('div', { className: 'blb-value' }, children ?? null));
    }

    /** 分区级错误：不能把“读取失败”画成空数据，否则用户分不清“没有”和“坏了”。 */
    function failure(value) {
      if (!value || value.ok !== false) return null;
      return `读取失败（${value.code || 'UNKNOWN'}）`;
    }

    function Group({ title, children }) {
      return h('div', null,
        h('div', { className: 'blb-group' }, title),
        h('div', { className: 'blb-rows' }, children));
    }

    function formatBytes(bytes) {
      if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
      const units = ['B', 'KB', 'MB', 'GB'];
      let value = bytes;
      let unit = 0;
      while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
      return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
    }

    function formatTime(iso) {
      try { return new Date(iso).toLocaleString(); } catch { return String(iso); }
    }

    const fields = [
      ['budget','roundsLimit',"轮次上限",6,1,50],
      ['budget','audioSecondsLimit',"音频额度（秒）",900,60,7200],
      ['budget','ttlMs',"账本 TTL（小时）",2,1,24,3600000],
      ['cache','enabled',"启用缓存",true],
      ['cache','ttlMs',"缓存保留（天）",30,1,90,86400000],
      ['asr','enabled',"启用 ASR",true],
      ['asr','model',"ASR 模型",'small'],
      ['asr','defaultWindowSeconds',"默认窗口（秒）",30,10,120],
      ['asr','maxWindowSeconds',"单次上限（秒）",300,30,600],
      ['ocr','enabled',"启用 OCR",true],
      ['dev','enabled','开发者模式',false],
    ];
    function formValues(config) {
      return Object.fromEntries(fields.map(([section,key,,fallback,,,unit]) =>
        [section+'.'+key, config[section]?.[key] === undefined
          ? (key === 'model' ? config.asrModel ?? fallback : fallback)
          : unit ? config[section][key]/unit : config[section][key]]));
    }
    function SettingsForm() {
      const [draft, setDraft] = useState(null);
      const [saved, setSaved] = useState(null);
      const [revision, setRevision] = useState(null);
      const [errors, setErrors] = useState([]);
      const [message, setMessage] = useState('');
      const [busy, setBusy] = useState(false);
      const timer = useRef(null);
      // 待提交的改动：多个字段共用一个定时器，但**累积**成一个 patch，
      // 否则 500ms 内改 A 再改 B，A 的改动会被取消、页面却显示已保存。
      const pending = useRef({});

      const applyPayload = useCallback((payload) => {
        const values = formValues(payload.config);
        setDraft(values);
        setSaved(values);
        setRevision(payload.revision ?? null);
      }, []);

      const load = useCallback(async () => {
        try {
          const response = await fetch(API + '/settings');
          const result = await response.json().catch(() => ({}));
          if (!response.ok || !result.ok) throw new Error(result.error || '读取设置失败');
          applyPayload(result);
          setErrors([]);
        } catch (error) {
          setErrors([String(error.message || error)]);
        }
      }, [applyPayload]);

      useEffect(() => { load(); }, [load]);
      // 卸载时清掉未触发的自动保存定时器
      useEffect(() => () => clearTimeout(timer.current), []);

      const post = useCallback(async (url, patch) => {
        setBusy(true);
        try {
          const response = await fetch(API + url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ...patch, ...(revision ? { revision } : {}) }),
          });
          const result = await response.json().catch(() => ({}));
          if (response.status === 409 && result.error === 'STALE_REVISION') {
            await load();
            setMessage('设置已在别处修改，已重新加载');
            return;
          }
          if (!response.ok || !result.ok) { setErrors(result.errors || [result.error || '保存失败']); return; }
          applyPayload(result);
          setErrors([]);
          // 开发者开关变化时通知浮层/日志区，避免它们等到下一次 focus 才刷新。
          if (patch?.dev && Object.hasOwn(patch.dev, 'enabled')) {
            window.dispatchEvent(new CustomEvent('blb-dev-enabled', { detail: patch.dev.enabled === true }));
          }
          setMessage(url === '/settings/reset' ? '已恢复默认' : '已保存');
        } catch (error) {
          setErrors([String(error.message || error)]);
        } finally {
          setBusy(false);
        }
      }, [applyPayload, load, revision]);

      // 改完就存：输入停顿 500ms 后提交**这一个字段**，不再让用户点保存。
      const autosave = useCallback((section, key, value) => {
        setMessage('');
        pending.current[section] = { ...(pending.current[section] ?? {}), [key]: value };
        clearTimeout(timer.current);
        timer.current = setTimeout(() => {
          const patch = pending.current;
          pending.current = {};
          post('/settings', patch);
        }, 500);
      }, [post]);

      const reset = () => { clearTimeout(timer.current); pending.current = {}; post('/settings/reset', {}); };

      return h('div', null, h(Group, { title: '设置' },
        !draft ? h('div', { className: 'blb-hint' }, '加载设置中…') : fields.map(([section, key, label, fallback, min, max, unit]) => {
          const name = section + '.' + key;
          const value = draft[name];
          const onChange = (event) => {
            const raw = typeof fallback === 'boolean' ? event.target.checked : event.target.value;
            // 数字字段统一存 number，避免 6 → "7" → 6 这种字符串/数字混比。
            const normalized = typeof fallback === 'boolean' || key === 'model' || raw === '' ? raw : Number(raw);
            setDraft((prev) => ({ ...prev, [name]: normalized }));
            autosave(section, key, unit ? (normalized === '' ? null : Number(normalized) * unit) : normalized);
          };
          const props = {
            className: typeof fallback === 'boolean' ? 'blb-switch' : 'blb-input',
            'aria-label': label,
            disabled: busy,
            onChange,
          };
          const control = h(Row, { key: name, label }, key === 'model'
            ? h('select', { ...props, value }, ['tiny', 'base', 'small', 'medium'].map((model) => h('option', { key: model, value: model }, model)))
            : h('input', {
                ...props,
                type: typeof fallback === 'boolean' ? 'checkbox' : 'number',
                // 带单位的字段不设 min/max：已存值可能不是整单位，设了会拦住保存别的字段。
                ...(typeof fallback === 'boolean' ? { checked: value } : (unit ? { value, step: 'any' } : { value, min, max, step: 1 })),
              }));
          const heading = name === 'budget.roundsLimit' ? '预算' : name === 'cache.enabled' ? '缓存' : name === 'asr.enabled' ? '视频理解' : name === 'dev.enabled' ? '开发者' : null;
          return h(React.Fragment, { key: name }, heading ? h('div', { className: 'blb-group' }, heading) : null, control);
        })),
        ...errors.map((error, index) => h('div', { key: index, className: 'blb-err', role: 'alert' }, error)),
        h('p', { className: 'blb-hint', role: 'status' }, busy ? '保存中…' : message),
        h('div', { className: 'blb-actions' },
          h('button', { className: 'blb-btn', type: 'button', onClick: reset, disabled: !draft || busy }, '恢复默认')));
    }
    function AccountActions({ refresh }) {
      const [qr, setQr] = useState(null);
      const [message, setMessage] = useState('');
      const [busy, setBusy] = useState(false);
      useEffect(() => {
        if (!qr) return;
        let stopped = false;
        let timer;
        const poll = async () => {
          try {
            const result = await post('/account/qr/poll', { id: qr.id });
            if (stopped) return;
            if (result.status === 'confirmed') { setQr(null); setMessage('已登录'); refresh(); return; }
            if (result.status === 'expired') { setQr(null); setMessage('二维码已过期，请重新扫码'); return; }
            setMessage(result.status === 'scanned' ? '已扫码，请在 B站确认登录' : '请使用 B站 App 扫码');
            timer = setTimeout(poll, 2000);
          } catch { if (!stopped) { setQr(null); setMessage('扫码查询失败，请重新扫码'); } }
        };
        timer = setTimeout(poll, 2000);
        // 卸载、取消或换码后停止轮询，也忽略已在途的响应。
        return () => { stopped = true; clearTimeout(timer); };
      }, [qr, refresh]);
      async function start() {
        setBusy(true); setQr(null); setMessage('正在生成二维码…');
        try { setQr(await post('/account/qr/start')); setMessage('请使用 B站 App 扫码'); }
        catch { setMessage('二维码生成失败，请重试'); }
        finally { setBusy(false); }
      }
      async function logout() {
        if (!window.confirm('确定退出登录并清除本地凭据？')) return;
        setBusy(true); setQr(null);
        try { await post('/account/logout'); setMessage('已退出登录'); await refresh(); }
        catch { setMessage('退出登录失败，请重试'); }
        finally { setBusy(false); }
      }
      return h('div', null,
        h('button', { className: 'blb-btn', disabled: busy, onClick: logout }, '退出登录'),
        h('button', { className: 'blb-btn', disabled: busy, onClick: start }, '重新扫码'),
        qr ? h('div', null, h('img', { className: 'blb-qr', src: qr.image, alt: 'B站登录二维码', width: 180, height: 180 }),
          h('button', { className: 'blb-btn', onClick: () => { setQr(null); setMessage('已取消扫码'); } }, '取消扫码')) : null,
        h('p', { className: 'blb-hint', role: 'status' }, message));
    }

    function CacheActions({ refresh }) {
      const [scope, setScope] = useState('asr');
      const [busy, setBusy] = useState(false);
      const [message, setMessage] = useState('');
      async function clear() {
        setBusy(true);
        try {
          const result = await post('/cache/clear', { scope });
          setMessage(`已清理 ${formatBytes(result.freedBytes)}（${result.freedBytes} 字节），跳过 ${result.skipped} 个文件`);
          await refresh();
        } catch { setMessage('清理缓存失败，请重试'); }
        finally { setBusy(false); }
      }
      return h('div', null,
        h('select', { className: 'blb-input', value: scope, disabled: busy, 'aria-label': '清理范围', onChange: e => setScope(e.target.value) },
          ...[['asr', 'ASR'], ['media', '画面'], ['all', '全部']].map(([value, label]) => h('option', { key: value, value }, label))),
        h('button', { className: 'blb-btn', disabled: busy, onClick: clear }, busy ? '清理中…' : '清理缓存'),
        h('p', { className: 'blb-hint', role: 'status' }, message));
    }

    function History({ version }) {
      const [items, setItems] = useState([]);
      const [error, setError] = useState('');
      useEffect(() => {
        let stopped = false;
        fetch(API + '/history?limit=20').then(async response => {
          const result = await response.json();
          if (!response.ok || !result.ok) throw new Error();
          if (!stopped) { setItems(result.items); setError(''); }
        }).catch(() => { if (!stopped) setError('读取调用记录失败'); });
        return () => { stopped = true; };
      }, [version]);
      return h(Group, { title: '最近调用' }, error ? h('p', { className: 'blb-err' }, error)
        : items.length ? items.map((item, index) => h('div', { key: index, className: 'blb-row' },
          `${formatTime(item.at)} · ${item.tool} · ${item.bvid || '—'} · ${item.elapsedMs} ms · ${item.cacheHit ? '缓存命中' : '未命中'}${item.ok ? '' : ' · 失败'}`))
        : h('p', { className: 'blb-hint' }, '（暂无调用记录）'));
    }


    function useDevItems(enabled, limit, session) {
      const [items, setItems] = useState([]);
      const [error, setError] = useState('');
      useEffect(() => {
        if (!enabled) { setItems([]); return; }
        let stopped = false, timer;
        const poll = async () => {
          let next = true;
          try {
            const scoped = session ? '&session=' + encodeURIComponent(session) : '';
            const response = await fetch(API + '/dev/log?limit=' + limit + scoped);
            const result = await response.json();
            if (!response.ok || !result.ok) throw new Error();
            if (!stopped) {
              setItems(result.enabled ? result.items : []); setError('');
              if (!result.enabled) {
                // 服务端说已经关了：这一轮就停止轮询，否则页面会每 2 秒白跑一次。
                next = false;
                window.dispatchEvent(new CustomEvent('blb-dev-enabled', { detail: false }));
              }
            }
          } catch { if (!stopped) setError('读取开发日志失败'); }
          if (!stopped && next) timer = setTimeout(poll, 2000);
        };
        poll();
        return () => { stopped = true; clearTimeout(timer); };
      }, [enabled, limit, session]);
      return { items, setItems, error, setError };
    }
    function DevEntries({ items, compact = false }) {
      return items.map(item => h('details', { key: item.id },
        h('summary', { className: 'blb-label', style: { cursor: 'pointer', padding: '6px 0' } },
          [formatTime(item.at), item.tool, ...(!compact ? [item.args?.bvid || '—'] : []), item.durationMs.toFixed(1) + ' ms', item.ok ? 'ok' : item.errorCode || '失败', ...(!compact ? [formatBytes(item.resultBytes)] : [])].join(' · ')),
        h('pre', { className: 'blb-mono', style: { overflow: 'auto', maxHeight: 240, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } },
          '参数\n' + JSON.stringify(item.args, null, 2) + '\n结果预览\n' + item.resultPreview + (item.truncated ? '\n（已截断）' : ''))));
    }
    /** 读取「开发者模式是否开启」：设置保存后会派发事件，这里即时跟进。 */
    function useDevEnabled() {
      const [enabled, setEnabled] = useState(false);
      useEffect(() => {
        let stopped = false;
        const read = async () => {
          try {
            const response = await fetch(API + '/settings');
            const result = await response.json();
            if (!stopped && response.ok && result.ok) setEnabled(result.config?.dev?.enabled === true);
          } catch {}
        };
        const changed = (event) => setEnabled(event.detail === true);
        read();
        window.addEventListener('blb-dev-enabled', changed);
        window.addEventListener('focus', read);
        return () => {
          stopped = true;
          window.removeEventListener('blb-dev-enabled', changed);
          window.removeEventListener('focus', read);
        };
      }, []);
      return enabled;
    }

    function DevLog() {
      const enabled = useDevEnabled();
      const { items, setItems, error, setError } = useDevItems(enabled, 50);
      const clear = async () => {
        try {
          await fetch(API + '/dev/clear', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
          setItems([]);
          setError('');
        } catch { setError('清空失败'); }
      };
      return h(Group, { title: '最近调用' }, !enabled
        ? h('p', { className: 'blb-hint' }, '开发者模式已关闭，不记录调用。打开开关后立即生效。')
        : h('div', null,
          h(Row, { label: '工具调用' }, h('button', { type: 'button', className: 'blb-btn', onClick: clear }, '清空')),
          error ? h('p', { className: 'blb-err' }, error) : null,
          items.length ? h(DevEntries, { items }) : h('p', { className: 'blb-hint' }, '（暂无调用记录：先调一次 bilibili_* 工具）')));
    }

    /**
     * 侧边栏图标：只画线条、用 currentColor，颜色交给宿主的选中态。
     */
    function DevIcon({ size = 16 }) {
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 16 16',
        fill: 'none',
        'aria-hidden': 'true',
      },
      h('path', {
        d: 'M2 3.5h12M2 8h8M2 12.5h10',
        stroke: 'currentColor',
        strokeWidth: 1.4,
        strokeLinecap: 'round',
      }));
    }

    /**
     * 右侧 dock 的「B站调试」面板：只显示**本会话**的工具调用。
     *
     * 会话 id 来自宿主（props.sessionId / tab），与 devlog 记录里的写法可能差一个
     * `session-` 前缀，所以两边都归一化后再比。
     */
    function DevTab(props = {}) {
      useStyleOnce();
      const useTabInfo = props.useTabInfo;
      const tabInfo = typeof useTabInfo === 'function' ? useTabInfo() : null;
      const tab = tabInfo?.tab ?? null;
      const visible = tab ? tab.visible !== false : true;
      const sessionId = props.sessionId ?? tab?.sessionId ?? null;
      const enabled = useDevEnabled();
      const [paused, setPaused] = useState(false);
      const [query, setQuery] = useState('');
      const [onlyFailed, setOnlyFailed] = useState(false);
      const [copied, setCopied] = useState('');
      const [expanded, setExpanded] = useState({});
      const { items, setItems, error, setError } = useDevItems(enabled && visible && !paused, 100);

      const normalize = (value) => String(value ?? '').replace(/^session-/, '').toLowerCase();
      const mine = sessionId ? items.filter((item) => normalize(item.sessionId) === normalize(sessionId)) : [];

      const filtered = mine.filter((item) => {
        if (onlyFailed && item.ok) return false;
        if (!query) return true;
        const haystack = `${item.tool} ${item.args?.bvid ?? ''} ${item.resultPreview ?? ''}`.toLowerCase();
        return haystack.includes(query.toLowerCase());
      });
      const failed = mine.filter((item) => item.ok === false).length;

      const clear = async () => {
        try {
          await fetch(API + '/dev/clear', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
          setItems([]);
          setError('');
        } catch { setError('清空失败'); }
      };

      const copy = async (item) => {
        try {
          await navigator.clipboard.writeText(JSON.stringify(item, null, 2));
          setCopied(String(item.id));
          setTimeout(() => setCopied(''), 1500);
        } catch { setError('复制失败（浏览器拒绝访问剪贴板）'); }
      };

      const toolbar = h('div', { className: 'blb-toolbar' },
        h('input', {
          className: 'blb-input',
          value: query,
          placeholder: '搜索工具 / bvid / 结果',
          'aria-label': '搜索调用记录',
          onChange: (event) => setQuery(event.target.value),
        }),
        h('label', { className: 'blb-hint' },
          h('input', { type: 'checkbox', checked: onlyFailed, onChange: (event) => setOnlyFailed(event.target.checked) }),
          ' 只看失败'),
        h('button', { className: 'blb-btn', type: 'button', onClick: () => setPaused((value) => !value) },
          paused ? '继续' : '暂停'),
        h('button', { className: 'blb-btn', type: 'button', onClick: clear }, '清空'));

      const rows = filtered.map((item) => {
        const key = String(item.id);
        const open = expanded[key] === true;
        return h('div', { key, className: 'blb-row blb-row-click' },
          h('div', {
            role: 'button',
            tabIndex: 0,
            'aria-expanded': open,
            onClick: () => setExpanded((prev) => ({ ...prev, [key]: !open })),
            onKeyDown: (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                setExpanded((prev) => ({ ...prev, [key]: !open }));
              }
            },
          },
          h('div', { className: 'blb-label' },
            `${open ? '▾' : '▸'} ${formatTime(item.at)} · ${item.tool} · ${item.ok ? 'ok' : (item.errorCode || '失败')} · ${Math.round(item.durationMs)} ms`),
          h('div', { className: 'blb-hint' },
            `${formatBytes(item.resultBytes)}${item.truncated ? '（已截断）' : ''} · ${JSON.stringify(item.args)}`)),
          // 展开内容与「复制」写入剪贴板的完全是同一份 JSON。
          open
            ? h('pre', { className: 'blb-mono', style: { overflow: 'auto', maxHeight: 320, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } },
                JSON.stringify(item, null, 2))
            : null,
          h('button', {
            className: 'blb-btn',
            type: 'button',
            onClick: (event) => { event.stopPropagation(); copy(item); },
          }, copied === key ? '已复制' : '复制'));
      });

      const body = !enabled
        ? h('p', { className: 'blb-hint' }, '开发者模式已关闭。到「设置 → B站工具 → 开发者」打开。')
        : (rows.length
            ? h('div', { className: 'blb-rows' }, rows)
            : h('p', { className: 'blb-hint' },
                sessionId
                  ? `本会话还没有调用记录（会话 ${String(sessionId).slice(0, 8)}…）。先让我调一次 bilibili_* 工具。`
                  : '这个面板没有拿到会话 id，无法按会话过滤。'));

      return h('div', { className: 'blb', style: { padding: '8px 10px' } },
        h('div', { className: 'blb-head' },
          h('h3', { className: 'blb-title' }, 'B站调试'),
          h('span', { className: 'blb-hint' },
            enabled ? `本会话 ${mine.length} 次 · ${failed} 失败` : '已关闭')),
        enabled ? toolbar : null,
        error ? h('p', { className: 'blb-err', role: 'alert' }, error) : null,
        body);
    }

    function Section() {
      useStyleOnce();
      const [data, setData] = useState(null);
      const [error, setError] = useState('');
      const [loading, setLoading] = useState(false);

      const refresh = useCallback(async () => {
        setLoading(true);
        try {
          const response = await fetch(`${API}/status`, { headers: { accept: 'application/json' } });
          const result = await response.json().catch(() => ({}));
          if (!response.ok || !result.ok) throw new Error(result.error || `HTTP ${response.status}`);
          setData(result);
          setError('');
        } catch (e) {
          setError(String(e.message || e));
        } finally {
          setLoading(false);
        }
      }, []);

      useEffect(() => { refresh(); }, [refresh]);

      return h('div', { className: 'blb' }, renderDashboard({ data, error, loading, refresh, actions: true }), h(SettingsForm), h(DevLog), h(History, { version: data }), h('p', { className: 'blb-hint' }, '右侧调试面板：' + rightTabStatus));
    }

    /**
     * 纯渲染：不碰 hooks、不读状态，方便单测直接检查“失败要显示错误、空预算要显示空态”。
     * Section 只负责取数与状态，渲染逻辑全在这里。
     */
    function renderDashboard({ data, error, loading, refresh, actions = false }) {
      const account = data?.account;
      const runtime = data?.runtime;
      const budget = data?.budget;
      const cache = data?.cache;
      // 兼容旧形状：早期版本 budget 直接是数组，P1 之后是 { ok, items }。
      // 只认新形状会让“旧后端 + 新页面”静默丢掉所有任务。
      const budgetItems = Array.isArray(budget) ? budget : (budget?.items ?? []);

      return h('div', { className: 'blb' },
        h('div', { className: 'blb-head' },
          h('h3', { className: 'blb-title' }, 'B站工具'),
          h('button', { className: 'blb-btn', onClick: refresh, disabled: loading },
            loading ? '刷新中…' : '刷新')),
        h('p', { className: 'blb-intro' },
          '账号、运行时、预算与缓存。配置与工具共用 ~/.dsh/bilibili/config.json，本页不展示凭据内容。'),
        loading && !data ? h('p', { className: 'blb-hint' }, '加载中…') : null,
        error ? h('div', { className: 'blb-err' }, `读取状态失败：${error}`) : null,

        data ? h(Group, { title: '账号' },
          failure(account)
            ? h(Row, { key: 'account', label: '状态' }, failure(account))
            : [
                h(Row, { key: 'avatar', label: '头像' },
                  h('img', { className: 'blb-avatar', src: `${API}/avatar`, alt: '头像', width: 40, height: 40 })),
                h(Row, { key: 'who', label: '昵称 / mid' },
                  account.loggedIn ? `${account.uname || '未知'} · ${account.accountId || '?'}` : '未登录'),
                h(Row, { key: 'level', label: '等级 / VIP' },
                  account.loggedIn ? `Lv ${account.level ?? '?'} · ${account.vip ? '大会员' : '非大会员'}` : '—'),
                h(Row, { key: 'cred', label: '凭据路径', hint: '只显示路径，不读取内容' },
                  h('span', { className: 'blb-mono' }, account.credentialsPath || '（未知）')),
              ], actions ? h(AccountActions, { refresh }) : null) : null,

        data ? h(Group, { title: '运行时' },
          h(Row, { key: 'ffmpeg', label: 'ffmpeg', hint: '抽帧用；不可用时会自动降级到故事板' },
            runtime.ffmpeg.ok
              ? h('span', { className: 'blb-mono' }, runtime.ffmpeg.ffmpeg || '可用')
              : failure(runtime.ffmpeg)),
          h(Row, { key: 'asr', label: 'ASR', hint: '本地 faster-whisper；模型变更后下一次转写会重新加载' },
            runtime.asr.ok
              ? h('span', { className: 'blb-mono' }, `${runtime.asr.python || '?'} · ${runtime.asr.model || '?'}`)
              : failure(runtime.asr)),
          h(Row, { key: 'ocr', label: 'OCR', hint: 'Windows 自带 OCR 引擎' },
            runtime.ocr.ok
              ? (runtime.ocr.available ? '可用' : `不可用（${runtime.ocr.platform || '?'}）`)
              : failure(runtime.ocr))) : null,

        data ? h(Group, { title: '预算' },
          budget.ok === false
            ? h(Row, { key: 'budget', label: '状态' }, failure(budget))
            : (budgetItems.length
                ? budgetItems.map((item) => h(Row, {
                    key: item.bundleId,
                    label: item.bvid || item.bundleId,
                    hint: `到 ${formatTime(item.expiresAt)} 过期`,
                  }, `${item.rounds}/${item.roundsLimit} 轮 · ${item.audioSecondsUsed}/${item.audioSecondsLimit} 秒`))
                : h(Row, { key: 'budget-empty', label: '当前任务' }, '（没有进行中的分析）'))) : null,

        data ? h(Group, { title: '缓存' },
          cache.ok === false
            ? h(Row, { key: 'cache', label: '状态' }, failure(cache))
            : [
                h(Row, { key: 'cache-total', label: '总计' },
                  `${cache.totalFiles} 个文件 · ${formatBytes(cache.totalBytes)}`),
                ...(cache.buckets ?? []).filter((bucket) => bucket.files > 0).map((bucket) => h(Row, {
                  key: `cache-${bucket.name}`,
                  label: bucket.name,
                }, `${bucket.files} 个 · ${formatBytes(bucket.bytes)}`)),
              ], actions ? h(CacheActions, { refresh }) : null) : null,

        data ? h('div', { className: 'blb-hint' },
          `生成于 ${formatTime(data.generatedAt)}`) : null);
    }

    /**
     * 客户端注入只强制声明 slots。
     *
     * 右侧栏服务（sidebarRightTabs）由 ui-sidebar-right 激活后 reflect.provide；
     * 直接访问未就绪的服务会抛错，而 **apply 抛错会被宿主判定为 failed → 整个 web boot 崩溃**。
     * 正确做法是 `ctx.inject([服务], cb)`：服务就绪才跑回调，未就绪时本插件只是 pending，
     * 不会失败（宿主源码：inject 缺服务 → kind:pending；apply 抛错 → kind:failed）。
     */
    const inject = ['slots'];
    const DEV_TAB_ID = 'dsh-bilibili-bridge/devtools';
    // 设置页会显示这一行的结果，方便确认右侧面板是否注册成功（无需看控制台）。
    let rightTabStatus = '等待右侧栏服务…';
    const DEV_TAB_KIND = 'bilibili-devtools';

    function registerRightTab(scope) {
      scope.sidebarRightTabs.register({
        id: DEV_TAB_ID,
        kind: DEV_TAB_KIND,
        title: () => 'B站调试',
        guide: [{
          id: 'devtools',
          order: 40,
          title: () => 'B站调试',
          description: () => '本会话的 B站工具调用与返回',
          icon: DevIcon,
        }],
      });
      scope.slots.inject('sidebar.right.pane.tab', () => scope.slots.register({
        name: 'sidebar.right.pane.tab',
        key: DEV_TAB_ID,
      }, DevTab));
    }

    function apply(ctx) {
      // 设置页最先注册：即使右侧栏不可用，常用功能也必须在。
      try {
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'bilibili-bridge',
          order: 200,
          label: () => 'B站工具',
        }, Section));
      } catch (error) {
        console.warn('[bilibili] settings.section 注册失败：', error?.message ?? error);
      }

      // 右侧调试 tab：等服务就绪再注册；apply 本身立即返回，不阻塞激活。
      try {
        if (typeof ctx.inject === 'function') {
          ctx.inject(['sidebarRightTabs'], (scope) => {
            try {
              registerRightTab(scope);
              rightTabStatus = '已注册';
            } catch (error) {
              rightTabStatus = '注册失败：' + (error?.message ?? error);
              console.warn('[bilibili] 右侧调试面板注册失败：', error?.message ?? error);
            }
          });
        } else {
          rightTabStatus = '宿主未提供 ctx.inject';
        }
      } catch (error) {
        console.warn('[bilibili] 右侧调试面板注入失败：', error?.message ?? error);
      }
    }
    exports.name = 'dsh-bilibili-bridge';
    exports.inject = inject;
    exports.apply = apply;
    exports.Section = Section;
    exports.renderDashboard = renderDashboard;
    exports.SettingsForm = SettingsForm;
    exports.History = History;
    exports.DevTab = DevTab;
    exports.DevIcon = DevIcon;
    return module.exports;
  },
});
