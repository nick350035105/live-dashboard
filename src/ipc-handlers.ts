import { ipcMain, BrowserWindow, session, dialog, shell } from 'electron';
import { execSync } from 'child_process';
import { db, CookieData } from './db';
import { AuthManager } from './auth-manager';
import { fetchAvailableAccounts, getRoomFunnelData } from './data-fetcher';
import { getVersion, checkUpdate, doUpdate } from './updater';
import { logger } from './logger';

export function registerIpcHandlers(authManager: AuthManager) {

  // 获取所有账户直播数据
  ipcMain.handle('get-live-rooms', async (_event, advId?: string) => {
    try {
      const allData: any[] = [];
      for (const [id, account] of authManager.accounts) {
        if (advId && id !== advId) continue;
        allData.push({
          advId: id,
          name: account.name,
          liveRooms: account.liveRooms,
          endedRooms: account.endedRooms,
          lastFetchTime: account.lastFetchTime,
          cookieStatus: account.cookieStatus
        });
      }
      return { success: true, data: allData, timestamp: new Date().toISOString() };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  // 获取账户列表和状态
  ipcMain.handle('get-accounts', async () => {
    const accounts = Array.from(authManager.accounts.entries()).map(([advId, data]) => ({
      advId,
      name: data.name,
      cookieStatus: data.cookieStatus,
      lastFetchTime: data.lastFetchTime,
      roomCount: data.liveRooms.length,
      liveCount: data.liveRooms.filter(r => r.custom_room_status === 'live' || r.custom_room_status === '2').length
    }));
    return { success: true, data: accounts };
  });

  // 添加单个账户
  ipcMain.handle('add-account', async (_event, advId: string, name?: string) => {
    try {
      if (!advId) return { success: false, error: '缺少 advId' };
      const account = await authManager.addAccount(advId, name);
      return {
        success: true,
        account: { advId: account.advId, name: account.name, cookieStatus: account.cookieStatus }
      };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  // 移除账户
  ipcMain.handle('remove-account', async (_event, advId: string) => {
    try {
      if (!advId) return { success: false, error: '缺少 advId' };
      const removed = authManager.removeAccount(advId);
      return { success: removed };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  // 获取可用账户列表（从代理商后台）
  ipcMain.handle('get-available-accounts', async (_event, accountCate?: number) => {
    try {
      const agent = db.getAgent();
      if (!agent?.cookies || agent.cookies === '[]') {
        throw new Error('无代理商 cookie，请先登录代理商后台');
      }
      const agentCookies: CookieData[] = JSON.parse(agent.cookies);
      const list = await fetchAvailableAccounts(agentCookies, accountCate);
      const addedIds = new Set(authManager.accounts.keys());
      const result = list.map(a => ({ ...a, added: addedIds.has(a.advId) }));
      return { success: true, data: result };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  // 批量添加账户
  ipcMain.handle('batch-add-accounts', async (_event, accounts: { advId: string; name?: string }[]) => {
    try {
      if (!accounts || accounts.length === 0) {
        return { success: false, error: '未选择账户' };
      }
      let added = 0;
      for (const { advId, name } of accounts) {
        if (!authManager.accounts.has(advId)) {
          await authManager.addAccount(advId, name);
          added++;
        }
      }
      return { success: true, added };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  // 获取授权进度
  ipcMain.handle('get-auth-status', async () => {
    const progress = authManager.authProgress;
    return {
      success: true,
      data: {
        ...progress,
        currentName: progress.current ? (authManager.accounts.get(progress.current)?.name || progress.current) : null,
        queue: Array.from((authManager as any).authQueue || [])
      }
    };
  });

  // 触发代理商授权
  ipcMain.handle('agent-auth', async () => {
    if (authManager.agentAuthRunning) {
      return { success: false, error: '已有授权流程在运行' };
    }
    authManager.startAgentAuth().catch(err => console.error('[代理商授权] 失败:', err));
    return { success: true };
  });

  // 获取代理商状态
  ipcMain.handle('agent-status', async () => {
    const agent = db.getAgent();
    return {
      success: true,
      data: {
        cookieStatus: agent?.status || 'unknown',
        name: agent?.name || '默认代理商',
        isAuthRunning: authManager.agentAuthRunning
      }
    };
  });

  // 取消代理商授权
  ipcMain.handle('agent-auth-cancel', async () => {
    await authManager.cancelAgentAuth();
    return { success: true };
  });

  // 手动刷新账户数据
  ipcMain.handle('refresh-account', async (_event, advId: string) => {
    if (advId && authManager.accounts.has(advId)) {
      try {
        await authManager.getLiveRooms(advId);
        const account = authManager.accounts.get(advId)!;
        return { success: true, data: { liveRooms: account.liveRooms, endedRooms: account.endedRooms } };
      } catch (error: any) {
        return { success: false, error: error.message };
      }
    }
    return { success: false, error: '账户不存在' };
  });

  // 获取漏斗数据
  ipcMain.handle('get-room-funnel', async (_event, advId: string, roomId: string, anchorId: string) => {
    if (!advId || !roomId || !anchorId) {
      return { success: false, error: '缺少参数' };
    }
    try {
      const account = authManager.accounts.get(advId);
      if (!account || account.cookies.length === 0) {
        return { success: false, error: '账户无有效 cookie' };
      }
      const data = await getRoomFunnelData(advId, roomId, anchorId, account.cookies);
      return { success: true, data };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  // 打开直播大屏 — Electron 核心优势：cookie 天然共享，直接 loadURL
  ipcMain.handle('open-live-board', async (_event, advId: string, roomId: string, awemeId: string) => {
    try {
      const account = authManager.accounts.get(advId);
      if (!account || account.cookies.length === 0) {
        return { success: false, error: '账户无有效 cookie，请先授权' };
      }

      // 使用 persist:auth session 以共享 cookie
      const ses = session.fromPartition('persist:auth');

      const win = new BrowserWindow({
        width: 1440,
        height: 900,
        webPreferences: {
          session: ses,
        },
      });

      const url = `https://localads.chengzijianzhan.cn/lamp/pc/liveboard2?advid=${advId}&room_id=${roomId}&selected_aweme_id=${awemeId}&selected_advid=${advId}&version=1`;
      await win.loadURL(url);
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  // 版本信息
  ipcMain.handle('get-version', async () => {
    return await getVersion();
  });

  // 检查更新
  ipcMain.handle('check-update', async () => {
    return await checkUpdate();
  });

  // 执行更新
  ipcMain.handle('do-update', async () => {
    return await doUpdate();
  });

  // 导出日志
  ipcMain.handle('export-logs', async () => {
    try {
      const logDir = logger.getLogDir();
      const date = new Date().toISOString().slice(0, 10);
      const { filePath, canceled } = await dialog.showSaveDialog({
        defaultPath: `live-dashboard-logs-${date}.zip`,
        filters: [{ name: 'ZIP', extensions: ['zip'] }]
      });
      if (canceled || !filePath) return { success: false, canceled: true };

      if (process.platform === 'win32') {
        execSync(`powershell -Command "Compress-Archive -Path '${logDir}\\*.log' -DestinationPath '${filePath}' -Force"`, { timeout: 30000 });
      } else {
        execSync(`cd "${logDir}" && zip -j "${filePath}" *.log`, { timeout: 30000 });
      }
      shell.showItemInFolder(filePath);
      return { success: true };
    } catch (error: any) {
      logger.error('[导出日志] 失败:', error.message);
      return { success: false, error: error.message };
    }
  });
}
