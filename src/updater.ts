import { app, BrowserWindow, net } from 'electron';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from './logger';

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
    logger.error('检查更新失败:', error);
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

    // 打包模式：下载安装包并自动安装
    sendProgress(0);
    const res = await net.fetch(REPO_API, {
      headers: { 'User-Agent': 'live-dashboard-electron' }
    });
    if (!res.ok) throw new Error(`GitHub API ${res.status}`);
    const release: any = await res.json();

    const isMac = process.platform === 'darwin';
    const isWin = process.platform === 'win32';

    // 查找对应平台的安装包
    let asset: any;
    if (isMac) {
      asset = (release.assets || []).find((a: any) => a.name.endsWith('.dmg') && a.name.includes('arm64'))
        || (release.assets || []).find((a: any) => a.name.endsWith('.dmg'));
    } else if (isWin) {
      asset = (release.assets || []).find((a: any) => a.name.endsWith('.exe'));
    }

    if (!asset) {
      throw new Error('未找到安装包，请手动从 GitHub Releases 下载');
    }

    const installerPath = path.join(app.getPath('temp'), asset.name);

    logger.info(`[更新] 下载 ${asset.name} (${(asset.size / 1024 / 1024).toFixed(1)}MB)...`);
    await downloadFile(asset.browser_download_url, installerPath);
    logger.info(`[更新] 下载完成: ${installerPath}`);

    sendProgress(100);
    logger.info('[更新] 开始自动安装...');

    if (isWin) {
      // Windows: 创建批处理脚本 → 等待当前进程退出 → 静默安装 → 启动新版本
      const { spawn } = require('child_process');
      const installDir = path.dirname(process.execPath);
      const appExeName = path.basename(process.execPath);
      const batPath = path.join(app.getPath('temp'), 'live-dashboard-update.bat');
      const batContent = [
        '@echo off',
        'timeout /t 3 /nobreak >nul',
        `start /wait "" "${installerPath}" /S /D=${installDir}`,
        `start "" "${path.join(installDir, appExeName)}"`,
        `del "%~f0"`,
      ].join('\r\n');
      fs.writeFileSync(batPath, batContent);
      spawn('cmd.exe', ['/c', batPath], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      app.exit(0);
      return { success: true };
    }

    // macOS: 挂载 dmg → 复制 .app → 重启

    const appBundlePath = process.execPath.replace(/\/Contents\/MacOS\/.+$/, '');
    const appName = path.basename(appBundlePath);
    const appsDir = path.dirname(appBundlePath);

    // 挂载 dmg
    const mountOutput = execSync(`hdiutil attach "${installerPath}" -nobrowse -noautoopen`, {
      encoding: 'utf-8', timeout: 120000
    });
    const mountMatch = mountOutput.match(/\/Volumes\/.+$/m);
    if (!mountMatch) throw new Error('挂载 DMG 失败');
    const mountPoint = mountMatch[0].trim();
    logger.info(`[更新] DMG 挂载到: ${mountPoint}`);

    // 查找 .app
    const items = fs.readdirSync(mountPoint);
    const appBundle = items.find(i => i.endsWith('.app'));
    if (!appBundle) {
      execSync(`hdiutil detach "${mountPoint}" -force`, { stdio: 'pipe' });
      throw new Error('DMG 中未找到 .app');
    }

    const srcApp = path.join(mountPoint, appBundle);
    const destApp = path.join(appsDir, appName);

    logger.info(`[更新] 替换 ${destApp} ...`);
    execSync(`rm -rf "${destApp}" && cp -R "${srcApp}" "${destApp}"`, {
      stdio: 'pipe', timeout: 120000
    });

    // 清理
    execSync(`hdiutil detach "${mountPoint}" -force`, { stdio: 'pipe', timeout: 30000 });
    if (fs.existsSync(installerPath)) fs.unlinkSync(installerPath);

    logger.info('[更新] 安装完成，准备重启...');
    app.relaunch({ execPath: path.join(destApp, 'Contents', 'MacOS', appName.replace('.app', '')) });
    app.exit(0);

    return { success: true };
  } catch (error: any) {
    logger.error('[更新] 失败:', error.message);
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
