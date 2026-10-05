# Paper Reader

[中文说明](README.zh-CN.md)

![Paper Reader demo](assets/paper-reader-demo.gif)

Paper Reader is a local web app for reading research papers. You can organize a library with a folder tree, and use an AI assistant to interpret the paper, read figures, and translate selections. PDFs, translation cache, and model settings are stored on your machine, so the whole reading workflow stays local.

## Features

- Import a local PDF, or paste an arXiv `abs` / `pdf` link. Metadata extraction is built in: when the file name or first page contains an arXiv id, title, authors, year, and abstract are filled from the arXiv API; otherwise Pi reads the first page and extracts the same fields.
- The reader is built on PDF.js. Pages are laid out vertically, with jump-to-page, zoom, and text selection directly on the PDF. When you need a figure, turn on crop mode, box the region, and attach it to the next question.
- Selection translation uses an OpenAI-compatible API. Translation is a separate task, so the result appears below the reader and is cached locally, which cuts token use on repeated translations.
- Summarizing the paper, close-reading the current section, explaining figures, and free-form questions are all handled by Pi. Replies stream in and render as Markdown.

## Requirements

- Node.js 22 or newer
- [Pi](https://pi.dev), already installed and signed in, because the reading assistant runs through the Pi CLI
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

These values, together with the Pi model id and thinking level, can later be changed in **Settings** at the bottom of the left sidebar.

## Pi agent

Summaries, close reading, figure explanations, and ordinary Q&A are handed to [Pi](https://pi.dev), Earendil’s coding-agent CLI. Paper Reader starts Pi in JSON mode, loads the prompt template for each task, and streams the model output into the right-hand chat. Translation takes another path: it calls your configured chat-completions endpoint directly, so latency is lower and the work stays outside the agent session.

Model login, the default model, and thinking level are managed by Pi itself; Paper Reader only forwards the values from **Settings** (or `PI_MODEL` / `PI_THINKING`). For install, `/login`, `/model`, and the rest of Pi’s options, see the [Pi configuration guide](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/configuration.md).

## Development

The API and the frontend can run separately:

```bash
npm run dev:server
npm run dev:web
```

The development UI is at [http://127.0.0.1:5173](http://127.0.0.1:5173); Vite proxies `/api` to port `3080`.

After `npm run build`, you can run a Chrome-based layout check:

```bash
node scripts/check-reader-ui.mjs path/to/paper.pdf
```

Papers, translation cache, and settings are stored under `.runtime/`.
