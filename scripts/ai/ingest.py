"""Local PDF intake. Provenance comes from Docling's page objects, not a model's
guess about where a passage originated. Each conversion gets a fresh directory;
a failed conversion cannot overwrite an earlier reviewed document.
"""
import argparse
import csv
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import time

os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
os.environ.setdefault("DO_NOT_TRACK", "1")

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--ocr", action="store_true")
    parser.add_argument("--offline", action="store_true")
    parser.add_argument("--max-pages", type=int, default=200)
    args = parser.parse_args()
    if args.offline:
        os.environ["HF_HUB_OFFLINE"] = "1"
    source = args.source.resolve(strict=True)
    if not source.is_file() or source.suffix.lower() != ".pdf":
        raise ValueError("Intake accepts a local PDF file")
    if source.stat().st_size > 50 * 1024 * 1024:
        raise ValueError("PDF exceeds the 50 MB intake limit")
    if not 1 <= args.max_pages <= 200:
        raise ValueError("max-pages must be between 1 and 200")
    if args.out.exists() and any(args.out.iterdir()):
        raise ValueError("Output folder must be empty; choose a new folder")
    args.out.mkdir(parents=True, exist_ok=True)
    from docling.document_converter import DocumentConverter, PdfFormatOption
    from docling.datamodel.base_models import InputFormat, ConversionStatus
    from docling.datamodel.pipeline_options import PdfPipelineOptions, RapidOcrOptions
    from docling.datamodel.accelerator_options import AcceleratorOptions, AcceleratorDevice

    options = PdfPipelineOptions(
        do_ocr=args.ocr, do_table_structure=True,
        enable_remote_services=False, allow_external_plugins=False,
        do_picture_description=False, do_picture_classification=False,
        accelerator_options=AcceleratorOptions(num_threads=4, device=AcceleratorDevice.CPU),
        document_timeout=600,
    )
    if args.ocr:
        options.ocr_options = RapidOcrOptions(backend="torch")
    converter = DocumentConverter(allowed_formats=[InputFormat.PDF],
        format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=options)})
    begin = time.monotonic()
    result = converter.convert(source, max_num_pages=args.max_pages, max_file_size=50 * 1024 * 1024)
    if result.status != ConversionStatus.SUCCESS:
        raise RuntimeError(f"Conversion did not finish successfully: {result.status}; {result.errors}")
    document = result.document
    pages = []
    parts = [f"# {source.name}\n\nLocal PDF conversion. Check tables, reading order, and OCR against the source before relying on this text.\n"]
    page_dir = args.out / "pages"
    page_dir.mkdir(exist_ok=True)
    for number in sorted(document.pages):
        markdown = document.export_to_markdown(page_no=number)
        page_file = f"pages/page-{number:04d}.md"
        (args.out / page_file).write_text(f"# Source page {number}\n\n{markdown}\n")
        parts.append(f"## Source page {number}\n\n{markdown}\n")
        pages.append({"page": number, "markdown": page_file, "characters": len(markdown), "review": "pending"})
    (args.out / "document.md").write_text("\n".join(parts))
    (args.out / "document.json").write_text(json.dumps(document.export_to_dict(), indent=2) + "\n")
    manifest = {
        "version": 1, "source": source.name,
        "sourceSha256": hashlib.sha256(source.read_bytes()).hexdigest(),
        "doclingVersion": importlib.metadata.version("docling"),
        "pipeline": "standard-local-cpu", "ocr": args.ocr,
        "durationSeconds": round(time.monotonic() - begin, 2),
        "pageCount": len(pages), "pages": pages,
        "status": "converted; fidelity review pending",
    }
    (args.out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    with (args.out / "review.csv").open("w", newline="") as stream:
        writer = csv.writer(stream)
        writer.writerow(["page", "text_correct", "reading_order_correct", "tables_correct", "citation_correct", "notes"])
        for page in pages:
            writer.writerow([page["page"], "", "", "", "", ""])
    print(json.dumps({"output": str(args.out.resolve()), **{k: manifest[k] for k in ["pageCount", "durationSeconds", "status"]}}))

if __name__ == "__main__":
    main()
