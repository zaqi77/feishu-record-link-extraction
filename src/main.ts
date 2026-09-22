import { bitable, viewCheckers, type ITable, type IView } from '@lark-base-open/js-sdk';
import { errorText, extractLinks, hostCall, linksText, readRecordIds, toCsv, type LinkRow } from './links.ts';
import './styles.css';

function element<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing UI element: ${id}`);
  return node as T;
}

const ui = {
  connection: element('connection'), context: element('context'),
  scope: element<HTMLSelectElement>('scope'), note: element('scope-note'),
  refresh: element<HTMLButtonElement>('refresh'), start: element<HTMLButtonElement>('start'),
  cancel: element<HTMLButtonElement>('cancel'), status: element('status'),
  progress: element<HTMLProgressElement>('progress'), results: element('results'),
  summary: element('result-summary'), copy: element<HTMLButtonElement>('copy'),
  download: element<HTMLButtonElement>('download'), preview: element('preview-count'),
  rows: element<HTMLTableSectionElement>('rows'), manual: element<HTMLDetailsElement>('manual-copy'),
  text: element<HTMLTextAreaElement>('copy-text'), empty: element('empty'),
};

type Context = { table: ITable; view: IView; tableId: string; viewId: string; baseId: string | null; name: string };
let context: Context | undefined;
let rows: LinkRow[] = [];
let run: AbortController | undefined;
let revision = 0;
let connected = false;
let tableOff: (() => void)[] = [];
const off: (() => void)[] = [];

function status(message: string, isError = false) {
  ui.status.textContent = message;
  ui.status.dataset.kind = isError ? 'error' : 'info';
}

function busy(value: boolean) {
  ui.start.disabled = value || !context;
  ui.scope.disabled = value || !context;
  ui.refresh.disabled = value;
  ui.cancel.hidden = !value;
  ui.progress.hidden = !value;
  ui.copy.disabled = value || !rows.some(row => row.url);
  ui.download.disabled = value || rows.length === 0;
}

function clearResults() {
  rows = [];
  ui.results.hidden = true;
  ui.empty.hidden = false;
  ui.manual.hidden = true;
  ui.manual.open = false;
  ui.text.value = '';
  ui.rows.replaceChildren();
  ui.copy.disabled = true;
  ui.download.disabled = true;
}

function note() {
  ui.note.textContent = ui.scope.value === 'selected'
    ? '在表格视图中选中多行或一片单元格，再点击提取。每条记录只生成一个链接。'
    : ui.scope.value === 'view'
      ? '提取当前视图筛选后的全部记录，保留视图顺序。'
      : '提取当前数据表中你有权读取的全部记录，不应用当前视图筛选。';
}

function invalidate(message: string) {
  run?.abort();
  run = undefined;
  revision++;
  clearResults();
  busy(false);
  status(message);
}

async function refreshContext() {
  const currentRevision = ++revision;
  run?.abort();
  run = undefined;
  context = undefined;
  tableOff.forEach(unsubscribe => unsubscribe());
  tableOff = [];
  clearResults();
  busy(false);
  ui.refresh.disabled = true;
  ui.connection.textContent = '正在连接';
  try {
    const selection = await hostCall(bitable.base.getSelection());
    if (!selection.tableId || !selection.viewId) {
      throw new Error('请先打开一张数据表的视图，再点击刷新。');
    }
    const table = await hostCall(bitable.base.getTableById(selection.tableId));
    const [view, name] = await hostCall(Promise.all([
      table.getViewById(selection.viewId), table.getName(),
    ]));
    const viewName = await hostCall(view.getName());
    if (currentRevision !== revision) return;
    context = { table, view, tableId: table.id, viewId: view.id, baseId: selection.baseId, name };
    ui.context.textContent = `${name} / ${viewName}`;
    ui.connection.textContent = '已连接多维表格';
    const dataChanged = () => invalidate('记录发生变化，请重新提取以获取最新结果。');
    tableOff = [table.onRecordAdd(dataChanged), table.onRecordDelete(dataChanged), table.onRecordModify(dataChanged)];
    note();
    status('选择提取范围，点击「提取链接」开始。');
  } catch (error) {
    if (currentRevision !== revision) return;
    ui.connection.textContent = '尚未连接';
    ui.context.textContent = '请在多维表格的自定义插件中打开';
    status(errorText(error), true);
  } finally {
    if (currentRevision === revision) busy(false);
  }
}

function renderResults(cancelled: boolean, expected: number) {
  const success = rows.filter(row => row.url).length;
  const failed = rows.length - success;
  ui.results.hidden = false;
  ui.empty.hidden = true;
  ui.summary.textContent = `${cancelled ? '已停止 · ' : ''}成功 ${success} 条 / 失败 ${failed} 条 / 共 ${expected} 条`;
  ui.copy.textContent = `复制 ${success} 条链接`;
  const timestamp = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  ui.preview.textContent = `${timestamp} 提取快照。` + (rows.length > 100 ? `仅预览前 100 条；复制与导出包含已处理的全部 ${rows.length} 条。` : `已处理 ${rows.length} 条记录。`);
  ui.rows.replaceChildren();
  for (const [index, row] of rows.slice(0, 100).entries()) {
    const tr = document.createElement('tr');
    for (const value of [String(index + 1), row.recordId]) {
      const td = document.createElement('td');
      td.textContent = value;
      tr.append(td);
    }
    const td = document.createElement('td');
    if (row.url) {
      const link = document.createElement('a');
      link.href = row.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = '打开记录';
      link.title = row.url;
      td.append(link);
    } else {
      td.textContent = `失败：${row.error}`;
    }
    tr.append(td);
    ui.rows.append(tr);
  }
  status(cancelled ? `已停止；已处理 ${rows.length}/${expected} 条，仅保留已完成的结果。`
    : expected === 0 ? '此范围没有记录。请检查选中状态或视图筛选。'
      : failed ? `提取结束，${failed} 条失败。CSV 包含失败原因，可重新提取。` : `已提取 ${success} 条记录链接。`, failed > 0);
}

ui.start.addEventListener('click', async () => {
  if (!context || run) return;
  const snapshot = context;
  const scope = ui.scope.value;
  const currentRevision = ++revision;
  const controller = new AbortController();
  run = controller;
  clearResults();
  busy(true);
  ui.progress.removeAttribute('value');
  status('正在读取记录范围…');
  try {
    const latest = await hostCall(bitable.base.getSelection(), controller.signal);
    if (latest.baseId !== snapshot.baseId || latest.tableId !== snapshot.tableId || latest.viewId !== snapshot.viewId) {
      await refreshContext();
      status('当前数据表或视图已切换，请重新提取。');
      return;
    }
    const viewSettings = scope === 'view'
      ? JSON.stringify((await hostCall(snapshot.view.getMeta(), controller.signal)).property) : undefined;
    let ids: string[];
    if (scope === 'selected') {
      if (!viewCheckers.isGridView(snapshot.view)) {
        throw new Error('选中记录提取仅支持表格视图。请切换为表格视图，或选择「当前视图记录」。');
      }
      ids = [...new Set(await hostCall(snapshot.view.getSelectedRecordIdList(), controller.signal))];
    } else {
      ids = await readRecordIds(snapshot.table, scope === 'view' ? snapshot.viewId : undefined,
        controller.signal, count => status(`正在读取记录范围：已读取 ${count} 条…`));
    }
    if (scope === 'view' && viewSettings !== JSON.stringify((await hostCall(snapshot.view.getMeta(), controller.signal)).property)) {
      throw new Error('读取期间视图筛选或排序发生变化，请重新提取。');
    }
    const extracted = await extractLinks(bitable.bridge, snapshot, ids, controller.signal, (done, total) => {
      if (currentRevision !== revision) return;
      ui.progress.max = total || 1;
      ui.progress.value = done;
      status(`正在提取链接：${done}/${total}`);
    });
    if (currentRevision !== revision) return;
    rows = extracted;
    renderResults(controller.signal.aborted, ids.length);
  } catch (error) {
    if (currentRevision !== revision) return;
    status(controller.signal.aborted ? '已停止，尚未生成链接。' : errorText(error), !controller.signal.aborted);
  } finally {
    if (run === controller) {
      run = undefined;
      busy(false);
    }
  }
});

ui.cancel.addEventListener('click', () => run?.abort());
ui.refresh.addEventListener('click', () => { void connect(); });
ui.scope.addEventListener('change', () => {
  invalidate('提取范围已更改，请重新提取。');
  note();
});

ui.copy.addEventListener('click', async () => {
  const text = linksText(rows);
  if (!text) return;
  const currentRevision = revision;
  const count = rows.filter(row => row.url).length;
  ui.text.value = text;
  try {
    await navigator.clipboard.writeText(text);
    if (currentRevision !== revision) return;
    status(`已复制 ${count} 条记录链接，每行一条。`);
  } catch {
    if (currentRevision !== revision) return;
    ui.manual.hidden = false;
    ui.manual.open = true;
    ui.text.focus();
    ui.text.select();
    status('浏览器未允许自动复制。链接已选中，请按 ⌘C 或 Ctrl+C。');
  }
});

ui.download.addEventListener('click', () => {
  if (!rows.length) return;
  const url = URL.createObjectURL(new Blob([toCsv(rows)], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  const name = (context?.name || '多维表格').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_');
  link.download = `${name}-记录链接-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
});

async function connect() {
  if (window.self === window.top) {
    ui.connection.textContent = '等待在飞书中打开';
    ui.context.textContent = '这是多维表格侧边栏插件';
    status('打开多维表格 → 插件 → 自定义插件，将此页面地址填入服务地址。');
    ui.refresh.disabled = false;
    return;
  }
  if (!connected) {
    connected = true;
    off.push(bitable.base.onSelectionChange(event => {
      const selection = event.data;
      if (!context || selection.baseId !== context.baseId || selection.tableId !== context.tableId || selection.viewId !== context.viewId) {
        void refreshContext();
      } else if (ui.scope.value === 'selected') {
        invalidate('选中范围已变化，请点击「提取链接」获取当前选中记录。');
      }
    }));
    off.push(bitable.base.onTableDelete(() => { void refreshContext(); }));
    off.push(bitable.base.onPermissionChange(() => { void refreshContext(); }));
    off.push(bitable.bridge.onThemeChange(event => { document.documentElement.dataset.theme = event.data.theme; }));
    void hostCall(bitable.bridge.getTheme()).then(theme => {
      document.documentElement.dataset.theme = theme;
    }).catch(() => {});
  }
  await refreshContext();
}

window.addEventListener('pagehide', () => {
  revision++;
  run?.abort();
  [...off, ...tableOff].forEach(unsubscribe => unsubscribe());
}, { once: true });

note();
void connect();
