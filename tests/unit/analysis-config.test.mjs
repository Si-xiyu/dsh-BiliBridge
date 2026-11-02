import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// dataDir() 读 BILI_DATA_DIR，所以每个用例都能拿到独立目录，不碰真实配置。
const dir = await mkdtemp(join(tmpdir(), 'bilibili-config-'));
process.env.BILI_DATA_DIR = dir;

const { ANALYSIS_DEFAULTS, analysisConfig, validateAsrSettings } = await import('../../lib/media/analysis-config.mjs');

async function writeConfig(payload) {
  await writeFile(join(dir, 'config.json'), JSON.stringify(payload), 'utf8');
}

test('配置缺失时全部回落到默认值', async () => {
  await writeFile(join(dir, 'config.json'), '', 'utf8');
  const config = analysisConfig();
  assert.deepEqual(config.asr, ANALYSIS_DEFAULTS.asr);
  assert.deepEqual(config.ocr, ANALYSIS_DEFAULTS.ocr);
  assert.equal(config.asrModel, 'small', '旧字段仍要可用');
});

test('asr 段的开关、模型与两个窗口都能读到', async () => {
  await writeConfig({
    asr: { enabled: false, model: 'medium', defaultWindowSeconds: 45, maxWindowSeconds: 120 },
    ocr: { enabled: false },
  });
  const config = analysisConfig();
  assert.equal(config.asr.enabled, false);
  assert.equal(config.asr.model, 'medium');
  assert.equal(config.asr.defaultWindowSeconds, 45);
  assert.equal(config.asr.maxWindowSeconds, 120);
  assert.equal(config.ocr.enabled, false);
});

test('旧顶层 asrModel 仍然生效，非法值被忽略', async () => {
  await writeConfig({ asrModel: 'base' });
  assert.equal(analysisConfig().asr.model, 'base');

  await writeConfig({ asr: { model: 'giant', enabled: 'yes', defaultWindowSeconds: 999 } });
  const config = analysisConfig();
  assert.equal(config.asr.model, 'small');
  assert.equal(config.asr.enabled, true);
  assert.equal(config.asr.defaultWindowSeconds, 30);
});

test('单次上限低于默认窗口时会被抬到默认值，避免“不传就必然越界”', async () => {
  await writeConfig({ asr: { defaultWindowSeconds: 60, maxWindowSeconds: 30 } });
  const config = analysisConfig();
  assert.equal(config.asr.maxWindowSeconds, 60);
});

test('validateAsrSettings 覆盖范围与类型', () => {
  assert.deepEqual(validateAsrSettings({}), []);
  assert.equal(validateAsrSettings({ enabled: 'yes' }).length, 1);
  assert.equal(validateAsrSettings({ model: 'giant' }).length, 1);
  assert.equal(validateAsrSettings({ defaultWindowSeconds: 5 }).length, 1);
  assert.equal(validateAsrSettings({ maxWindowSeconds: 3600 }).length, 1);
  assert.deepEqual(validateAsrSettings({ enabled: true, model: 'tiny', defaultWindowSeconds: 10, maxWindowSeconds: 600 }), []);
});
