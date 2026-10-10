"""Standalone pdf-to-json-rag assessment; reads the library without changing it."""

import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import time

PAPER_IDS = ["1807.03819", "2609.40305", "2610.02383", "2610.02185", "2609.40316"]
# Use the upstream CLI unchanged except for explicitly disabling its OCR callback.
ASSESS = """
import sys
from pdf_to_json_rag import extraction, cli

def skip_ocr(pdf_path, page_num, **kwargs):
    print(f'OCR disabled: requested page {page_num + 1}', file=sys.stderr)
    return []

extraction.extract_page_with_ocr = skip_ocr
cli.main()
"""


def load(path):
    return json.loads(path.read_text())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--library", type=Path, default=Path(".runtime/library"))
    parser.add_argument("--python", type=Path, required=True, help="Isolated environment Python")
    parser.add_argument("--output", type=Path, required=True, help="New output directory")
    args = parser.parse_args()
    library, python, output = args.library.resolve(), args.python.absolute(), args.output.resolve()
    papers = load(library / "index.json")["papers"]
    selected = [next(p for p in papers if p["arxivId"] == aid) for aid in PAPER_IDS]
    output.mkdir(parents=True, exist_ok=False)  # Preserve previous run evidence.
    (output / "selection.json").write_text(json.dumps(selected, indent=2, ensure_ascii=False) + "\n")
    summaries = []
    for paper in selected:
        name = paper["arxivId"]
        directory = output / name
        directory.mkdir()
        env = {
            **os.environ,
            "PDF_TO_JSON_RAG_DATA_DIR": str(directory / "data"),
            "PDF_TO_JSON_RAG_PDF_INSPECTOR_MODE": "assist",
            "PDF_TO_JSON_RAG_EMBEDDING_BACKEND": "hash",
            "PDF_TO_JSON_RAG_USE_SENTENCE_TRANSFORMERS": "0",
            "PDF_TO_JSON_RAG_USE_CROSS_ENCODER": "0",
            "PDF_TO_JSON_RAG_SEMANTIC_MULTIPASS": "0",
            "HF_HUB_OFFLINE": "1",
            "ANONYMIZED_TELEMETRY": "False",
        }
        for key in ["PDF_TO_JSON_RAG_LLM_COMMAND", "PDF_TO_JSON_RAG_JUDGE_COMMAND"]:
            env.pop(key, None)
        command = [str(python), "-c", ASSESS, "assess-pdf", "--pdf",
                   str(library / "papers" / paper["id"] / "original.pdf"),
                   "--json", "--verbose", "--output", str(directory / "assessment.json")]
        start = time.perf_counter()
        with (directory / "assessment.log").open("w") as log:
            subprocess.run(command, env=env, stdout=log, stderr=log, check=True)
        elapsed = round(time.perf_counter() - start, 3)
        assessment = load(directory / "assessment.json")["result"]
        document = load(directory / "data/documents/original.document.json")
        native = load(directory / "data/documents/original.native.json")
        chunks = [load(p) for p in sorted((directory / "data/chunks/original").glob("*.json"))]
        inspector = native["pdf_inspector"]
        if inspector["status"] != "ok":
            raise RuntimeError(f"{name}: pdf-inspector inactive: {inspector}")
        assert not any(p["ocr_used"] for p in native["pages"]), "OCR must remain disabled"
        assert all(c["page_start"] >= 1 and c["page_end"] <= document["page_count"] for c in chunks)
        pages = [{"page": p["page_num"] + 1, "characters": p["char_count"],
                  "needs_ocr": p["needs_ocr"], "ocr_used": p["ocr_used"]} for p in native["pages"]]
        (directory / "pages.json").write_text(json.dumps(pages, indent=2) + "\n")
        (directory / "text.txt").write_text("\n\n".join(
            f'=== Page {p["page_num"] + 1} ===\n{p["text"]}' for p in native["pages"]) + "\n")
        (directory / "sections.tsv").write_text("page\tlevel\ttitle\n" + "".join(
            f'{s["page_start"]}\t{s["level"]}\t{s["title"]}\n' for s in document["sections"]))
        summary = {
            "arxiv_id": name, "title": paper["title"], "extracted_title": document["title"],
            "seconds": elapsed, "pages": document["page_count"],
            "characters": sum(p["char_count"] for p in native["pages"]),
            "toc_items": len(document["toc"]), "sections": len(document["sections"]),
            "chunks": len(chunks), "overall_status": assessment["overall_status"],
            "ocr_requested_pages": [p["page"] for p in pages if p["needs_ocr"]],
            "inspector_ocr_pages": inspector["pages_needing_ocr"],
            "ocr_processed_pages": [], "inspector": inspector,
            "extraction_summary": document["extraction_summary"],
            "chunk_characters_min": min(len(c["text"]) for c in chunks),
            "chunk_characters_median": sorted(len(c["text"]) for c in chunks)[len(chunks) // 2],
            "chunk_characters_max": max(len(c["text"]) for c in chunks),
        }
        summaries.append(summary)
        print(f'{name}: {summary["pages"]} pages, {summary["sections"]} sections, '
              f'{summary["chunks"]} chunks, {elapsed}s', flush=True)
        (output / "summary.json").write_text(json.dumps(summaries, indent=2, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    main()
