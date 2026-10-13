# Full-text RAG

Paper Reader builds a full-text index when a paper is imported. It uses Zhipu's Expert file parser for PDF extraction and Embedding-3 for vectors.

## Zhipu configuration

Set the API key before starting the Node server:

```bash
export GLM_API_KEY=...
```

Optional overrides:

```bash
export GLM_PARSER_BASE_URL=https://open.bigmodel.cn/api/paas/v4
export GLM_EMBEDDING_BASE_URL=https://open.bigmodel.cn/api/paas/v4
export GLM_EMBEDDING_MODEL=embedding-3
export GLM_EMBEDDING_DIMENSIONS=2048
export RAG_TOP_K=5
```

The parser and embedding requests use the same `GLM_API_KEY`. The API key is never returned by `/api/settings`.

## Import pipeline

```text
PDF
→ Zhipu Expert asynchronous parser
→ result.md + extracted images
→ H2/H3 Markdown section parsing
→ paragraph-level split for long sections
→ Zhipu Embedding-3
→ local rag-index.json
```

The Expert task is uploaded to:

```text
POST /files/parser/create
GET  /files/parser/result/{task_id}/download_link
```

The downloaded result is saved inside the paper directory:

```text
parse-task.json
parsed/result.zip
parsed/result.md
parsed/images/*
rag-index.json
```

Signed result URLs are not persisted. Extracted images are stored as metadata and are not embedded.

## Chunking rules

- Ignore level-one Markdown headings.
- Use level-two headings as parent chapter boundaries.
- Use level-three headings as the smallest chapter unit.
- A level-three chunk includes both its level-two and level-three headings, for example:

```markdown
## 3 Methods
### 3.2 Framework

The section text...
```

- Text directly under a level-two heading is retained as a separate level-two chunk.
- Expert emits dense tables as HTML `<table>` markup. Tables are converted to Markdown pipe tables before chunking, which removes tag noise and keeps inputs within the Embedding-3 token limit.
- A long chapter is split at blank-line paragraph boundaries when it approaches the Embedding-3 single-input limit. Every subchunk repeats its level-two and level-three heading context.
- A single paragraph that still exceeds the limit fails the import instead of being truncated.

The Expert Markdown result does not include reliable page markers. Current full-text results cite chapter names and report page ranges as unknown rather than guessing page numbers.

## Embedding-3

Paper Reader calls:

```text
POST https://open.bigmodel.cn/api/paas/v4/embeddings
```

Requests are batched at 64 texts, with the configured dimensions. Embedding-3 accepts one input up to 3072 tokens; Paper Reader packs chunks conservatively (4000 characters or an estimated 2800 tokens, whichever hits first). The character budget stays well below the token limit because DOI-heavy reference lists and LaTeX-dense sections tokenize much worse than prose — a 7500-character reference chunk can exceed 3072 tokens while a same-size prose chunk passes.

The API accepts `input` as a string or a string array; Paper Reader always sends the array form.

## Rebuilding indexes

Papers imported before full-text indexing was introduced have no `rag-index.json`. Use the paper context menu action “重建全文索引” or call:

```text
POST /api/papers/{id}/reindex
```

The endpoint re-runs the Expert parse and embedding pipeline against the stored `original.pdf` and overwrites the index. Imports and reindexing can take several minutes; the HTTP server allows requests up to 15 minutes.

## Retrieval

The Pi `paper_search` tool embeds the query, compares it with normalized local vectors, and returns the highest-scoring chapter chunks. Results contain chapter names, content, scores, and `未知` for page citations when the parser did not provide page metadata.
