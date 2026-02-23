import { app, BrowserWindow } from 'electron';
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

function sendProgress(percent: number) {
  const wins = BrowserWindow.getAllWindows();
  for (const win of wins) {
    if (!win.isDestroyed()) {
      win.webContents.send('update-progress', percent);
    }
  }
}

// 下载文件，带进度回调，自动跟随重定向
function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const request = (url.startsWith('https') ? https : http).get(url, {
      headers: { 'User-Agent': 'live-dashboard-electron' }
    }, (response) => {
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

      const totalBytes = parseInt(response.headers['content-length'] || '0', 10);
      let receivedBytes = 0;

      response.on('data', (chunk: Buffer) => {
        receivedBytes += chunk.length;
        if (totalBytes > 0) {
          const percent = Math.round((receivedBytes / totalBytes) * 100);
          sendProgress(percent);
        }
      });

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
    const res = await fetch(REPO_API, {
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

    const downloadUrl = dmgAsset.browser_download_url;
    const dmgPath = path.join(app.getPath('temp'), dmgAsset.name);

    console.log(`[更新] 下载 ${dmgAsset.name} ...`);
    await downloadFile(downloadUrl, dmgPath);
    console.log(`[更新] 下载完成: ${dmgPath}`);

    // 自动安装：挂载 dmg → 复制 .app 到 Applications → 卸载 → 重启
    sendProgress(100);
    console.log('[更新] 开始自动安装...');

    const appPath = process.execPath; // 当前 .app 内的可执行文件路径
    const appBundlePath = appPath.replace(/\/Contents\/MacOS\/.+$/, '');
    const appName = path.basename(appBundlePath); // e.g. "直播数据大屏.app"
    const appsDir = path.dirname(appBundlePath); // e.g. "/Applications"

    // 挂载 dmg
    const mountOutput = execSync(`hdiutil attach "${dmgPath}" -nobrowse -noautoopen`, {
      encoding: 'utf-8', timeout: 30000
    });
    // 解析挂载点
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

    // 删除旧版本并复制新版本
    console.log(`[更新] 替换 ${destApp} ...`);
    execSync(`rm -rf "${destApp}" && cp -R "${srcApp}" "${destApp}"`, {
      stdio: 'pipe', timeout: 60000
    });

    // 卸载 dmg
    execSync(`hdiutil detach "${mountPoint}" -force`, { stdio: 'pipe', timeout: 10000 });
    // 清理临时文件
    if (fs.existsSync(dmgPath)) fs.unlinkSync(dmgPath);

    console.log('[更新] 安装完成，准备重启...');

    // 重启应用
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
