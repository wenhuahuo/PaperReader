# Paper Reader

本地运行的 AI 论文阅读工具：左侧论文库、中间 PDF 阅读器、右侧论文 Agent。

## 启动

```bash
npm install
npm run build
npm start
```

浏览器访问 `http://127.0.0.1:3080`。

## 模型配置

翻译直接调用 OpenAI 兼容接口：

```bash
export TRANSLATION_BASE_URL="https://api.openai.com/v1"
export TRANSLATION_API_KEY="your-key"
export TRANSLATION_MODEL="gpt-4o-mini"
```

论文概括、精读、问答和图片解释由已安装并已完成认证的 `pi` CLI 运行。可选配置：

```bash
export PI_MODEL="provider/model"
export PI_THINKING="medium"
```

也可以使用本地 OpenAI 兼容服务作为翻译接口。论文文件和运行数据保存在 `.runtime/`，不会进入 Git。

## 开发

服务端和前端分别运行：

```bash
npm run dev:server
npm run dev:web
```

开发前端访问 `http://127.0.0.1:5173`，Vite 会把 `/api` 请求代理到 `3080`。

界面检查（需要先 `npm run build`，使用本机 Chrome，结果和截图写入 `.runtime/reader-ui-check/`）：

```bash
node scripts/check-reader-ui.mjs path/to/paper.pdf
```

## 当前能力

- 本地 PDF 和 arXiv 链接导入
- 文件夹和论文目录
- PDF.js 高清渲染、翻页、缩放，PDF 页面上直接选择文字
- 「框选图片」模式截取页面区域并附加到 Agent 上下文
- 独立翻译任务与本地翻译缓存
- pi 流式论文问答
- 可折叠文件夹树、文件夹右键重命名/递归删除/导入、论文右键删除
- 设置页维护翻译模型、Pi 模型、思考强度和 prompt templates
