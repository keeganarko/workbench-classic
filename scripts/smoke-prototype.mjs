/**
 * Exercises the already-running native desktop app through its temporary
 * loopback debugger. It never opens a browser, installs a dependency, or starts
 * an agent. The explicit flag permits one paused task and project fixture;
 * both are removed in finally. Restart without the debug flag after testing.
 *
 * Usage: node scripts/smoke-prototype.mjs --fixtures [--screenshot=/tmp/home.png]
 * Launch Electron with --remote-debugging-address=127.0.0.1
 * and --remote-debugging-port=9322 for this check only.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'

const port = Number(process.env.WORKBENCH_DEBUG_PORT ?? 9322)
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const target = targets.find((page) => page.type === 'page' && /^Workbench (Prototype|Beta)$/.test(page.title) && /WorkbenchPrototype/.test(page.url))
assert.ok(target, 'Only an explicitly titled, staged Workbench build may be tested')
const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
let sequence = 0
const pending = new Map(), errors = []
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text)
  if (message.id && pending.has(message.id)) {
    const { resolve, reject, timeout } = pending.get(message.id)
    pending.delete(message.id); clearTimeout(timeout)
    if (message.error) reject(new Error(message.error.message)); else resolve(message.result)
  }
})
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`Timed out: ${method}`)) }, 15000)
    pending.set(id, { resolve, reject, timeout }); socket.send(JSON.stringify({ id, method, params }))
  })
}
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
  return result.result.value
}
async function waitFor(expression) {
  for (let attempt = 0; attempt < 75; attempt++) {
    if (await evaluate(expression)) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`UI condition did not arrive: ${expression}`)
}
async function clickText(selector, text) {
  await evaluate(`(() => { const button = [...document.querySelectorAll(${JSON.stringify(selector)})].find(b => b.textContent.trim() === ${JSON.stringify(text)}); if (!button) throw new Error('Button not found: ' + ${JSON.stringify(text)}); button.click() })()`)
}
async function type(selector, value) {
  await evaluate(`(() => { const field = document.querySelector(${JSON.stringify(selector)}); if (!field) throw new Error('Field missing'); const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(field, ${JSON.stringify(value)}); field.dispatchEvent(new Event('input', { bubbles: true })); })()`)
}
let projectId, taskId, previousProject
const results = []
try {
  await send('Runtime.enable')
  await waitFor(`!!document.querySelector('.px-brand')`)
  const initialIds = await evaluate(`window.term.getState().then(s => s.sessions.map(x => x.id).sort())`)
  previousProject = await evaluate(`document.querySelector('.px-projectnav .is-active')?.title ?? null`)
  await evaluate(`document.querySelector('.px-brand').click()`)
  await waitFor(`document.querySelector('.px-heading h1').textContent.includes('room to think')`)
  results.push('Real project-first home rendered')
  if (process.argv.includes('--fixtures')) {
    const name = `Beta UI check ${Date.now()}`
    await evaluate(`document.querySelector('.px-nav-new').click()`)
    await waitFor(`!!document.querySelector('.modal input')`)
    await type('.modal input', name)
    const folder = await evaluate('window.term.defaultProjectFolder()')
    await type('.modal input.mono', folder)
    await evaluate(`document.querySelector('.modal .btn--primary').click()`)
    await waitFor(`!document.querySelector('.modal')`)
    projectId = await evaluate(`window.term.getState().then(s => s.sessionProjects.find(p => p.name === ${JSON.stringify(name)})?.id)`)
    assert.ok(projectId)
    results.push('Project created through the desktop form')
    await clickText('.px-tabs button', 'Context')
    await type('.px-contextgrid textarea[rows="2"]', 'Temporary UI verification')
    await type('.px-contextgrid textarea[rows="9"]', 'Only used by the UI test project. Do not start agent work.')
    await evaluate(`document.querySelector('.px-contextgrid form').requestSubmit()`)
    await waitFor(`window.term.getState().then(s => !!s.experience.projectDetails[${JSON.stringify(projectId)}]?.instructions)`)
    results.push('Project context persisted')
    await clickText('.px-tabs button', 'Scheduled')
    await clickText('.px-sectiontitle button', 'New task →')
    await waitFor(`!!document.querySelector('.px-taskdialog')`)
    await type('.px-taskdialog input:not([type])', 'Paused UI check')
    await type('.px-taskdialog textarea', 'This task must stay paused; never execute it.')
    assert.equal(await evaluate(`document.querySelector('.px-taskdialog input[type=checkbox]').checked`), false)
    await evaluate(`document.querySelector('.px-taskdialog').requestSubmit()`)
    await waitFor(`!document.querySelector('.px-taskdialog')`)
    taskId = await evaluate(`window.term.getState().then(s => s.experience.tasks.find(t => t.projectId === ${JSON.stringify(projectId)})?.id)`)
    assert.ok(taskId)
    const saved = await evaluate(`window.term.getState().then(s => s.experience.tasks.find(t => t.id === ${JSON.stringify(taskId)}))`)
    assert.equal(saved.enabled, false)
    assert.ok(await evaluate(`document.querySelector('.px-hostnotice').textContent.includes('must be open')`))
    results.push('Paused schedule persisted with local-host disclosure; no agent launched')
  }
  await evaluate(`[...document.querySelectorAll('.px-navigation button')].find(b => b.querySelector('span')?.textContent === 'All terminals').click()`)
  await waitFor(`!document.querySelector('.px-terminalview').hidden`)
  assert.ok(await evaluate(`!!document.querySelector('.xterm')`), 'Existing xterm panes are mounted')
  await evaluate(`window.__prototypeTerminalCheck = document.querySelector('.xterm')`)
  await type('.px-search input', 'NO_MATCH_FOR_SMOKE_CHECK_842891')
  await waitFor(`document.querySelectorAll('.px-sessionlist .px-session').length === 0`)
  await type('.px-search input', '')
  await evaluate(`[...document.querySelectorAll('.px-navigation button')].find(b => b.querySelector('span')?.textContent === 'Home').click()`)
  await waitFor(`document.querySelector('.px-terminalview').hidden`)
  assert.ok(await evaluate(`window.__prototypeTerminalCheck === document.querySelector('.xterm')`), 'Home did not unmount xterm')
  results.push('Terminal filters work; home navigation preserves mounted xterm')
  assert.deepEqual(await evaluate(`window.term.getState().then(s => s.sessions.map(x => x.id).sort())`), initialIds)
  results.push('All original session IDs retained')
} finally {
  if (taskId) await evaluate(`window.term.removeTask(${JSON.stringify(taskId)})`)
  if (projectId) await evaluate(`window.term.removeProject(${JSON.stringify(projectId)})`)
  await evaluate(`delete window.__prototypeTerminalCheck`)
  await evaluate(`[...document.querySelectorAll('.px-navigation button')].find(b => b.querySelector('span')?.textContent === 'Home')?.click()`)
  const screenshot = process.argv.find((arg) => arg.startsWith('--screenshot='))?.slice(13)
  if (screenshot) {
    const capture = await send('Page.captureScreenshot', { format: 'png' })
    fs.writeFileSync(screenshot, Buffer.from(capture.data, 'base64'))
  }
  if (previousProject) await evaluate(`([...document.querySelectorAll('.px-projectnav button')].find(b => b.title === ${JSON.stringify(previousProject)}))?.click()`)
  socket.close()
}
assert.deepEqual(errors, [], 'Renderer produced no unhandled exceptions during the check')
console.log(JSON.stringify({ passed: results, rendererErrors: errors }, null, 2))
