// Browser test fixture only. Playwright substitutes this at the SDK boundary.
const callbacks = new Map();
const subscribe = name => callback => {
  const set = callbacks.get(name) || new Set();
  callbacks.set(name, set);
  set.add(callback);
  return () => set.delete(callback);
};
const host = window.__host = {
  selection: { baseId: 'base-test', tableId: 'tblTest', viewId: 'vewTest', fieldId: null, recordId: null },
  selected: ['rec001', 'rec002', 'rec003'],
  grid: true,
  fail: [],
  delay: 0,
  calls: [],
  pageCalls: [],
  clipboard: '',
  settings: {},
  changeSettingsOnPage: false,
  emit(name, data) { for (const callback of callbacks.get(name) || []) callback({ data }); },
};
const view = {
  id: 'vewTest', tableId: 'tblTest',
  async getName() { return '全部订单'; },
  async getMeta() { return { property: host.settings }; },
  async getSelectedRecordIdList() { return host.selected; },
};
const table = {
  id: 'tblTest',
  async getName() { return '插件测试表（模拟数据）'; },
  async getViewById(id) { return { ...view, id }; },
  async getRecordIdListByPage(params) {
    host.pageCalls.push(params);
    if (host.changeSettingsOnPage) host.settings = { filterInfo: 'changed' };
    const total = params.viewId ? 257 : 451;
    const start = params.pageToken ?? 0;
    const end = Math.min(start + params.pageSize, total);
    return { recordIds: Array.from({ length: end - start }, (_, i) => `rec${String(start + i + 1).padStart(3, '0')}`), total, hasMore: end < total, pageToken: end };
  },
  onRecordAdd: subscribe('add'), onRecordDelete: subscribe('delete'), onRecordModify: subscribe('modify'),
};
export const viewCheckers = { isGridView() { return host.grid; } };
export const bitable = {
  base: {
    async getSelection() { return host.selection; },
    async getTableById(id) { return { ...table, id }; },
    onSelectionChange: subscribe('selection'), onTableDelete: subscribe('tableDelete'), onPermissionChange: subscribe('permission'),
  },
  bridge: {
    async getBitableUrl(options) {
      host.calls.push(options);
      if (host.delay) await new Promise(resolve => setTimeout(resolve, host.delay));
      if (host.fail.includes(options.recordId)) throw new Error('模拟：记录无权限');
      return `https://example.feishu.cn/base/demo?table=${options.tableId}&view=${options.viewId}&record=${options.recordId}`;
    },
    async getTheme() { return 'LIGHT'; },
    onThemeChange: subscribe('theme'),
  },
};
