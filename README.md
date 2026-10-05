# Paper Reader

[中文说明](README.zh-CN.md)

Paper Reader is a local web app for reading research papers with an AI assistant beside the PDF. The layout stays on one screen: a folder tree on the left, a continuous PDF reader in the middle, and a Pi-powered chat on the right. Papers, translations, and settings remain on your machine, so the reading loop—import, open, annotate, and ask—happens without a hosted account.

## Features

- Import a local PDF or an arXiv `abs` / `pdf` link. When the file name or first page contains an arXiv id, Paper Reader fills in title, authors, year, and abstract from the arXiv API; otherwise it asks Pi to read the first page and extract the same fields.
- Organize papers in a nested folder tree. Folders can be renamed, nested, or removed; a paper can be deleted on its own.
- Read with PDF.js: continuous scrolling, page jump, zoom, and native text selection on the page. Crop mode captures a figure or table and attaches it to the next question.
- Translate a selection through an OpenAI-compatible API. Translation is a side task, so it stays out of the chat transcript and is cached locally.
- Ask Pi to summarize the paper, close-read the current section, explain a figure, or answer a free-form question. Replies stream in and render as Markdown. Enter sends a message; Ctrl+Enter inserts a newline.

## Requirements

- Node.js 22 or newer
- [Pi](https://pi.dev), already installed and signed in, because the reading agent runs through the Pi CLI
- An OpenAI-compatible endpoint if you want selection translation

## Setup

```bash
npm install
npm run build
npm start
```

Then open [http://127.0.0.1:3080](http://127.0.0.1:3080).

Translation can also be set with environment variables before the first launch:

```bash
export TRANSLATION_BASE_URL="https://api.openai.com/v1"
export TRANSLATION_API_KEY="your-key"
export TRANSLATION_MODEL="gpt-4o-mini"
```

The same values, together with the Pi model id and thinking level, are editable later in the in-app **Settings** page at the bottom of the left sidebar.

## Pi agent

Summaries, section reading, figure explanations, and ordinary Q&A are delegated to [Pi](https://pi.dev), Earendil’s coding-agent CLI. Paper Reader starts Pi in JSON mode, loads project prompt templates for each task, and streams the assistant tokens into the right-hand chat. Translation is the exception: it calls the configured chat-completions endpoint directly, which keeps that path fast and separate from the agent session.

Because Pi owns model login, default model, and thinking level, Paper Reader only passes through the values you set in **Settings** (or `PI_MODEL` / `PI_THINKING`). For install, `/login`, `/model`, and the rest of Pi’s own configuration, follow the [Pi configuration guide](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/configuration.md).

## Development

Run the API and the Vite frontend separately:

```bash
npm run dev:server
npm run dev:web
```

The UI is at [http://127.0.0.1:5173](http://127.0.0.1:5173); Vite proxies `/api` to port `3080`.

After `npm run build`, a Chrome-based layout check is available:

```bash
node scripts/check-reader-ui.mjs path/to/paper.pdf
```

Local papers, translation cache, and settings live under `.runtime/`.
