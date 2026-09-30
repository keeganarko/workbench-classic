/**
 * This is an exportable demonstration document, not a second application or a
 * server. It contains only our explicitly authored CC0 samples. Search results
 * are computed when the file is made and labelled as saved results; the browser
 * never pretends to run a live model. The PDF is a deterministic smoke fixture,
 * whose checks deliberately stop short of claiming real-document fidelity.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { configuration, writeJson, readJson, csv, html, jsonForHtml, hash } from './core.mjs'
import { buildIndex, search } from './search.mjs'

export const sampleQuestions = [
  'Who owns this project and what is its first milestone?',
  'What happens to citations when a source document changes?',
  'What files does PDF intake produce?',
  'Has public hosting been approved?'
]
export async function makeDemo(repo, out, { lexicalOnly = false, progress = () => {} } = {}) {
  const root = path.join(repo, 'ai/fixtures/demo')
  const configFile = path.join(out, 'sample-config.json')
  await writeJson(configFile, { version: 1, include: ['.'], exclude: [], extensions: ['.md'], respectGitIgnore: false })
  const ctx = await configuration(root, configFile)
  await buildIndex(ctx, { lexicalOnly, progress })
  const examples = []
  for (const query of sampleQuestions) examples.push(await search(ctx, query, { mode: lexicalOnly ? 'lexical' : 'hybrid', limit: 3 }))
  await fs.mkdir(path.join(out, 'samples'), { recursive: true })
  for (const file of ['project.md', 'access.md', 'intake.md']) await fs.copyFile(path.join(root, file), path.join(out, 'samples', file))
  await writeJson(path.join(out, 'saved-searches.json'), examples)
  const data = { generatedAt: new Date().toISOString(), examples }
  const page = '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Workbench local AI — sample demo</title><style>' +
    '*{box-sizing:border-box}body{margin:0;background:#f5f5f3;color:#161616;font:16px/1.55 system-ui,sans-serif}main{max-width:1120px;margin:auto;padding:48px 28px}header{border-bottom:2px solid;padding-bottom:30px}small,.muted{color:#626262}h1{font-size:clamp(32px,5vw,58px);line-height:1.06;letter-spacing:-.04em;margin:16px 0}h2{font-size:24px;letter-spacing:-.025em}.eyebrow{font:12px monospace;letter-spacing:.12em;text-transform:uppercase}.pill{display:inline-block;border:1px solid;border-radius:20px;padding:4px 12px;font-size:12px}.grid{display:grid;grid-template-columns:1fr 1.7fr;gap:32px;margin:32px 0}button{display:block;text-align:left;width:100%;padding:15px;margin:10px 0;background:white;color:#161616;border:1px solid #ccc;border-radius:6px;font:inherit;cursor:pointer}button:hover,button[aria-pressed=true]{background:#171717;color:white;border-color:#171717}button:focus-visible,textarea:focus-visible{outline:3px solid #777;outline-offset:3px}.result{padding:20px;background:#fff;border:1px solid #ddd;border-radius:8px;margin:12px 0}.result h3{font-size:17px;margin:0 0 10px}.result pre{font:14px/1.55 system-ui;white-space:pre-wrap;margin:0}.flow{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}.step{padding:18px;border:1px solid #ccc;border-radius:6px}.step strong{display:block}textarea{width:100%;min-height:110px;font:inherit;padding:12px;border:1px solid #aaa;border-radius:6px}.footer{border-top:1px solid #aaa;margin-top:32px;padding-top:20px;font-size:13px}#copy{width:auto}details{margin:22px 0}summary{cursor:pointer}#status{min-height:1.5em}@media(max-width:740px){main{padding:26px 18px}.grid{grid-template-columns:1fr}.flow{grid-template-columns:1fr 1fr}}@media print{button,textarea,#copy,#status{display:none}main{padding:0}.result{break-inside:avoid}}' +
    '</style><main><header><div class="eyebrow">Workbench / local AI prototype / sample content</div><h1>Find the source.<br>Make the next decision.</h1><p>Choose a sample question and inspect the passages returned by the local search tool.</p><span class="pill">No live inference in this document</span> <span class="pill">No network requests</span></header>' +
    '<section class="grid"><div><h2>Try the project library</h2><p class="muted">These searches were run when this demo was generated. Every record is invented sample content.</p><div id="questions"></div><p class="muted" id="timing"></p></div><div><h2 id="query"></h2><div id="results" aria-live="polite"></div></div></section>' +
    '<section><div class="eyebrow">Four connected capabilities</div><h2>A local path from documents to evidence</h2><div class="flow"><div class="step"><strong>01 / Intake</strong>PDF to Markdown and page references.</div><div class="step"><strong>02 / Search</strong>Retrieve passages from selected folders.</div><div class="step"><strong>03 / Evaluate</strong>Compare quality and measured latency.</div><div class="step"><strong>04 / Demonstrate</strong>Review a portable sample package.</div></div></section>' +
    '<details><summary>What this prototype has and has not demonstrated</summary><p>The command-line tools execute local retrieval, PDF conversion, and structured-task evaluation. This document demonstrates saved search results on three sample files. Real-document fidelity, an independently reviewed retrieval set, a current-assistant comparison, and feedback from five testers remain separate acceptance work. It is not a native sidebar feature or a deployed service.</p></details>' +
    '<section><h2>Five-minute review</h2><p>Find the owner. Find what happens after a source changes. Explain which page to check after converting a PDF.</p><label for="feedback">Record completed tasks, any help needed, and one confusing moment.</label><textarea id="feedback" placeholder="Reviewer ID (no personal data needed), completed tasks, assistance, notes"></textarea><button id="copy">Prepare feedback text</button><pre id="status" aria-live="polite"></pre></section>' +
    '<div class="footer">Generated <span id="date"></span>. Sample content: CC0. Share only this generated package after review. No data is submitted; feedback remains on this page unless you copy it.</div></main><script>' +
    'const data=' + jsonForHtml(data) + ';const $=id=>document.getElementById(id);$("date").textContent=data.generatedAt;function select(i){const e=data.examples[i];$("query").textContent=e.query;$("timing").textContent="Saved "+e.mode+" search · "+e.durationMs+" ms at generation time";$("results").replaceChildren();e.hits.forEach((hit,n)=>{const card=document.createElement("article");card.className="result";const title=document.createElement("h3");title.textContent=(n+1)+". "+hit.citation;const body=document.createElement("pre");body.textContent=hit.text;card.append(title,body);$("results").append(card)});[...$("questions").children].forEach((b,j)=>b.setAttribute("aria-pressed",String(i===j)))}data.examples.forEach((e,i)=>{const b=document.createElement("button");b.textContent=e.query;b.addEventListener("click",()=>select(i));$("questions").append(b)});$("copy").addEventListener("click",()=>{$("status").textContent=["Sample demo review",$("feedback").value,"No feedback has been sent."].join(String.fromCharCode(10));});select(0);' +
    '</script></html>'
  await fs.writeFile(path.join(out, 'demo.html'), page)
  await fs.writeFile(path.join(out, 'feedback.csv'), csv([['reviewer_id', 'owner_task_unaided', 'stale_source_task_unaided', 'intake_task_unaided', 'notes'], ...Array.from({ length: 5 }, (_, i) => ['reviewer-' + (i + 1), '', '', '', ''])]))
  await fs.writeFile(path.join(out, 'walkthrough.md'), '# Local AI demo walkthrough\n\nThis package contains invented CC0 samples and saved local search results. Open demo.html in Workbench. No server or model is needed to view it.\n\n1. Ask the reviewer to identify the project owner.\n2. Ask what happens after a source file changes.\n3. Ask what PDF intake produces and how to verify a page citation.\n4. Record completion and any help in feedback.csv.\n\nRecruitment and distribution are pending the owner’s choice. The target is at least three of five reviewers completing the tasks unaided; no reviewer results have been collected. The demo uses sample data only. Live queries use the search command in the project terminal.\n')
  return { output: out, document: path.join(out, 'demo.html'), questions: examples.length, mode: lexicalOnly ? 'lexical' : 'hybrid', status: 'sample package ready for internal review; user acceptance pending' }
}
export function fixturePdf() {
  const pages = [], expected = []
  const escape = text => text.replace(/[\\()]/g, '\\$&')
  for (let i = 1; i <= 20; i++) {
    const record = 'DEMO-' + String(i).padStart(3, '0')
    const owner = ['Mina', 'Sol', 'Ari', 'Jo', 'Lee'][(i - 1) % 5]
    const budget = String(1000 + i * 100)
    const layout = i <= 5 ? 'paragraph' : i <= 10 ? 'table' : i <= 15 ? 'two-column' : 'checklist'
    let content = ''
    const text = (x, y, size, value) => { content += 'BT /F1 ' + size + ' Tf ' + x + ' ' + y + ' Td (' + escape(value) + ') Tj ET\n' }
    text(54, 744, 18, 'Atlas intake specimen / page ' + i)
    text(54, 716, 10, 'SAMPLE ONLY - invented CC0 records - layout: ' + layout)
    if (layout === 'table') {
      for (const y of [670, 638, 606, 574]) content += '54 ' + y + ' m 540 ' + y + ' l S\n'
      for (const x of [54, 240, 540]) content += x + ' 574 m ' + x + ' 670 l S\n'
      text(64, 650, 12, 'Record'); text(252, 650, 12, record)
      text(64, 618, 12, 'Owner'); text(252, 618, 12, owner)
      text(64, 586, 12, 'Budget'); text(252, 586, 12, budget + ' USD')
    } else if (layout === 'two-column') {
      text(54, 666, 13, 'Record ' + record); text(318, 666, 13, 'Budget ' + budget + ' USD')
      text(54, 642, 12, 'Owner ' + owner); text(318, 642, 12, 'Review status: pending')
      text(54, 610, 11, 'Check the source passage.'); text(318, 610, 11, 'Preserve the page reference.')
    } else {
      text(54, 666, 13, (layout === 'checklist' ? '1. ' : '') + 'Record ' + record)
      text(54, 638, 12, (layout === 'checklist' ? '2. ' : '') + 'Owner ' + owner)
      text(54, 610, 12, (layout === 'checklist' ? '3. ' : '') + 'Budget ' + budget + ' USD')
      text(54, 570, 11, 'The prototype keeps a source page reference for every extracted page.')
      text(54, 546, 11, 'This sample does not test scanned text, handwriting, or equations.')
    }
    text(54, 50, 10, 'Source page ' + i + ' / generated fixture / not a customer document')
    pages.push(content)
    expected.push({ page: i, layout, required: [record, owner, budget] })
  }
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']
  const kids = []
  for (const content of pages) {
    const pageNo = objects.length + 1, streamNo = pageNo + 1
    kids.push(pageNo + ' 0 R')
    objects.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ' + streamNo + ' 0 R >>')
    objects.push('<< /Length ' + Buffer.byteLength(content) + ' >>\nstream\n' + content + 'endstream')
  }
  objects[1] = '<< /Type /Pages /Kids [' + kids.join(' ') + '] /Count 20 >>'
  let pdf = '%PDF-1.4\n', offsets = [0]
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += (i + 1) + ' 0 obj\n' + object + '\nendobj\n' })
  const xref = Buffer.byteLength(pdf)
  pdf += 'xref\n0 ' + (objects.length + 1) + '\n0000000000 65535 f \n' + offsets.slice(1).map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('') + 'trailer\n<< /Size ' + (objects.length + 1) + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n'
  return { pdf: Buffer.from(pdf), expected }
}
export async function makeFixturePdf(out) {
  const { pdf, expected } = fixturePdf()
  await fs.writeFile(path.join(out, 'intake-specimen.pdf'), pdf)
  await writeJson(path.join(out, 'expected.json'), { sourceSha256: hash(pdf), pages: expected })
  return { output: path.join(out, 'intake-specimen.pdf'), pages: 20, layouts: ['paragraph', 'table', 'two-column', 'checklist'], status: 'born-digital synthetic smoke fixture' }
}
export async function checkIntake(input, out) {
  const manifest = await readJson(path.join(input, 'manifest.json'))
  const fixture = fixturePdf()
  if (manifest.sourceSha256 !== hash(fixture.pdf)) throw new Error('This automatic check is only for the generated intake specimen; use review.csv for real documents')
  const rows = []
  for (const page of fixture.expected) {
    const entry = manifest.pages.find(p => p.page === page.page)
    const markdown = entry ? await fs.readFile(path.join(input, entry.markdown), 'utf8') : ''
    const missing = page.required.filter(term => !markdown.includes(term))
    rows.push({ page: page.page, layout: page.layout, pass: Boolean(entry) && missing.length === 0, missing })
  }
  const result = { pages: rows.length, passed: rows.filter(r => r.pass).length, pageCountCorrect: manifest.pageCount === rows.length, scope: 'token presence and page mapping only; human fidelity review pending', rows }
  await writeJson(path.join(out, 'intake-check.json'), result)
  await fs.writeFile(path.join(out, 'intake-check.csv'), csv([['page', 'layout', 'required_tokens_found_on_correct_page', 'missing'], ...rows.map(r => [r.page, r.layout, r.pass, r.missing.join(' | ')])]))
  await fs.writeFile(path.join(out, 'intake-check.md'), '# Document intake smoke check\n\n' + result.passed + '/' + result.pages + ' generated pages retained the required record, owner, and budget on the corresponding source page. Page count correct: ' + result.pageCountCorrect + '.\n\nThe specimen covers paragraphs, simple tables, two columns, and checklists with selectable English text. This does not measure visual table fidelity, OCR, handwriting, equations, or representative customer documents. The per-page review.csv remains available for human review.\n')
  return { pages: result.pages, passed: result.passed, pageCountCorrect: result.pageCountCorrect, scope: result.scope, output: out }
}
