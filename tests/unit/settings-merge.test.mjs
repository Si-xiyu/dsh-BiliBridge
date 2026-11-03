import test from 'node:test';
import assert from 'node:assert/strict';
import { explainTrust, mergeWritable, trustedRequest } from '../../lib/media/settings-merge.mjs';
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
test('loopback 与来源检查分支（宽松但仍是 fail closed）', () => {
  const ok = (headers, remote = '127.0.0.1') => trustedRequest({ socket: { remoteAddress: remote }, headers });
  // 同机：localhost 与 127.0.0.1 互通、端口差异不影响
  assert.equal(ok({ host: 'localhost:12', origin: 'http://localhost:12' }), true);
  assert.equal(ok({ host: '127.0.0.1:12', origin: 'http://localhost:12' }), true);
  assert.equal(ok({ host: 'localhost:12', origin: 'http://localhost:99' }), true);
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