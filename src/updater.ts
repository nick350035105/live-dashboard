import { app, shell } from 'electron';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import * as http from 'http';

const REPO_API = 'https://api.github.com/repos/nick350035105/live-dashboard/releases/latest';

function getCurrentVersion(): string {
  return app.getVersion();
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
    if (res.status === 404) {
      return { hasUpdate: false, latest: current, current };
    }
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

// 下载文件，自动跟随重定向
function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const request = (url.startsWith('https') ? https : http).get(url, {
      headers: { 'User-Agent': 'live-dashboard-electron' }
    }, (response) => {
      // 跟随重定向
      if (response.statusCode === 301 || response.statusCode === 302) {
        file.close();
        fs.unlinkSync(dest);
        const redirectUrl = response.headers.location;
        if (!redirectUrl) return reject(new Error('重定向无目标地址'));
        return downloadFile(redirectUrl, dest).then(resolve).catch(reject);
      }
      if (response.statusCode !== 200) {
        file.close();
        fs.unlinkSync(dest);
        return reject(new Error(`下载失败: HTTP ${response.statusCode}`));
      }
      response.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    });
    request.on('error', (err) => {
      file.close();
      if (fs.existsSync(dest)) fs.unlinkSync(dest);
      reject(err);
    });
  });
}

export async function doUpdate(): Promise<{ success: boolean; error?: string }> {
  try {
    if (!app.isPackaged) {
      // 开发模式：git pull 更新
      const cwd = app.getAppPath();
      console.log('[更新] 开始执行 git pull...');
      execSync('git pull origin main', { cwd, stdio: 'pipe', timeout: 60000 });
      execSync('npm install', { cwd, stdio: 'pipe', timeout: 120000 });
      execSync('npx tsc', { cwd, stdio: 'pipe', timeout: 60000 });
      execSync('npx electron-rebuild', { cwd, stdio: 'pipe', timeout: 120000 });
      app.relaunch();
      app.exit(0);
      return { success: true };
    }

    // 打包模式：从 GitHub Release 下载 dmg 并安装
    console.log('[更新] 获取最新版本信息...');
    const res = await fetch(REPO_API, {
      headers: { 'User-Agent': 'live-dashboard-electron' }
    });
    if (!res.ok) throw new Error(`GitHub API ${res.status}`);
    const release: any = await res.json();

    // 查找 dmg 资源
    const dmgAsset = (release.assets || []).find((a: any) =>
      a.name.endsWith('.dmg') && a.name.includes('arm64')
    ) || (release.assets || []).find((a: any) => a.name.endsWith('.dmg'));

    if (!dmgAsset) {
      throw new Error('未找到安装包，请手动从 GitHub Releases 下载');
    }

    const downloadUrl = dmgAsset.browser_download_url;
    const dmgPath = path.join(app.getPath('downloads'), dmgAsset.name);

    console.log(`[更新] 下载 ${dmgAsset.name} ...`);
    await downloadFile(downloadUrl, dmgPath);

    console.log(`[更新] 下载完成: ${dmgPath}`);

    // 打开 dmg
    await shell.openPath(dmgPath);

    // 退出当前应用，让用户完成安装
    setTimeout(() => {
      app.exit(0);
    }, 1000);

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
