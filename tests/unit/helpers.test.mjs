import assert from 'node:assert/strict';
import test from 'node:test';
import { BiliError } from '../../lib/bili/errors.mjs';
import { asToolError } from '../../lib/tools/helpers.mjs';

test('asToolError 保留错误码，开发者日志才能显示具体原因', () => {
  assert.throws(
    () => asToolError(new BiliError('AUTH_REQUIRED', '需要登录')),
    (error) => {
      assert.equal(error.code, 'AUTH_REQUIRED');
      assert.match(error.message, /^AUTH_REQUIRED: 需要登录/);
      return true;
    },
  );
});

test('retryable 的错误在消息里提示、属性也保留', () => {
  assert.throws(
    () => asToolError(new BiliError('UPSTREAM_ERROR', '稍后再试', { retryable: true })),
    (error) => {
      assert.equal(error.code, 'UPSTREAM_ERROR');
      assert.equal(error.retryable, true);
      assert.match(error.message, /可稍后重试/);
      return true;
    },
  );
});

test('非 BiliError 原样抛出，不被包装', () => {
  const raw = new Error('raw');
  assert.throws(() => asToolError(raw), (error) => error === raw);
});
