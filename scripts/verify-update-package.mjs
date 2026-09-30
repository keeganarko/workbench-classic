/** Validate the real native package before a release becomes downloadable.
 * Mac staging uses an isolated installation and stops before process handoff;
 * neither the runner's applications nor a user's Workbench is replaced. */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { prepareMacUpdate } from '../src/main/updateMac.js'
import { windowsSignature, windowsInstallerTrust } from '../src/main/updateWindows.js'
const arch=process.env.RELEASE_ARCH || process.arch
const descriptor=JSON.parse(await fs.readFile(`release/update-assets/asset-${process.platform}-${arch}.json`,'utf8'))
const file=path.resolve('release/update-assets',new URL(descriptor.url).pathname.split('/').at(-1))
if(process.platform==='darwin') {
 const home=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'workbench-native-update-')))
 let safeToRemove=false
 try {
  const app=path.join(home,'Applications','Workbench.app')
  await fs.mkdir(path.dirname(app),{recursive:true})
  await fs.cp(path.resolve('release',arch==='arm64'?'mac-arm64':'mac','Workbench.app'),app,{recursive:true,verbatimSymlinks:true})
  const prepared=await prepareMacUpdate({file,asset:descriptor,executable:path.join(app,'Contents','MacOS','Workbench'),pid:process.pid,logDirectory:path.join(home,'updates')},{homeDirectory:home})
  await prepared.cleanup()
  safeToRemove=true
  assert.ok(await fs.stat(app))
  console.log('PASS native DMG: SHA512, mount, staged bundle identity/version/architecture and code integrity; original app preserved.')
 } finally {if(safeToRemove) await fs.rm(home,{recursive:true,force:true})}
} else if(process.platform==='win32') {
 const executable=path.resolve('release',arch==='arm64'?'win-arm64-unpacked':'win-unpacked','Workbench.exe')
 assert.equal(windowsInstallerTrust(await windowsSignature(executable),await windowsSignature(file),descriptor.signer),true)
 console.log('PASS native Windows package: installed executable and installer have compatible signing states.')
} else throw new Error('Use a native Mac or Windows runner')
