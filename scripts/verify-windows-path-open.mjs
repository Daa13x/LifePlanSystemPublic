#!/usr/bin/env node
// Verify the shell-free "open folder in Explorer" helper (Bug 4):
//   1. Windows path normalization preserves drive letters, underscores, spaces,
//      parentheses, portable/installed layouts; fixes mixed slashes and trailing
//      separators; never emits a malformed "D:_Code_" (missing drive backslash).
//   2. explorer.exe launches with the folder as a SEPARATE argument (no shell
//      string) and a successful SPAWN is success even though explorer exits
//      non-zero; a spawn error is a real failure.
//   3. Missing / non-directory targets raise an actionable error with the path.
//
// Uses path.win32 + injected fake fs/spawn so it is deterministic on any OS and
// never opens a real window. Exit 0 = pass.

import path from 'node:path';
import { EventEmitter } from 'node:events';
import { normalizeFolderPath, resolveExistingFolder, openFolderInExplorer } from '../server/openFolder.js';

let failures = 0;
const line = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'}  ${msg}`); };
const win = path.win32;
const dirFs = { statSync: () => ({ isDirectory: () => true }) };
const missingFs = { statSync: () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); } };
const fileFs = { statSync: () => ({ isDirectory: () => false }) };

console.log('--- windows path + explorer-open verification ---');

// 1. Normalization (Windows semantics).
{
  const cases = [
    ['C:\\Program Files\\LifePlanSystem\\app\\browser-extension\\lps-browser-agent', 'C:\\Program Files\\LifePlanSystem\\app\\browser-extension\\lps-browser-agent', 'Program Files with space'],
    ['D:\\_Code_\\lps.safety-probe\\release-1.0-install\\app\\browser-extension\\lps-browser-agent', 'D:\\_Code_\\lps.safety-probe\\release-1.0-install\\app\\browser-extension\\lps-browser-agent', 'underscored drive path keeps D:\\ backslash'],
    ['D:/_Code_/lps/app/browser-extension/lps-browser-agent', 'D:\\_Code_\\lps\\app\\browser-extension\\lps-browser-agent', 'mixed forward slashes normalized'],
    ['C:\\Users\\alex (dev)\\LifePlanSystem\\browser-extension\\', 'C:\\Users\\alex (dev)\\LifePlanSystem\\browser-extension', 'parentheses + trailing separator trimmed'],
    ['E:\\Portable\\LifePlannerPortable\\app\\browser-extension\\lps-browser-agent', 'E:\\Portable\\LifePlannerPortable\\app\\browser-extension\\lps-browser-agent', 'portable layout']
  ];
  for (const [input, expected, label] of cases) {
    const got = normalizeFolderPath(input, win);
    line(got === expected, `${label}: ${JSON.stringify(got)}`);
    line(/^[A-Za-z]:\\/.test(got), `${label}: result is an absolute drive path (has "X:\\")`);
    line(!/^[A-Za-z]:[^\\]/.test(got), `${label}: no malformed drive-relative "X:foo"`);
  }
  // Building from a valid root always yields a valid absolute path (the fix at
  // the source of browserAgentExtensionDir).
  const built = win.resolve('D:\\_Code_\\lps.safety-probe\\release-1.0-install\\app', 'browser-extension', 'lps-browser-agent');
  line(built === 'D:\\_Code_\\lps.safety-probe\\release-1.0-install\\app\\browser-extension\\lps-browser-agent', `resolve(root, …) yields valid path -> ${built}`);
  // Empty input is rejected, not silently opened.
  try { normalizeFolderPath('', win); line(false, 'empty path should throw'); }
  catch { line(true, 'empty path rejected'); }
}

// 2. resolveExistingFolder validation.
{
  const { resolved } = resolveExistingFolder('C:\\x\\browser-extension', { fsImpl: dirFs, pathImpl: win });
  line(resolved === 'C:\\x\\browser-extension', 'existing directory resolves');
  try { resolveExistingFolder('C:\\missing', { fsImpl: missingFs, pathImpl: win }); line(false, 'missing dir should throw'); }
  catch (e) { line(/does not exist: C:\\missing/.test(e.message), `missing dir -> ${e.message}`); }
  try { resolveExistingFolder('C:\\afile', { fsImpl: fileFs, pathImpl: win }); line(false, 'file should throw'); }
  catch (e) { line(/not a directory: C:\\afile/.test(e.message), `non-directory -> ${e.message}`); }
}

// 3. Explorer launch semantics with a fake spawn.
function fakeSpawn(record, mode) {
  return (file, args, opts) => {
    record.file = file; record.args = args; record.opts = opts;
    const ee = new EventEmitter();
    process.nextTick(() => {
      if (mode === 'error') { ee.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })); return; }
      ee.emit('spawn');
      ee.emit('exit', 1, null); // explorer's normal non-zero exit — must be ignored
    });
    return ee;
  };
}
{
  const rec = {};
  const opened = await openFolderInExplorer('D:/_Code_/lps/app/browser-extension/lps-browser-agent', { spawnImpl: fakeSpawn(rec, 'ok'), fsImpl: dirFs, pathImpl: win });
  line(opened === 'D:\\_Code_\\lps\\app\\browser-extension\\lps-browser-agent', `open returns normalized path -> ${opened}`);
  line(rec.file === 'explorer.exe', 'launches explorer.exe');
  line(Array.isArray(rec.args) && rec.args.length === 1 && rec.args[0] === opened, 'folder passed as a single separate argument (no shell string)');
  line(rec.opts && rec.opts.windowsHide === true, 'spawned with windowsHide (shell-free)');

  let threw = false;
  try { await openFolderInExplorer('C:\\x\\browser-extension', { spawnImpl: fakeSpawn({}, 'error'), fsImpl: dirFs, pathImpl: win }); }
  catch (e) { threw = /ENOENT/.test(e.message); }
  line(threw, 'a real spawn error rejects (only genuine failures fail)');

  let missingThrew = false;
  try { await openFolderInExplorer('C:\\missing', { spawnImpl: fakeSpawn({}, 'ok'), fsImpl: missingFs, pathImpl: win }); }
  catch (e) { missingThrew = /does not exist/.test(e.message); }
  line(missingThrew, 'missing folder rejects before spawning');
}

console.log(`\n${failures === 0 ? 'ALL PASS - Explorer opens the normalized folder shell-free; explorer exit codes are tolerated; bad paths fail loudly.' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
