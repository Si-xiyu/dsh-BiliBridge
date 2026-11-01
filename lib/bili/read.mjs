import { BiliError } from './errors.mjs';

export function positiveInteger(value, name, fallback, max = Number.MAX_SAFE_INTEGER) {
  const n = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(n) || n < 1 || n > max) {
    throw new BiliError('INVALID_ARGUMENT', `${name} 必须是 1–${max} 的整数`);
  }
  return n;
}

export function assertMid(mid) {
  if (typeof mid !== 'string' || !/^[1-9]\d*$/.test(mid)) {
    throw new BiliError('INVALID_ARGUMENT', 'mid 必须是正整数字符串');
  }
  return mid;
}

export function isoTime(seconds) {
  if (seconds === undefined || seconds === null || seconds === '') return undefined;
  const time = new Date(Number(seconds) * 1000);
  return Number.isFinite(time.getTime()) ? time.toISOString() : undefined;
}

export function optionalId(value) {
  return value === undefined || value === null || value === '' ? undefined : String(value);
}

export function requireArray(value, label) {
  if (!Array.isArray(value)) throw new BiliError('INVALID_RESPONSE', `${label} 响应缺少列表`);
  return value;
}
