import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Opens a native Windows folder selection dialog via PowerShell + WinForms.
 */
export async function pickFolderWindows(initialDir?: string): Promise<string | null> {
  if (process.platform !== 'win32') return null;

  const safeInitial = initialDir && fs.existsSync(initialDir) ? initialDir.replace(/'/g, "''") : '';
  const script = `
Add-Type -AssemblyName System.Windows.Forms
$dlg = New-Object System.Windows.Forms.FolderBrowserDialog
$dlg.Description = 'Chon thu muc luu video / nhac TubeVault'
$dlg.ShowNewFolderButton = $true
${safeInitial ? `$dlg.SelectedPath = '${safeInitial}'` : ''}
$form = New-Object System.Windows.Forms.Form
$form.TopMost = $true
$result = $dlg.ShowDialog($form)
$form.Dispose()
if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
  Write-Output $dlg.SelectedPath
}
`;

  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-STA', '-Command', script],
    { windowsHide: true, timeout: 120_000 }
  );

  const selected = stdout.trim();
  return selected || null;
}

/**
 * Opens Windows Explorer highlighting a downloaded file or opening a folder.
 */
export function openPathInExplorer(targetPath: string): boolean {
  if (!targetPath) return false;
  const resolved = path.resolve(targetPath);

  if (process.platform === 'win32') {
    if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
      const child = spawn('explorer.exe', [`/select,${resolved}`], { detached: true, stdio: 'ignore' });
      child.unref();
      return true;
    }
    const dir = fs.existsSync(resolved) ? resolved : path.dirname(resolved);
    if (fs.existsSync(dir)) {
      const child = spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore' });
      child.unref();
      return true;
    }
  }
  return false;
}
