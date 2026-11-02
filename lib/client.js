/**
 * 客户端半边：DSH「设置」里的「B站工具」section。
 *
 * 机制与 dsh-bili-whale 相同（实机读过它的 lib/client.js）：
 * 宿主用 `window.__ModuleLoader__.load` 加载这个 bundle，只提供 `react`，
 * 没有打包链、没有 UI 组件库；样式用内联 <style> + 宿主 CSS 变量跟随主题。
 *
 * P0 只验证“标签页能出现”，所以这里不 fetch、不读文件。
 * 数据接口（/bilibili-bridge/api/*）在 P1 接入。
 */
window.__ModuleLoader__.load({
  id: 'dsh-bilibili-bridge',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const React = require('react');
    const { createElement: h, useEffect, useState } = React;

    const CSS_ID = 'dsh-bilibili-bridge/section.css';
    const CSS = [
      '.blb{max-width:760px;display:flex;flex-direction:column;gap:6px;color:var(--dsw-alias-label-primary)}',
      '.blb-title{margin:0;font-size:16px;font-weight:500;line-height:24px}',
      '.blb-intro{margin:0 0 4px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary)}',
      '.blb-group{margin-top:14px;font-size:13px;font-weight:600;line-height:20px}',
      '.blb-rows{display:flex;flex-direction:column}',
      '.blb-row{display:flex;justify-content:space-between;align-items:flex-start;gap:12px 20px;',
      'padding:10px 0;border-bottom:.5px solid var(--dsw-alias-border-l2);flex-wrap:wrap}',
      '.blb-row:last-child{border-bottom:none}',
      '.blb-label{font-size:13px;line-height:19px}',
      '.blb-hint{margin-top:3px;font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-tertiary)}',
      '.blb-badge{display:inline-block;margin-left:6px;padding:1px 7px;border-radius:999px;',
      'font-size:11px;line-height:16px;background:rgba(127,127,127,.14);color:var(--dsw-alias-label-secondary)}',
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

    function Row({ label, hint, badge, children }) {
      return h('div', { className: 'blb-row' },
        h('div', null,
          h('div', { className: 'blb-label' }, label, badge ? h('span', { className: 'blb-badge' }, badge) : null),
          hint ? h('div', { className: 'blb-hint' }, hint) : null),
        children ?? null);
    }


    function Section() {
      useStyleOnce();
      const [data, setData] = useState(null);
      const [loading, setLoading] = useState(false);
      const [error, setError] = useState('');
      async function refresh() {
        setLoading(true); setError('');
        try {
          const response = await fetch('/bilibili-bridge/api/status', { cache: 'no-store' });
          const result = await response.json();
          if (!response.ok || !result.ok) throw new Error(result.error || '????');
          setData(result);
        } catch (e) { setError('?????' + e.message); }
        finally { setLoading(false); }
      }
      useEffect(() => { refresh(); }, []);
      const row = (key, text) => h(Row, { key, label: text });
      const group = (title, rows) => h('div', { key: title },
        h('div', { className: 'blb-group' }, title), h('div', { className: 'blb-rows' }, rows));
      const runtime = value => value.ok ? '??' : value.code;
      const a = data?.account;
      return h('div', { className: 'blb' },
        h('div', { className: 'blb-row' }, h('h3', { className: 'blb-title' }, 'B???'),
          h('button', { onClick: refresh, disabled: loading }, '??')),
        loading ? h('p', { role: 'status' }, '?????') : null,
        error ? h('p', { role: 'alert' }, error) : null,
        data ? [
          group('??', [
            h('img', { key: 'avatar', src: '/bilibili-bridge/api/avatar', width: 40, height: 40, style: { borderRadius: '50%' }, alt: '????' }),
            row('account', (a.uname || '???') + ' ? ' + (a.accountId || '?') + ' ? Lv ' + (a.level ?? '?') + ' ? VIP ' + (a.vip ? '?' : '?')),
            row('path', '?????' + a.credentialsPath)]),
          group('???', [
            row('ffmpeg', 'ffmpeg?' + runtime(data.runtime.ffmpeg) + ' ? ' + (data.runtime.ffmpeg.ffmpeg || '')),
            row('asr', 'ASR?' + runtime(data.runtime.asr) + ' ? ' + [data.runtime.asr.python, data.runtime.asr.modelDir, data.runtime.asr.model].filter(Boolean).join(' ? ')),
            row('ocr', 'OCR?' + data.runtime.ocr.platform + ' ? ' + (data.runtime.ocr.available ? '??' : 'DEPENDENCY_MISSING'))]),
          group('??', data.budget.length ? data.budget.map(b => row(b.bundleId,
            b.bvid + ' ? ?? ' + b.rounds + '/' + b.roundsLimit + ' ? ' + b.audioSecondsUsed + '/' + b.audioSecondsLimit + ' ? ? ' + new Date(b.expiresAt).toLocaleString())) : [row('empty', '??????????')]),
          group('??', [row('total', '???' + data.cache.totalFiles + ' ?? ? ' + data.cache.totalBytes + ' ??'),
            ...data.cache.buckets.map(b => row(b.name, b.name + '?' + b.files + ' ?? ? ' + b.bytes + ' ??'))])
        ] : null);
    }

    /**
     * 客户端注入必须声明 slots：宿主只把 ctx.slots 注入给声明了它的插件。
     * 少了这一项，apply 里会拿不到 ctx.slots。
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
    return module.exports;
  },
});
