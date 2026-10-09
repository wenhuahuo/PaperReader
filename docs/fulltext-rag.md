# Full-text RAG services

Paper Reader builds the full-text index when a paper is imported. It calls the GLM-OCR SDK HTTP server for PDF parsing and a WeMM-Embedding OpenAI-compatible server for section vectors.

## GLM-OCR

Install the official self-hosted SDK and start the OCR model service:

```bash
pip install "glmocr[selfhosted,server]" "vllm>=0.19.0" "transformers>=5.3.0"
vllm serve zai-org/GLM-OCR \
  --port 8080 \
  --served-model-name glm-ocr \
  --speculative-config '{"method":"mtp","num_speculative_tokens":3}'
```

Start the GLM-OCR SDK server with a configuration whose `pipeline.maas.enabled` is `false` and whose `pipeline.ocr_api` points to the vLLM service:

```bash
python -m glmocr.server --config config.yaml
```

The SDK server must expose:

```text
POST http://127.0.0.1:5002/glmocr/parse
```

The server performs layout detection, OCR, and structured result formatting. Paper Reader sends rendered PDF pages as data URLs and reads section titles, text, page numbers, and image-region metadata from `json_result`.

## WeMM-Embedding

```bash
MODEL_PATH=/path/to/WeMM-Embedding-2B
vllm serve "$MODEL_PATH" \
  --runner pooling \
  --chat-template "$MODEL_PATH/embedding_chat_template.jinja" \
  --served-model-name WeMM-Embedding-2B
```

Paper Reader calls the OpenAI-compatible endpoint:

```text
POST http://127.0.0.1:8000/v1/embeddings
```

## Paper Reader configuration

Set these environment variables before starting the Node server:

```bash
export GLM_OCR_BASE_URL=http://127.0.0.1:5002
export WEMM_EMBEDDING_BASE_URL=http://127.0.0.1:8000/v1
export WEMM_EMBEDDING_MODEL=WeMM-Embedding-2B
export RAG_TOP_K=5
```

Optional API keys are sent as bearer tokens:

```bash
export GLM_OCR_API_KEY=...
export WEMM_EMBEDDING_API_KEY=...
```

Images detected by GLM-OCR are stored as page, label, bounding-box, and OCR-content metadata. They are not embedded or retrieved.

The Pi `paper_search` tool is enabled for paper questions. It embeds the tool query, retrieves the highest-scoring indexed sections, and returns their text, section names, page ranges, and scores to Pi.
