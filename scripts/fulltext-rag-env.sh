#!/usr/bin/env bash

export GLM_OCR_BASE_URL="${GLM_OCR_BASE_URL:-http://127.0.0.1:5002}"
export WEMM_EMBEDDING_BASE_URL="${WEMM_EMBEDDING_BASE_URL:-http://127.0.0.1:8000/v1}"
export WEMM_EMBEDDING_MODEL="${WEMM_EMBEDDING_MODEL:-WeMM-Embedding-2B}"
export RAG_TOP_K="${RAG_TOP_K:-5}"

# Self-hosted services do not require API keys by default.
export GLM_OCR_API_KEY="${GLM_OCR_API_KEY:-}"
export WEMM_EMBEDDING_API_KEY="${WEMM_EMBEDDING_API_KEY:-}"
