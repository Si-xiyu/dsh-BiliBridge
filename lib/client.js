/**
 * 客户端半边：DSH「设置」里的「B站工具」section。
 *
 * 机制与 dsh-bili-whale 相同：宿主用 `window.__ModuleLoader__.load` 加载这个 bundle，
 * 只提供 `react`，没有打包链；样式用内联 <style> + 宿主 CSS 变量跟随主题。
 *
 * 数据一律走同源 HTTP（/bilibili-bridge/api/*），本文件不读文件、不碰凭据。
 * P1 是只读仪表盘：账号 / 运行时 / 预算 / 缓存，右上角刷新。
 */
window.__ModuleLoader__.load({
  id: 'dsh-bilibili-bridge',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const React = require('react');
    const { createElement: h, useCallback, useEffect, useState } = React;

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
      '.blb-btn:disabled{opacity:.5;cursor:default}',
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

      return renderDashboard({ data, error, loading, refresh });
    }

    /**
     * 纯渲染：不碰 hooks、不读状态，方便单测直接检查“失败要显示错误、空预算要显示空态”。
     * Section 只负责取数与状态，渲染逻辑全在这里。
     */
    function renderDashboard({ data, error, loading, refresh }) {
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
          '只读仪表盘：账号、运行时、预算与缓存。配置与工具共用 ~/.dsh/bilibili/config.json，本页不展示凭据内容。'),
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
              ]) : null,

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
              ]) : null,

        data ? h('div', { className: 'blb-hint' },
          `生成于 ${formatTime(data.generatedAt)}`) : null);
    }

    /**
     * 客户端注入必须声明 slots：宿主只把 ctx.slots 注入给声明了它的插件。
     */
    const inject = ['slots'];

    function apply(ctx) {
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'bilibili-bridge',
        order: 200,
        label: () => 'B站工具',
      }, Section));
    }

    exports.name = 'dsh-bilibili-bridge';
    exports.inject = inject;
    exports.apply = apply;
    exports.Section = Section;
    exports.renderDashboard = renderDashboard;
    return module.exports;
  },
});
