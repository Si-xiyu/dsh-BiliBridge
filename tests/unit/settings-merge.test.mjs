import test from 'node:test';
import assert from 'node:assert/strict';
import { explainTrust, mergeWritable, trustedRequest } from '../../lib/media/settings-merge.mjs';

test('取数与自适应开关严格接受 boolean，非法值整份回滚并保留未知字段', () => {
  for (const [section, key] of [['extract', 'subtitles'], ['extract', 'comments'], ['extract', 'danmaku'], ['extract', 'frames'], ['adaptive', 'adaptiveEnabled']]) {
    const current = { note: 'keep', [section]: { [key]: true, unknown: 'keep' }, budget: { roundsLimit: 6 } };
    for (const value of [true, false]) {
      const result = mergeWritable(current, { [section]: { [key]: value, unknown: 'ignored' } });
      assert.deepEqual(result.errors, []);
      assert.deepEqual(result.config, { ...current, [section]: { [key]: value, unknown: 'keep' } });
    }
    for (const value of ['true', 'false', 0, 1, null, undefined, [], {}]) {
      const result = mergeWritable(current, { budget: { roundsLimit: 7 }, [section]: { [key]: value } });
      assert.ok(result.errors.some(error => error.includes(section + '.' + key)));
      assert.deepEqual(result.config, current);
    }
    assert.equal(current[section][key], true);
    assert.equal(current.budget.roundsLimit, 6);
  }
  for (const patch of [{ extract: null }, { adaptive: [] }]) assert.ok(mergeWritable({}, patch).errors.length);
});
test('白名单合并保留未知字段且不修改输入',()=>{
 const current={ffmpegPath:'x',ffmpegCaFile:'y',note:'keep',budget:{roundsLimit:6,note:'nested'}};
 const result=mergeWritable(current,{budget:{roundsLimit:7,note:'ignored'},ffmpegPath:'ignored',unknown:1});
 assert.deepEqual(result,{config:{...current,budget:{roundsLimit:7,note:'nested'}},errors:[]});
 assert.equal(current.budget.roundsLimit,6);
});
test('严格类型、非法段与整份回滚',()=>{
 for(const patch of [null,[],{budget:'x'},{cache:null},{asr:[]},{budget:{roundsLimit:'6'}},{cache:{enabled:1}},{asr:{enabled:'true'}},{asr:{model:'large'}},{ocr:{enabled:null}}]){
 const current={note:'keep'}; const result=mergeWritable(current,patch);
 assert.ok(result.errors.length); assert.deepEqual(result.config,current);
 }
 assert.deepEqual(mergeWritable({}, {budget:{roundsLimit:2,audioSecondsLimit:1}}).config,{});
});
test('范围边界与越界',()=>{
 for(const [section,key,min,max] of [['budget','roundsLimit',1,50],['budget','audioSecondsLimit',60,7200],['budget','ttlMs',60000,86400000],['cache','ttlMs',86400000,7776000000],['asr','defaultWindowSeconds',10,120],['asr','maxWindowSeconds',30,600]]){
 for(const value of [min,max]) assert.deepEqual(mergeWritable({}, {[section]:{[key]:value}}).errors,[]);
 for(const value of [min-1,max+1,min+0.5,'6',null]) assert.ok(mergeWritable({}, {[section]:{[key]:value}}).errors.length);
 }
});
test('合并后的窗口关系与默认值',()=>{
 assert.ok(mergeWritable({asr:{maxWindowSeconds:40}},{asr:{defaultWindowSeconds:50}}).errors.length);
 assert.ok(mergeWritable({asr:{defaultWindowSeconds:90}},{asr:{maxWindowSeconds:60}}).errors.length);
 assert.deepEqual(mergeWritable({asr:{defaultWindowSeconds:90}},{asr:{defaultWindowSeconds:60,maxWindowSeconds:60}}).errors,[]);
 assert.deepEqual(mergeWritable({}, {asr:{defaultWindowSeconds:120}}).errors,[]);
});
test('runtime 段：四个运行路径可写，trim / 空串 / 类型与长度校验', () => {
  const current = { note: 'keep', ffmpegPath: 'legacy/ffmpeg', asrPython: 'legacy/python', budget: { roundsLimit: 6, unknown: 'keep' }, runtime: { unknown: 'keep' } };
  const result = mergeWritable(current, { runtime: { ffmpegPath: '  C:\\tools\\ffmpeg.exe  ', ffmpegCaFile: '  /etc/ssl/ca.pem  ', asrPython: ' /opt/py ', asrModelDir: '' } });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.config.runtime, {
    unknown: 'keep', ffmpegPath: 'C:\\tools\\ffmpeg.exe', ffmpegCaFile: '/etc/ssl/ca.pem', asrPython: '/opt/py', asrModelDir: '',
  });
  // 旧版平铺键和无关段原样保留（runtime 不是把它们搬走，而是并行存在）
  assert.equal(result.config.ffmpegPath, 'legacy/ffmpeg');
  assert.equal(result.config.asrPython, 'legacy/python');
  assert.equal(result.config.note, 'keep');
  assert.deepEqual(result.config.budget, { roundsLimit: 6, unknown: 'keep' });
  assert.deepEqual(current.runtime, { unknown: 'keep' }, '不修改输入');

  // 4096 可接受，4097 拒绝（按 trim 后长度）
  const max = 'a'.repeat(4096);
  assert.equal(mergeWritable({}, { runtime: { asrPython: max } }).config.runtime.asrPython, max);
  for (const value of ['a'.repeat(4097), 1, null, undefined, true, [], {}, ['/x']]) {
    const bad = mergeWritable({ runtime: { unknown: 'keep' } }, { runtime: { asrPython: value } });
    assert.deepEqual(bad.errors, ['runtime.asrPython: 必须是不超过 4096 字符的字符串'], String(value));
    assert.deepEqual(bad.config, { runtime: { unknown: 'keep' } }, '整份回滚');
  }
  // 控制字符（\t \n \x00 \x7f）一律拒绝，不做静默清洗
  for (const value of ['a\u0000b', 'a\nb', 'a\tb', 'a\u007fb', '\u001b']) {
    const bad = mergeWritable({}, { runtime: { asrPython: value } });
    assert.deepEqual(bad.errors, ['runtime.asrPython: 不能包含控制字符'], JSON.stringify(value));
  }
  // 空串是合法值：保留键本身（等于“自动/缺省”，解析层不回落到旧键）
  assert.deepEqual(mergeWritable({}, { runtime: { ffmpegPath: '  ' } }).config.runtime, { ffmpegPath: '' });

  // 只改其它段时 runtime 与顶层旧键都不受影响
  const unrelated = mergeWritable({ note: 'keep', ffmpegPath: 'legacy', runtime: { asrPython: '/opt/py' } }, { budget: { roundsLimit: 7 } });
  assert.deepEqual(unrelated.config.runtime, { asrPython: '/opt/py' });
  assert.equal(unrelated.config.ffmpegPath, 'legacy');
  assert.deepEqual(mergeWritable({}, { runtime: 'x' }).errors, ['runtime: 必须是对象']);
});
test('loopback 与来源检查分支（宽松但仍是 fail closed）', () => {
  const ok = (headers, remote = '127.0.0.1') => trustedRequest({ socket: { remoteAddress: remote }, headers });
  // 同机：localhost 与 127.0.0.1 互通、端口差异不影响
  assert.equal(ok({ host: 'localhost:12', origin: 'http://localhost:12' }), true);
  assert.equal(ok({ host: '127.0.0.1:12', origin: 'http://localhost:12' }), true);
  // 同机不同端口必须拒绝：否则另一个端口上的页面可以跨站表单写配置
  assert.equal(ok({ host: 'localhost:12', origin: 'http://localhost:99' }), false);
  assert.equal(ok({ host: '127.0.0.1:12', origin: 'http://127.0.0.1:12' }), true);
  // 同源 fetch 可能不带 Origin：没有跨站标记时放行
  assert.equal(ok({ host: 'localhost:12' }), true);
  // 以下必须拒绝
  for (const request of [
    { headers: { host: 'localhost:12', origin: 'http://localhost:12' } },                 // 缺远端
    { headers: { origin: 'http://localhost:12' }, socket: { remoteAddress: '127.0.0.1' } }, // 缺 Host
    { headers: { host: 'localhost:12', origin: 'http://evil' }, socket: { remoteAddress: '127.0.0.1' } },
    { headers: { host: 'evil.example', origin: 'http://evil.example' }, socket: { remoteAddress: '127.0.0.1' } },
    { headers: { host: 'localhost:12', 'sec-fetch-site': 'cross-site' }, socket: { remoteAddress: '127.0.0.1' } },
    { headers: { host: 'localhost:12', origin: 'http://localhost:12' }, socket: { remoteAddress: '10.0.0.1' } },
    { headers: { host: 'localhost:12', referer: 'bad' }, socket: { remoteAddress: '127.0.0.1' } },
  ]) assert.equal(trustedRequest(request), false, JSON.stringify(request));
});

test('拒绝原因可用于诊断（前端 403 里会带 reason）', () => {
  assert.equal(explainTrust({ socket: { remoteAddress: '10.0.0.1' }, headers: { host: 'localhost' } }).reason, 'remote-not-loopback');
  assert.equal(explainTrust({ socket: { remoteAddress: '127.0.0.1' }, headers: {} }).reason, 'host-missing');
  assert.equal(explainTrust({ socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'evil.example' } }).reason, 'host-not-loopback');
  assert.equal(explainTrust({ socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'localhost', origin: 'http://evil' } }).reason, 'origin-not-loopback');
});
