import test from 'node:test';
import assert from 'node:assert/strict';
import { extractLinks, hostCall, linksText, readRecordIds, toCsv } from '../src/links.ts';

const signal = () => new AbortController().signal;

test('reads more than 200 records, keeps order, deduplicates, and retains view scope', async () => {
  const calls = [];
  const table = { async getRecordIdListByPage(params) {
    calls.push(params);
    const start = params.pageToken ?? 0;
    return {
      recordIds: Array.from({ length: 200 }, (_, i) => `rec${start + i}`),
      total: 599, hasMore: start < 399, pageToken: start + 199,
    };
  } };
  const ids = await readRecordIds(table, 'vewFiltered', signal());
  assert.equal(ids.length, 797);
  assert.equal(ids.at(-1), 'rec796');
  assert.equal(calls.length, 4);
  assert.ok(calls.every(call => call.pageSize === 200 && call.viewId === 'vewFiltered'));
});

test('full table omits view scope; zero page token is valid', async () => {
  let page = 0;
  const table = { async getRecordIdListByPage(params) {
    assert.equal(params.viewId, undefined);
    if (++page === 1) return { recordIds: ['a'], hasMore: true, pageToken: 0 };
    assert.equal(params.pageToken, 0);
    return { recordIds: ['b'], hasMore: false };
  } };
  assert.deepEqual(await readRecordIds(table, undefined, signal()), ['a', 'b']);
});

test('rejects incomplete or looping pagination instead of reporting success', async () => {
  for (const pageToken of [undefined, 7]) {
    let calls = 0;
    await assert.rejects(readRecordIds({ async getRecordIdListByPage() {
      calls++;
      return { recordIds: ['a'], hasMore: true, pageToken };
    } }, 'view', signal()), /分页未继续/);
    assert.ok(calls <= 2);
  }
});

test('cancelled enumeration makes no host request', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(readRecordIds({ getRecordIdListByPage() { assert.fail('unexpected request'); } }, undefined, controller.signal), { name: 'AbortError' });
});

test('uses the native record-share API, preserves short links and order, deduplicates, and isolates failures', async () => {
  let active = 0;
  let max = 0;
  const calls = [];
  const ids = Array.from({ length: 12 }, (_, i) => `rec${i}`);
  const table = { async getRecordShareLink(recordId) {
    assert.equal(this, table);
    assert.equal(typeof recordId, 'string');
    calls.push(recordId);
    max = Math.max(max, ++active);
    await new Promise(resolve => setTimeout(resolve, 5 + (12 - Number(recordId.slice(3))) % 5));
    active--;
    if (recordId === 'rec3') throw new Error('无权限');
    return `https://example.feishu.cn/record/share-${recordId}${recordId === 'rec0' ? '/' : ''}`;
  }, getBitableUrl() {
    assert.fail('must not fall back to the long-link API');
  } };
  const progress = [];
  const rows = await extractLinks(table, [...ids, ids[0]], signal(), (done, total) => progress.push([done, total]));
  assert.deepEqual(rows.map(row => row.recordId), ids);
  assert.deepEqual(calls, ids);
  assert.equal(max, 4);
  assert.deepEqual(progress, ids.map((_, i) => [i + 1, ids.length]));
  assert.equal(rows[3].error, '无权限');
  assert.equal(rows[3].url, '');
  assert.equal(rows[0].url, 'https://example.feishu.cn/record/share-rec0/');
  assert.equal(rows[11].url, 'https://example.feishu.cn/record/share-rec11');
  assert.equal(linksText(rows).split('\n').length, 11);
});

test('rejects empty, malformed, non-HTTPS, and credential-bearing record links', async () => {
  for (const url of [undefined, null, 42, {}, '', ' ', 'not a URL', 'javascript:alert(1)', 'http://example.feishu.cn/record/share-r', 'https://user:pass@example.feishu.cn/record/share-r']) {
    const rows = await extractLinks({ async getRecordShareLink() { return url; } }, ['r'], signal());
    assert.equal(rows[0].url, '');
    assert.match(rows[0].error, /链接无效/);
  }
});

test('rejects long links and non-record paths without falling back', async () => {
  for (const url of [
    'https://example.feishu.cn/base/demo?table=tbl1&view=vew1&record=r',
    'https://example.feishu.cn/wiki/demo?record=r',
    'https://example.feishu.cn/record/',
    'https://example.feishu.cn/record/share-r/extra',
    'https://example.feishu.cn/record/share-r?table=tbl1',
    'https://example.feishu.cn/record/share-r#detail',
  ]) {
    const rows = await extractLinks({
      async getRecordShareLink() { return url; },
      getBitableUrl() { assert.fail('must not fall back to a long link'); },
    }, ['r'], signal());
    assert.equal(rows[0].url, '');
    assert.match(rows[0].error, /未返回原生记录短链/);
    assert.equal(linksText(rows), '');
  }
});

test('reports an actionable error when the SDK lacks the record-share API', async () => {
  for (const table of [{}, { getRecordShareLink: undefined }, { getRecordShareLink: 'unavailable' }]) {
    await assert.rejects(extractLinks(table, ['r'], signal()), {
      message: '当前 SDK 不支持记录短链，请更新插件后重试。',
    });
  }
});

test('a cancelled extraction makes no native record-share request', async () => {
  const controller = new AbortController();
  controller.abort();
  const rows = await extractLinks({ getRecordShareLink() { assert.fail('unexpected request'); } }, ['r'], controller.signal);
  assert.deepEqual(rows, []);
});

test('stopping a batch preserves completed links and stops scheduling', async () => {
  const controller = new AbortController();
  let calls = 0;
  const rows = await extractLinks({ async getRecordShareLink(recordId) {
    calls++;
    await new Promise(resolve => setTimeout(resolve, 5));
    return `https://example.feishu.cn/record/share-${recordId}`;
  } }, Array.from({ length: 30 }, (_, i) => `r${i}`), controller.signal, done => {
    if (done === 2) controller.abort();
  });
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(row => row.url), ['https://example.feishu.cn/record/share-r0', 'https://example.feishu.cn/record/share-r1']);
  assert.ok(calls <= 5);
});

test('host timeout and cancellation do not leave pending UI operations', async () => {
  await assert.rejects(hostCall(new Promise(() => {}), undefined, 5), /超时/);
  const controller = new AbortController();
  const pending = hostCall(new Promise(() => {}), controller.signal);
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
});

test('CSV supports Chinese, quotes/newlines and formula-looking errors safely', () => {
  const csv = toCsv([
    { recordId: 'rec1', url: 'https://example.feishu.cn/record/share-rec1', error: '' },
    { recordId: 'rec2', url: '', error: '=危险("引号")\n下一行' },
  ]);
  assert.ok(csv.startsWith('\uFEFF"序号","记录 ID","记录链接","状态"\r\n'));
  assert.ok(csv.includes('"\'=危险(""引号"")\n下一行"'));
  assert.equal(linksText([{ recordId: 'x', url: '', error: '失败' }]), '');
});
