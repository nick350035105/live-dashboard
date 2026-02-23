import { app, BrowserWindow, net } from 'electron';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

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
    const res = await net.fetch(REPO_API, {
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

function sendProgress(percent: number) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('update-progress', percent);
    }
  }
}

// 使用 Electron net 模块下载（自动走系统代理）
async function downloadFile(url: string, dest: string): Promise<void> {
  const res = await net.fetch(url, {
    headers: { 'User-Agent': 'live-dashboard-electron' }
  });
  if (!res.ok) throw new Error(`下载失败: HTTP ${res.status}`);

  const totalBytes = parseInt(res.headers.get('content-length') || '0', 10);
  let receivedBytes = 0;

  const reader = res.body!.getReader();
  const file = fs.createWriteStream(dest);

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    file.write(Buffer.from(value));
    receivedBytes += value.byteLength;
    if (totalBytes > 0) {
      sendProgress(Math.round((receivedBytes / totalBytes) * 100));
    }
  }

  await new Promise<void>((resolve, reject) => {
    file.on('finish', resolve);
    file.on('error', reject);
    file.end();
  });
}

export async function doUpdate(): Promise<{ success: boolean; error?: string }> {
  try {
    if (!app.isPackaged) {
      const cwd = app.getAppPath();
      sendProgress(10);
      execSync('git pull origin main', { cwd, stdio: 'pipe', timeout: 60000 });
      sendProgress(40);
      execSync('npm install', { cwd, stdio: 'pipe', timeout: 120000 });
      sendProgress(60);
      execSync('npx tsc', { cwd, stdio: 'pipe', timeout: 60000 });
      sendProgress(80);
      execSync('npx electron-rebuild', { cwd, stdio: 'pipe', timeout: 120000 });
      sendProgress(100);
      app.relaunch();
      app.exit(0);
      return { success: true };
    }

    // 打包模式：下载 dmg → 挂载 → 复制 .app → 重启
    sendProgress(0);
    const res = await net.fetch(REPO_API, {
      headers: { 'User-Agent': 'live-dashboard-electron' }
    });
    if (!res.ok) throw new Error(`GitHub API ${res.status}`);
    const release: any = await res.json();

    const dmgAsset = (release.assets || []).find((a: any) =>
      a.name.endsWith('.dmg') && a.name.includes('arm64')
    ) || (release.assets || []).find((a: any) => a.name.endsWith('.dmg'));

    if (!dmgAsset) {
      throw new Error('未找到安装包，请手动从 GitHub Releases 下载');
    }

    const dmgPath = path.join(app.getPath('temp'), dmgAsset.name);

    console.log(`[更新] 下载 ${dmgAsset.name} (${(dmgAsset.size / 1024 / 1024).toFixed(1)}MB)...`);
    await downloadFile(dmgAsset.browser_download_url, dmgPath);
    console.log(`[更新] 下载完成: ${dmgPath}`);

    // 自动安装
    sendProgress(100);
    console.log('[更新] 开始自动安装...');

    const appBundlePath = process.execPath.replace(/\/Contents\/MacOS\/.+$/, '');
    const appName = path.basename(appBundlePath);
    const appsDir = path.dirname(appBundlePath);

    // 挂载 dmg
    const mountOutput = execSync(`hdiutil attach "${dmgPath}" -nobrowse -noautoopen`, {
      encoding: 'utf-8', timeout: 120000
    });
    const mountMatch = mountOutput.match(/\/Volumes\/.+$/m);
    if (!mountMatch) throw new Error('挂载 DMG 失败');
    const mountPoint = mountMatch[0].trim();
    console.log(`[更新] DMG 挂载到: ${mountPoint}`);

    // 查找 .app
    const items = fs.readdirSync(mountPoint);
    const appBundle = items.find(i => i.endsWith('.app'));
    if (!appBundle) {
      execSync(`hdiutil detach "${mountPoint}" -force`, { stdio: 'pipe' });
      throw new Error('DMG 中未找到 .app');
    }

    const srcApp = path.join(mountPoint, appBundle);
    const destApp = path.join(appsDir, appName);

    console.log(`[更新] 替换 ${destApp} ...`);
    execSync(`rm -rf "${destApp}" && cp -R "${srcApp}" "${destApp}"`, {
      stdio: 'pipe', timeout: 120000
    });

    // 清理
    execSync(`hdiutil detach "${mountPoint}" -force`, { stdio: 'pipe', timeout: 30000 });
    if (fs.existsSync(dmgPath)) fs.unlinkSync(dmgPath);

    console.log('[更新] 安装完成，准备重启...');
    app.relaunch({ execPath: path.join(destApp, 'Contents', 'MacOS', appName.replace('.app', '')) });
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
