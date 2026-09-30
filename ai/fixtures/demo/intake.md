# Atlas — sample document workflow

This is invented demonstration content, dedicated to CC0.

The document intake tool accepts local PDF files. The first pilot uses English documents with selectable text. Optional OCR supports scanned pages, but OCR accuracy requires a separate review.

Each successful conversion writes a combined Markdown document, one Markdown file per source page, structured document JSON, and a review spreadsheet. The original source hash is recorded so reviewers can identify the exact input.

The review checklist covers text fidelity, reading order, tables, and page citations. Twenty generated sample pages exercise the tool; they do not replace a review of representative user documents.

A failed or partial conversion is reported as an error. A new output folder keeps previous reviewed conversions intact.
