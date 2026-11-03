import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendHistory, readHistory } from '../../lib/media/history.mjs';

test('history: missing file, append, 200-line retention and invalid lines', async () => {
  const previous = process.env.BILI_DATA_DIR;
  const dir = await mkdtemp(join(tmpdir(), 'bili-history-'));
  process.env.BILI_DATA_DIR = dir;
  try {
    assert.deepEqual(await readHistory(), []);
    await appendHistory({ at: 'first', tool: 'test', params: {} });
    assert.equal((await readHistory())[0].at, 'first');
    await Promise.all(Array.from({ length: 205 }, (_, i) => appendHistory({ at: i, tool: 'test' })));
    const lines = (await readFile(join(dir, 'history.jsonl'), 'utf8')).trim().split('\n');
    assert.equal(lines.length, 200);
    assert.equal(JSON.parse(lines[0]).at, 5);
    await appendFile(join(dir, 'history.jsonl'), 'broken\nnull\n[]\n');
    assert.deepEqual((await readHistory({ limit: 2 })).map(item => item.at), [204, 203]);
  } finally {
    if (previous === undefined) delete process.env.BILI_DATA_DIR;
    else process.env.BILI_DATA_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
