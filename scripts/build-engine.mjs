import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const engineEntry = path.join(rootDir, 'packages', 'engine', 'src', 'index.ts');
const outCjs = path.join(rootDir, 'packages', 'engine', 'dist', 'engine.cjs');

async function buildBundle() {
  fs.mkdirSync(path.dirname(outCjs), { recursive: true });
  await esbuild.build({
    entryPoints: [engineEntry],
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'cjs',
    outfile: outCjs,
    external: ['node:*'],
    sourcemap: false,
    minify: false,
  });
  const kb = Math.round(fs.statSync(outCjs).size / 1024);
  console.log(`[TubeVault] Bundled engine -> ${outCjs} (${kb} KB)`);
}

function buildSea() {
  const releaseDir = path.join(rootDir, 'release');
  fs.mkdirSync(releaseDir, { recursive: true });
  const seaConfigPath = path.join(releaseDir, 'sea-config.json');
  const seaBlobPath = path.join(releaseDir, 'sea-prep.blob');
  const seaExePath = path.join(releaseDir, 'TubeVault-Engine-Portable.exe');

  const seaConfig = {
    main: outCjs,
    output: seaBlobPath,
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: true,
  };
  fs.writeFileSync(seaConfigPath, JSON.stringify(seaConfig, null, 2), 'utf8');

  console.log('[TubeVault] Generating Node.js SEA blob...');
  execFileSync(process.execPath, ['--experimental-sea-config', seaConfigPath], { stdio: 'inherit' });

  console.log('[TubeVault] Copying Node.js binary & injecting SEA blob via postject...');
  fs.copyFileSync(process.execPath, seaExePath);

  execSync(
    `npx --yes postject "${seaExePath}" NODE_SEA_BLOB "${seaBlobPath}" --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2`,
    { cwd: rootDir, stdio: 'inherit' }
  );

  fs.rmSync(seaBlobPath, { force: true });
  fs.rmSync(seaConfigPath, { force: true });

  const mb = (fs.statSync(seaExePath).size / (1024 * 1024)).toFixed(1);
  console.log(`[TubeVault] Built standalone Node.js SEA binary -> ${seaExePath} (${mb} MB)`);
}

async function main() {
  await buildBundle();
  if (process.argv.includes('--sea')) {
    buildSea();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
