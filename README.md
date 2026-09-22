# 多维表格记录链接插件

项目名称：`feishu-record-link-extraction`。仓库：[zaqi77/feishu-record-link-extraction](https://github.com/zaqi77/feishu-record-link-extraction)。

批量获取可直接打开单条记录详情的链接，用于替代逐行右键「复制记录链接」。支持当前选中记录、当前视图筛选结果及整张数据表；一键复制，每行一个链接，也可导出带记录 ID 的 CSV。

## 在 macOS 上使用

1. 双击本目录的 `启动插件.command`，保留打开的终端窗口。
2. 在飞书中打开你要处理的多维表格，进入「插件」→「自定义插件」→ 新增插件。
3. 名称填「记录链接」，服务地址填 `http://127.0.0.1:5173/`。
4. 在表格视图选中多行或一片单元格，在插件中选择「当前选中记录」，点击「提取链接」。
5. 点击「复制 N 条链接」或「导出 CSV」。复制权限被浏览器拦截时，插件会选中链接文本，按 `⌘C`（Windows：`Ctrl+C`）即可。

若通过 GitHub 下载后启动脚本提示没有执行权限，在项目目录的终端运行 `zsh 启动插件.command`，或按下方开发步骤运行 `npm ci` 和 `npm run dev`。

如浏览器询问本地网络访问权限，允许飞书页面访问本机服务。只在浏览器直接打开这个地址，会显示接入提示；读取记录需要飞书的插件容器。

`127.0.0.1` 只供运行服务的本机使用。停止服务：在启动终端按 `Ctrl+C`。若提示 5173 端口占用，先检查是否已启动本插件；不要关闭不明进程。也可以在项目内使用 `npm run dev -- --port 5174`，并将插件服务地址改为同一端口。

## 提取范围

| 选项 | 提取内容 |
| --- | --- |
| 当前选中记录 | 表格视图中选中的记录，同一行的多个单元格只生成一个链接；其他视图会提示切换范围 |
| 当前视图记录 | 当前视图筛选后的全部记录，自动翻页，保留返回顺序 |
| 整张表记录 | 当前数据表中有权读取的全部记录，不受当前视图筛选限制 |

切换表或视图会清空旧结果；记录变更、提取中变更选区会停止旧任务。视图分页前后校验筛选、排序等设置。结果标注提取时间；调整视图后重新提取。结果列表只预览前 100 条，复制和 CSV 包含全部已处理结果。单条失败不会中断其他记录，CSV 会列出失败原因。手动停止时明确显示已处理数量，仅保留已完成的结果。

链接沿用原多维表格的访问权限；接收人仍需有权限。插件不新建字段、不写回记录、不调用开启分享的接口，也不需要填写 App Secret 或访问令牌。运行时只通过飞书 SDK 获取表/视图信息、记录 ID 及链接；没有自建后端、外部数据上传或持久化记录缓存。

## 开发与部署

Node.js 22.12 或更新版本：

```sh
npm ci
npm run dev
npm test
npm run build
```

`npm test` 使用 Node 内置测试；`npm run build` 包含 TypeScript 类型检查。界面测试可额外使用已安装的 Playwright，先启动开发服务，再执行 `node test/browser-smoke.mjs`；如使用系统 Chrome 可设置 `PLAYWRIGHT_CHANNEL=chrome`，如 Playwright 不在项目依赖目录，可用 `PLAYWRIGHT_MODULE` 指定它的 `index.mjs`。界面测试会使用模拟宿主，不会读写真实飞书数据。

本项目为原生 TypeScript + CSS + 官方 `@lark-base-open/js-sdk@1.0.2`，无需 React 或服务端。生产产物已放在 `dist/`，`package.json` 声明 `"output": "dist"`，Vite 使用 `base: './'`，符合指南的相对资源路径要求。`dist` 特意不加入 `.gitignore`。

正式使用可将 `dist` 内全部文件部署到支持 HTTPS 和 iframe 嵌入的静态服务器，再将自定义插件服务地址替换为部署地址。分享给其他人需要可访问的 HTTPS 服务；插件中心上架还需按官方指南提交并通过审核。当前交付没有发布到公共服务器或插件中心。

## API 与参考

- [用户提供的开发指南](https://feishu.feishu.cn/docx/S1pMdbckEooVlhx53ZMcGGnMnKc)：2026-09-22 读取版本 453，核对前端、UI、性能、代码提交及本地调试章节。
- [记录链接接口](https://lark-base-team.github.io/js-sdk-docs/zh/api/bridge.html#getbitableurl)：使用 `bitable.bridge.getBitableUrl({ tableId, viewId, recordId, fieldId: null })`，由飞书生成完整链接，`recordId` 非空时打开记录卡片；保留返回链接，不自行猜测域名或 Base/Wiki 路径。
- [记录分页接口](https://lark-base-team.github.io/js-sdk-docs/zh/api/table.html#getrecordidlistbypage)：每页 200 条，循环到 `hasMore=false`；SDK 1.0.2 的 `pageToken` 为 number，原样传回。未使用最多仅返回 200 条的旧 `getRecordIdList`。
- [选中记录接口](https://lark-base-team.github.io/js-sdk-docs/zh/api/view/grid.html#getselectedrecordidlist)：仅在 SDK 确认是 Grid 视图后调用 `getSelectedRecordIdList()`。

这里实现的是“打开指定记录详情”的链接语义。官方文档没有声明 `getBitableUrl` 的输出与右键「复制记录链接」逐字一致；发布前应在你的真实多维表格里抽查一次菜单链接与插件链接均打开同一条记录，包含 Base/Wiki、高级权限及筛选外记录场景。

## 本次验证

详见 `验证记录.md`。测试与打包成功不代表已经在用户真实多维表格安装验收。
