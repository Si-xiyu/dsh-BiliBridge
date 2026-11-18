import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTimingDynReq, readDraftContent } from '../../lib/bili/drafts.mjs';

const row = (content, topic = null) => ({ source: 'timing', content, topic });
const textNode = (text) => ({ type: 'RICH_TEXT_NODE_TYPE_TEXT', text });

test('新版草稿正文按富文本语义重建，缺 rid 的节点退回纯文本而不是丢字', () => {
  const req = buildTimingDynReq(row({
    title: '标题',
    summary: { text: '@小明 BV1xx411c7mD [doge] 结尾', rich_text_nodes: [
      { type: 'RICH_TEXT_NODE_TYPE_AT', text: '@小明', rid: 123 },
      textNode(' '),
      { type: 'RICH_TEXT_NODE_TYPE_BV', text: 'BV1xx411c7mD', rid: 'BV1xx411c7mD' },
      textNode(' '),
      { type: 'RICH_TEXT_NODE_TYPE_EMOJI', text: '[doge]' },
      textNode(' 结尾'),
    ] },
    pics: [],
  }));
  assert.deepEqual(req.content.contents, [
    { raw_text: '@小明', type: 2, biz_id: '123' },
    { raw_text: ' ', type: 1, biz_id: '' },
    { raw_text: 'BV1xx411c7mD', type: 7, biz_id: 'BV1xx411c7mD' },
    { raw_text: ' ', type: 1, biz_id: '' },
    { raw_text: '[doge]', type: 9, biz_id: '' },
    { raw_text: ' 结尾', type: 1, biz_id: '' },
  ]);
  assert.equal(req.content.title, '标题');
  assert.equal(req.scene, 2);
  assert.equal(req.option.aigc, 2);

  const missingRid = buildTimingDynReq(row({ summary: { rich_text_nodes: [
    { type: 'RICH_TEXT_NODE_TYPE_AT', text: '@无 ID' },
    { type: 'RICH_TEXT_NODE_TYPE_BV', text: 'BV1xx411c7mD' },
  ] }, pics: [] }));
  assert.deepEqual(missingRid.content.contents, [
    { raw_text: '@无 ID', type: 1, biz_id: '' },
    { raw_text: 'BV1xx411c7mD', type: 1, biz_id: '' },
  ]);
});

test('纯图片草稿补分享图片文案并映射图片尺寸；特殊卡片拒绝发布', () => {
  const req = buildTimingDynReq(row({
    summary: { text: '', rich_text_nodes: [] },
    pics: [{ url: 'https://i0.hdslb.com/a.jpg', width: 640, height: 480, size: 1234, live_url: 'https://live.example/x', aigc: true }],
    style: 1,
  }));
  assert.deepEqual(req.content.contents, [{ raw_text: '分享图片', type: 1, biz_id: '' }]);
  assert.deepEqual(req.pics, [{ img_src: 'https://i0.hdslb.com/a.jpg', img_width: 640, img_height: 480, img_size: 1234,
    live_video_src: 'https://live.example/x', ai_gen_pic: true }]);
  assert.equal(req.option.pic_mode, 1);
  assert.equal(req.scene, 2);

  for (const type of ['RICH_TEXT_NODE_TYPE_LOTTERY', 'RICH_TEXT_NODE_TYPE_VOTE', 'RICH_TEXT_NODE_TYPE_GOODS']) {
    assert.throws(() => buildTimingDynReq(row({ summary: { text: 'x', rich_text_nodes: [{ type, text: 'x', rid: 1 }] }, pics: [] })),
      { code: 'UNSUPPORTED' });
  }
  assert.throws(() => buildTimingDynReq(row({ summary: { text: 'x', rich_text_nodes: [textNode('x')] },
    pics: [{ url: 'https://i0.hdslb.com/a.jpg' }] })), { code: 'INVALID_RESPONSE' });
});

test('readDraftContent 同时接受旧版 request 与新版列表结构', () => {
  assert.deepEqual(readDraftContent({ request: JSON.stringify({ content: '旧版正文', pictures: '[{"img_src":"a"}]' }) }), {
    text: '旧版正文', pictures: [{ img_src: 'a' }], title: undefined,
  });
  assert.deepEqual(readDraftContent({ request: JSON.stringify({ content: { title: 't', summary: { text: '新版正文' }, pics: [] } }) }), {
    text: '新版正文', pictures: [], title: 't',
  });
});
