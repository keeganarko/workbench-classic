import { beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { newTab, sessionIdsIn } from '../src/renderer/src/lib/layout.js'

// Exercise the actual launch actions without starting an agent or a PTY. The
// captured IPC payload is what main persists on the new Session, so these tests
// cover both the dialog default and creation paths that skip the dialog.
const launches=[]
globalThis.window={term:{
  setTabs:async()=>{},
  createSession:async opts=>{
    launches.push(opts)
    return {id:'created',agent:opts.agent,cwd:opts.cwd,sessionProjectId:opts.sessionProjectId??null,alive:true,lastActivityAt:100}
  },
  getState:async()=>({...state(),sessions:[...state().sessions,{id:'created',agent:launches.at(-1).agent,cwd:launches.at(-1).cwd,sessionProjectId:launches.at(-1).sessionProjectId??null,alive:true,lastActivityAt:100}]})
}}
const {useStore}=await import('../src/renderer/src/state/store.js')
const {actions}=await import('../src/renderer/src/lib/actions.js')
const state=()=>useStore.getState()
const projects=[{id:'mba',name:'MBA',defaultCwd:'C:\\MBA'},{id:'workbench',name:'Workbench',defaultCwd:'/work/workbench'},{id:'empty',name:'Empty',defaultCwd:'/work/empty'}]
const sessions=[{id:'mba-1',sessionProjectId:'mba',alive:true,lastActivityAt:10},{id:'wb-1',sessionProjectId:'workbench',alive:true,lastActivityAt:20},{id:'unfiled',sessionProjectId:null,alive:true,lastActivityAt:30}]
beforeEach(()=>{
  launches.length=0
  const tab=newTab('Original','mba-1')
  useStore.setState({...useStore.getInitialState(),sessions,sessionProjects:projects,tabs:[tab],activeTabId:tab.id,ready:true},true)
})
test('New terminal in All terminals inherits the focused MBA conversation',()=>{
  actions.openNewSession('codex')
  assert.equal(state().experienceProjectId,null)
  assert.equal(state().overlay.projectId,'mba')
})
test('a selected empty project wins over a previous conversation',()=>{
  state().navigateExperience('terminals','empty')
  actions.openNewSession('shell')
  assert.equal(state().overlay.projectId,'empty')
})
test('an explicit project wins over the current project default',()=>{
  state().navigateExperience('terminals','mba')
  actions.openNewSession('codex','workbench')
  assert.equal(state().overlay.projectId,'workbench')
})
test('an empty split inherits its single-project siblings',()=>{
  state().split('h')
  actions.openNewSession('codex')
  assert.equal(state().overlay.projectId,'mba')
})
test('an empty split in a mixed workspace does not guess a project',()=>{
  state().split('h','wb-1');state().split('v')
  actions.openNewSession('codex')
  assert.equal(state().overlay.projectId,undefined)
})
test('the focused conversation determines the default in a mixed workspace',()=>{
  state().split('h','wb-1')
  actions.openNewSession('codex')
  assert.equal(state().overlay.projectId,'workbench')
})
test('a new empty tab retains its source project in All terminals',()=>{
  state().addTab()
  assert.equal(state().activeTab().sessionProjectId,'mba')
  assert.deepEqual(sessionIdsIn(state().activeTab().layout),[])
  actions.openNewSession('shell')
  assert.equal(state().overlay.projectId,'mba')
})
test('quick launches persist the inherited project and its default folder',async()=>{
  await actions.createSession({agent:'shell',title:'npm run test'})
  assert.equal(launches[0].sessionProjectId,'mba')
  assert.equal(launches[0].cwd,'C:\\MBA')
  assert.equal(state().sessions.find(s=>s.id==='created').sessionProjectId,'mba')
})
test('an explicitly selected No project stays unfiled at creation',async()=>{
  state().navigateExperience('terminals','mba')
  await actions.createSession({agent:'shell',sessionProjectId:undefined,cwd:'/private/notes'})
  assert.equal(launches[0].sessionProjectId,undefined)
  assert.equal(launches[0].cwd,'/private/notes')
})
test('explicit project and worktree folder survive a conflicting default',async()=>{
  await actions.createSession({agent:'shell',sessionProjectId:'workbench',cwd:'/work/isolated',workspaceId:'ws-test'})
  assert.equal(launches[0].sessionProjectId,'workbench')
  assert.equal(launches[0].cwd,'/work/isolated')
  assert.equal(launches[0].workspaceId,'ws-test')
})
test('choosing No project from an owned tab keeps the new terminal visible after refresh',async()=>{
  state().addTab()
  await actions.createSession({agent:'shell',sessionProjectId:undefined,cwd:'/private/notes'})
  state().applyState({...state()})
  assert.ok(sessionIdsIn(state().activeTab().layout).includes('created'))
  assert.equal(state().activeTab().sessionProjectId,undefined)
})
test('choosing a different project from an owned tab keeps its assignment and pane',async()=>{
  state().addTab()
  await actions.createSession({agent:'shell',sessionProjectId:'workbench',cwd:'/work/workbench'})
  state().applyState({...state()})
  assert.ok(sessionIdsIn(state().activeTab().layout).includes('created'))
  assert.equal(state().sessions.find(s=>s.id==='created').sessionProjectId,'workbench')
})
test('focused unfiled sessions and removed projects are not silently reassigned',()=>{
  state().revealSession('unfiled')
  actions.openNewSession('codex')
  assert.equal(state().overlay.projectId,undefined)
  useStore.setState({sessions:[{...sessions[0],sessionProjectId:'deleted'}],sessionProjects:[]})
  state().revealSession('mba-1')
  actions.openNewSession('codex')
  assert.equal(state().overlay.projectId,undefined)
})
