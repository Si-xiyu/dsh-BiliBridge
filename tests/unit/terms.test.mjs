import assert from 'node:assert/strict';
import test from 'node:test';
import { ASR_PROMPT_MAX_CHARS, asrHints, asrPrompt, domainTerms } from '../../lib/media/terms.mjs';

test('domainTerms：拉丁词、书名号、话题、UP 主名，去重且忽略链接', () => {
  const terms = domainTerms({
    title: '【Git 教程】用 rebase 整理提交 | C++ 与 Vue3',
    desc: '#版本控制# 代码见 https://github.com/x/y 《Pro Git》 git',
    owner: { name: '某UP主' },
  });
  assert.deepEqual(terms, ['Git 教程', 'Git', 'rebase', 'C++', 'Vue3', 'Pro Git', '版本控制', 'Pro', '某UP主']);
  assert.ok(!terms.some((term) => /github/i.test(term)));
});

test('domainTerms：缺字段不报错，limit 生效', () => {
  assert.deepEqual(domainTerms({}), []);
  assert.equal(domainTerms({ title: Array.from({ length: 50 }, (_, i) => `word${i}`).join(' ') }, { limit: 5 }).length, 5);
});

test('asrPrompt：中文保留简体引导句并带标题与词表；长度受限', () => {
  const prompt = asrPrompt({ title: 'Git rebase 教程', owner: { name: 'UP' } }, 'zh');
  assert.ok(prompt.startsWith('以下是普通话的句子，用简体中文书写。'));
  assert.match(prompt, /视频标题：Git rebase 教程。相关词：Git、rebase、UP。/);
  const long = asrPrompt({ title: '长'.repeat(500) }, 'zh');
  assert.equal([...long].length, ASR_PROMPT_MAX_CHARS);
  assert.ok(!asrPrompt({ title: 'Hello world' }, 'en').includes('普通话'));
  assert.equal(asrPrompt({}, 'en'), null);
});

test('asrHints：默认不注入元数据 prompt；opt-in 时也只给 prompt', () => {
  const video = { title: 'Git rebase 教程', owner: { name: 'UP' } };
  assert.deepEqual(asrHints(video, 'zh'), {});
  const hints = asrHints(video, 'zh', { metadata: true });
  assert.ok(hints.prompt.startsWith('以下是普通话的句子'));
  assert.equal('hotwords' in hints, false);
  assert.deepEqual(asrHints({}, 'en', { metadata: true }), {});
});
