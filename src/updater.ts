import { app } from 'electron';
import { execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

const REPO_API = 'https://api.github.com/repos/nick350035105/live-dashboard/releases/latest';
const PROJECT_ROOT = path.join(__dirname, '..');

function getCurrentVersion(): string {
  const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf-8'));
  return pkg.version;
}

export async function getVersion(): Promise<{ version: string }> {
  return { version: getCurrentVersion() };
}

export async function checkUpdate(): Promise<{ hasUpdate: boolean; latest: string; current: string }> {
  const current = getCurrentVersion();
  try {
    const res = await fetch(REPO_API, {
      headers: { 'User-Agent': 'live-dashboard-electron' }
    });
    if (!res.ok) throw new Error(`GitHub API ${res.status}`);
    const data: any = await res.json();
    const latest = (data.tag_name || '').replace(/^v/, '');
    if (!latest) return { hasUpdate: false, latest: current, current };
    const hasUpdate = compareVersions(latest, current) > 0;
    return { hasUpdate, latest, current };
  } catch (error) {
    console.error('检查更新失败:', error);
    throw error;
  }
}

export async function doUpdate(): Promise<{ success: boolean; error?: string }> {
  try {
    console.log('[更新] 开始执行 git pull...');
    execSync('git pull origin main', { cwd: PROJECT_ROOT, stdio: 'pipe', timeout: 60000 });

    console.log('[更新] 安装依赖...');
    execSync('npm install', { cwd: PROJECT_ROOT, stdio: 'pipe', timeout: 120000 });

    console.log('[更新] 重新编译...');
    execSync('npx tsc', { cwd: PROJECT_ROOT, stdio: 'pipe', timeout: 60000 });

    console.log('[更新] 重新编译原生模块...');
    execSync('npx electron-rebuild', { cwd: PROJECT_ROOT, stdio: 'pipe', timeout: 120000 });

    console.log('[更新] 更新完成，准备重启...');

    // 重启应用
    app.relaunch();
    app.exit(0);

    return { success: true };
  } catch (error: any) {
    console.error('[更新] 失败:', error.message);
    return { success: false, error: error.message };
  }
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}
