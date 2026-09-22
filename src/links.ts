import type { ITable, IBridge } from '@lark-base-open/js-sdk';

export type LinkRow = { recordId: string; url: string; error: string };

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// A host that stopped responding must not leave the sidebar busy forever.
export function hostCall<T>(promise: Promise<T>, signal?: AbortSignal, timeout = 20_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => finish(() => reject(new DOMException('已停止', 'AbortError')));
    const timer = setTimeout(() => finish(() => reject(new Error('飞书响应超时，请重试。'))), timeout);
    function finish(action: () => void) {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      action();
    }
    promise.then(value => finish(() => resolve(value)), error => finish(() => reject(error)));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

export async function readRecordIds(
  table: Pick<ITable, 'getRecordIdListByPage'>,
  viewId: string | undefined,
  signal: AbortSignal,
  onPage: (count: number) => void = () => {},
): Promise<string[]> {
  const ids = new Set<string>();
  const tokens = new Set<number>();
  let pageToken: number | undefined;
  do {
    signal.throwIfAborted();
    const page = await hostCall(table.getRecordIdListByPage({ pageSize: 200, pageToken, viewId }), signal);
    for (const id of page.recordIds) if (id) ids.add(id);
    onPage(ids.size);
    if (!page.hasMore) return [...ids];
    if (page.pageToken === undefined || tokens.has(page.pageToken)) {
      throw new Error('飞书分页未继续，结果可能不完整。请刷新后重新提取。');
    }
    tokens.add(page.pageToken);
    pageToken = page.pageToken;
  } while (true);
}

export async function extractLinks(
  bridge: Pick<IBridge, 'getBitableUrl'>,
  context: { tableId: string; viewId: string },
  recordIds: string[],
  signal: AbortSignal,
  onProgress: (done: number, total: number) => void = () => {},
): Promise<LinkRow[]> {
  const ids = [...new Set(recordIds.filter(Boolean))];
  const rows: (LinkRow | undefined)[] = new Array(ids.length);
  let next = 0;
  let done = 0;
  // Four in-flight host calls keep large selections responsive without flooding the bridge.
  async function worker() {
    while (!signal.aborted && next < ids.length) {
      const index = next++;
      const recordId = ids[index];
      try {
        const url = await hostCall(bridge.getBitableUrl({
          tableId: context.tableId, viewId: context.viewId, recordId, fieldId: null,
        }), signal);
        const parsed = new URL(url);
        if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
          throw new Error('飞书返回的记录链接无效。');
        }
        rows[index] = { recordId, url, error: '' };
      } catch (error) {
        if (signal.aborted) break;
        rows[index] = { recordId, url: '', error: errorText(error) };
      }
      onProgress(++done, ids.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, ids.length) }, worker));
  return rows.filter((row): row is LinkRow => row !== undefined);
}

export function linksText(rows: LinkRow[]): string {
  return rows.filter(row => row.url).map(row => row.url).join('\n');
}

export function toCsv(rows: LinkRow[]): string {
  function cell(value: string) {
    // Spreadsheet applications must treat error messages and identifiers as text.
    const safe = /^[\s\u0000-\u001f]*[=+@-]/u.test(value) ? `'${value}` : value;
    return `"${safe.replaceAll('"', '""')}"`;
  }
  const data = [['序号', '记录 ID', '记录链接', '状态'], ...rows.map((row, index) => [
    String(index + 1), row.recordId, row.url, row.error || '成功',
  ])];
  return '\uFEFF' + data.map(row => row.map(cell).join(',')).join('\r\n');
}
