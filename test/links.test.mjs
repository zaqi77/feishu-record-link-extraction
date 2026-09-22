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

test('uses exact host link parameters, keeps order and host URLs, and isolates failures', async () => {
  let active = 0;
  let max = 0;
  const ids = Array.from({ length: 12 }, (_, i) => `rec${i}`);
  const bridge = { async getBitableUrl(options) {
    assert.deepEqual(Object.keys(options).sort(), ['fieldId', 'recordId', 'tableId', 'viewId']);
    assert.equal(options.fieldId, null);
    assert.equal(options.tableId, 'tbl1');
    assert.equal(options.viewId, 'vew1');
    max = Math.max(max, ++active);
    await new Promise(resolve => setTimeout(resolve, (12 - Number(options.recordId.slice(3))) % 5));
    active--;
    if (options.recordId === 'rec3') throw new Error('无权限');
    return `https://example.feishu.cn/wiki/wiki-node?record=${options.recordId}&extra=keep`;
  } };
  const rows = await extractLinks(bridge, { tableId: 'tbl1', viewId: 'vew1', unused: 'must not be sent' }, [...ids, ids[0]], signal());
  assert.deepEqual(rows.map(row => row.recordId), ids);
  assert.ok(max <= 4);
  assert.equal(rows[3].error, '无权限');
  assert.equal(rows[3].url, '');
  assert.equal(rows[0].url, 'https://example.feishu.cn/wiki/wiki-node?record=rec0&extra=keep');
  assert.equal(linksText(rows).split('\n').length, 11);
});

test('rejects non-HTTPS and executable links returned by host', async () => {
  for (const url of ['javascript:alert(1)', 'http://example.com', 'https://user:pass@example.com']) {
    const rows = await extractLinks({ async getBitableUrl() { return url; } }, { tableId: 't', viewId: 'v' }, ['r'], signal());
    assert.equal(rows[0].url, '');
    assert.match(rows[0].error, /链接无效/);
  }
});

test('stopping a batch preserves completed links and stops scheduling', async () => {
  const controller = new AbortController();
  let calls = 0;
  const rows = await extractLinks({ async getBitableUrl({ recordId }) {
    calls++;
    await new Promise(resolve => setTimeout(resolve, 5));
    return `https://example.feishu.cn/base/demo?record=${recordId}`;
  } }, { tableId: 't', viewId: 'v' }, Array.from({ length: 30 }, (_, i) => `r${i}`), controller.signal, done => {
    if (done === 2) controller.abort();
  });
  assert.equal(rows.length, 2);
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
    { recordId: 'rec1', url: 'https://example.feishu.cn/base/demo', error: '' },
    { recordId: 'rec2', url: '', error: '=危险("引号")\n下一行' },
  ]);
  assert.ok(csv.startsWith('\uFEFF"序号","记录 ID","记录链接","状态"\r\n'));
  assert.ok(csv.includes('"\'=危险(""引号"")\n下一行"'));
  assert.equal(linksText([{ recordId: 'x', url: '', error: '失败' }]), '');
});
