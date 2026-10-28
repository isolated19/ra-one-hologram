/**
 * Starts Electron for the npm scripts. Clears ELECTRON_RUN_AS_NODE, which VS Code sets for
 * processes it launches and which would make electron.exe run as plain Node.
 * Extra args pass through: node desktop/launch.cjs --hidden
 */
const { spawn } = require('node:child_process');
const path = require('node:path');
const electron = require('electron'); // path to electron.exe when required from Node

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electron, [path.join(__dirname, '..'), ...process.argv.slice(2)], {
  env,
  stdio: 'inherit',
  windowsHide: false,
});
child.on('exit', (code) => process.exit(code ?? 0));
