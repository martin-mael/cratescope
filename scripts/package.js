'use strict';
// Packages CrateScope for one target and zips it into dist/.
// usage: node scripts/package.js <darwin|win32> <arm64|x64>
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const [platform = process.platform, arch = process.arch] = process.argv.slice(2);
const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist');
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', cwd: root, ...opts });

run('sh', ['scripts/fetch-ffmpeg.sh', platform, arch]);
const vendor = path.join('vendor', `${platform}-${arch}`, 'ffmpeg');
if (platform === 'darwin') {
  for (const f of ['ffmpeg', 'ffprobe']) run('codesign', ['--force', '-s', '-', path.join(vendor, f)]);
}

run('npx', ['electron-packager', '.', 'CrateScope',
  `--platform=${platform}`, `--arch=${arch}`,
  `--icon=build/icon.${platform === 'darwin' ? 'icns' : 'ico'}`,
  '--out=dist', '--overwrite', '--no-asar',
  `--extra-resource=${vendor}`,
  '--app-bundle-id=com.maelmartin.cratescope',
  '--win32metadata.CompanyName=CrateScope', '--win32metadata.FileDescription=CrateScope', '--win32metadata.ProductName=CrateScope',
  '--ignore=^/dist', '--ignore=^/build', '--ignore=^/scripts', '--ignore=^/vendor', '--ignore=^/\\.github', '--ignore=smoke\\.js',
]);

const out = path.join(dist, `CrateScope-${platform}-${arch}`);
const label = platform === 'darwin' ? 'macos' : 'windows';
const zip = path.join(dist, `CrateScope-${label}-${arch}.zip`);
fs.rmSync(zip, { force: true });
if (platform === 'darwin') {
  const app = path.join(out, 'CrateScope.app');
  run('codesign', ['--force', '--deep', '-s', '-', app]);
  run('ditto', ['-c', '-k', '--keepParent', app, zip]);
} else {
  run('zip', ['-qry', zip, path.basename(out)], { cwd: dist });
}
console.log('built', zip);
