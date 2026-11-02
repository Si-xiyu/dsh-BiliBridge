import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeWritable, trustedRequest } from '../../lib/media/settings-merge.mjs';
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
test('loopback 与来源检查分支',()=>{
 for(const remoteAddress of ['',undefined,'127.0.0.1','::1','::ffff:127.0.0.1']) assert.equal(trustedRequest({socket:{remoteAddress}}),true);
 assert.equal(trustedRequest({socket:{remoteAddress:'10.0.0.1'}}),false);
 for(const headers of [{host:'localhost:12'},{host:'localhost:12',origin:'http://localhost:12'},{host:'localhost:12',referer:'http://localhost:12/a'},{origin:'invalid'}]) assert.equal(trustedRequest({headers}),true);
 for(const headers of [{host:'localhost',origin:'null'},{host:'localhost',origin:'http://evil'},{host:'localhost',referer:'bad'},{host:'localhost',origin:'http://localhost',referer:'http://evil'}]) assert.equal(trustedRequest({headers}),false);
});
