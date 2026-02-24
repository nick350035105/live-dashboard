import { BrowserWindow, session } from 'electron';
import * as path from 'path';
import { db, CookieData } from './db';
import {
  validateAgentCookies, validateAccountCookies,
  loadAgentCookiesToSession, saveAgentCookiesFromSession, saveAccountCookiesFromSession
} from './cookie-manager';
import { fetchLiveRooms, LiveRoomData } from './data-fetcher';
import { logger } from './logger';

type CookieStatus = 'valid' | 'invalid' | 'authorizing' | 'unknown';

export interface AccountData {
  advId: string;
  name?: string;
  liveRooms: LiveRoomData[];
  endedRooms: LiveRoomData[];
  lastFetchTime: number;
  cookies: CookieData[];
  cookieStatus: CookieStatus;
}

export class AuthManager {
  accounts: Map<string, AccountData> = new Map();
  private refreshingAccounts: Set<string> = new Set();
  private authQueue: Set<string> = new Set();
  private isAuthRunning = false;
  authProgress = { isRunning: false, current: null as string | null, done: 0, total: 0 };
  private isAgentAuthRunning = false;
  private agentAuthWin: BrowserWindow | null = null;
  private mainWindow: BrowserWindow | null = null;

  setMainWindow(win: BrowserWindow) {
    this.mainWindow = win;
  }

  // 通知前端数据更新
  private notifyUpdate() {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('data-update');
    }
  }

  get agentAuthRunning() {
    return this.isAgentAuthRunning;
  }

  // 代理商登录：打开有头 BrowserWindow → 加载登录页 → 轮询检测 → 保存 cookie
  async startAgentAuth(): Promise<void> {
    if (this.isAgentAuthRunning) throw new Error('已有代理商授权流程在运行');
    this.isAgentAuthRunning = true;
    logger.info('[代理商授权] 启动浏览器，等待用户登录...');

    try {
      const ses = session.fromPartition('persist:auth');
      // 清除 session 中的代理商 cookie，确保从零登录
      const existingCookies = await ses.cookies.get({});
      for (const c of existingCookies) {
        if ((c.domain || '').includes('oceanengine.com') || (c.domain || '').includes('bytedance.com')) {
          await ses.cookies.remove(`http${c.secure ? 's' : ''}://${(c.domain || '').replace(/^\./, '')}${c.path || '/'}`, c.name);
        }
      }
      const win = new BrowserWindow({
        width: 1200,
        height: 800,
        show: true,
        webPreferences: { session: ses },
      });
      this.agentAuthWin = win;

      const loggedIn = await this.waitForAgentLogin(win, ses);
      if (!loggedIn) {
        throw new Error('登录超时');
      }

      logger.info('[代理商授权] 授权成功，重新穿越所有监控账户...');
      for (const [advId, account] of Array.from(this.accounts.entries())) {
        account.cookieStatus = 'authorizing';
        this.authQueue.add(advId);
      }
    } finally {
      if (this.agentAuthWin && !this.agentAuthWin.isDestroyed()) {
        this.agentAuthWin.close();
        this.agentAuthWin = null;
      }
      this.isAgentAuthRunning = false;
      this.notifyUpdate();
      if (this.authQueue.size > 0) {
        this.processAuthQueue();
      }
    }
  }

  // 取消代理商授权
  async cancelAgentAuth(): Promise<void> {
    if (this.agentAuthWin && !this.agentAuthWin.isDestroyed()) {
      this.agentAuthWin.close();
      this.agentAuthWin = null;
    }
    this.isAgentAuthRunning = false;
    logger.info('[代理商授权] 已取消');
  }

  // 等待代理商登录（使用 BrowserWindow + executeJavaScript 替代 page.evaluate）
  async waitForAgentLogin(win: BrowserWindow, ses: Electron.Session): Promise<boolean> {
    const agentUrl = 'https://agent.oceanengine.com/login';
    logger.info('请在浏览器中登录代理商后台...');
    logger.info(`正在打开: ${agentUrl}`);

    await win.loadURL(agentUrl);

    const maxRetries = 30;
    for (let i = 1; i <= maxRetries; i++) {
      logger.info(`检查登录状态 (${i}/${maxRetries})...`);

      try {
        const loginResult = await win.webContents.executeJavaScript(`
          (async () => {
            try {
              const response = await fetch('https://agent.oceanengine.com/agent/user/user-info/', {
                method: 'GET',
                credentials: 'include',
                headers: { 'accept': 'application/json, text/plain, */*' }
              });
              if (response.status === 200) {
                const data = await response.json();
                if (data && data.data && data.code !== 8) {
                  return { success: true };
                }
              }
              return { success: false };
            } catch {
              return { success: false };
            }
          })()
        `);

        if (loginResult.success) {
          logger.info('代理商登录成功！');
          await saveAgentCookiesFromSession(ses);
          return true;
        }
      } catch (e) {
        // 页面可能还在加载中
      }

      await new Promise(r => setTimeout(r, 10000));
      // 检查窗口是否被用户关闭
      if (win.isDestroyed()) return false;
    }

    return false;
  }

  // 穿越到指定账户
  async traverseToAccount(advId: string, ses: Electron.Session): Promise<CookieData[]> {
    logger.info(`[穿越] 开始穿越到账户: ${advId}`);

    const win = new BrowserWindow({
      width: 1200,
      height: 800,
      show: false,
      webPreferences: { session: ses },
    });

    try {
      const listUrl = 'https://agent.oceanengine.com/admin/optimizeModule/dataSummary/bidding/bidding-adv';
      logger.info(`[穿越] 正在加载页面: ${listUrl}`);
      await win.loadURL(listUrl);
      await new Promise(r => setTimeout(r, 3000));
      logger.info(`[穿越] 页面加载完成，当前URL: ${win.webContents.getURL()}`);

      // 检查并切换到"客户账户"
      const selectValue = await win.webContents.executeJavaScript(`
        (() => {
          const input = document.querySelector('.byted-select-single input[readonly]');
          return input ? input.value : '';
        })()
      `);
      logger.info(`[穿越] 当前下拉选择值: "${selectValue}"`);

      if (selectValue !== '客户账户') {
        logger.info('[穿越] 需要切换到"客户账户"，正在点击下拉框...');
        await win.webContents.executeJavaScript(`
          (() => {
            const select = document.querySelector('.byted-select-single');
            if (select) select.click();
          })()
        `);
        await new Promise(r => setTimeout(r, 1500));
        await win.webContents.executeJavaScript(`
          (() => {
            const options = Array.from(document.querySelectorAll('.byted-select-option-inner-wrapper'));
            const customerOption = options.find(el => el.textContent && el.textContent.trim() === '客户账户');
            if (customerOption) customerOption.click();
          })()
        `);
        await new Promise(r => setTimeout(r, 1000));
        logger.info('[穿越] 已切换到"客户账户"');
      }

      // 搜索账户
      logger.info(`[穿越] 正在搜索账户ID: ${advId}`);
      await win.webContents.executeJavaScript(`
        (() => {
          const input = document.querySelector('input[placeholder*="请填写名称或ID"]');
          if (input) {
            const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            nativeInputValueSetter.call(input, '${advId}');
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
          }
        })()
      `);
      await new Promise(r => setTimeout(r, 3000));
      logger.info('[穿越] 搜索完成，等待结果加载');

      // 查找穿越按钮并点击
      const buttonCount = await win.webContents.executeJavaScript(`
        (() => {
          const buttons = Array.from(document.querySelectorAll('.sys-text-btn'));
          return buttons.length;
        })()
      `);
      logger.info(`[穿越] 找到 ${buttonCount} 个穿越按钮`);

      if (buttonCount === 0) {
        logger.error(`[穿越] 未找到账户: ${advId}，页面URL: ${win.webContents.getURL()}`);
        return [];
      }

      // 拦截穿越按钮打开的新窗口，不显示出来
      let newWinResolve: ((win: BrowserWindow | null) => void) | null = null;
      const newWinPromise = new Promise<BrowserWindow | null>(r => { newWinResolve = r; });
      const newWinTimeout = setTimeout(() => newWinResolve!(null), 15000);

      win.webContents.setWindowOpenHandler(({ url }) => {
        logger.info(`[穿越] 拦截新窗口请求，URL: ${url}`);
        return { action: 'allow', overrideBrowserWindowOptions: { show: false } };
      });

      win.webContents.on('did-create-window', (newWin) => {
        clearTimeout(newWinTimeout);
        logger.info('[穿越] 新窗口已创建');
        newWinResolve!(newWin);
      });

      logger.info('[穿越] 正在点击穿越按钮...');
      await win.webContents.executeJavaScript(`
        (() => {
          const buttons = Array.from(document.querySelectorAll('.sys-text-btn'));
          if (buttons.length > 0) buttons[0].click();
        })()
      `);
      logger.info('[穿越] 穿越按钮已点击，等待新窗口...');

      const newWin = await newWinPromise;

      if (newWin) {
        logger.info('[穿越] 新窗口已创建（隐藏），等待加载...');
        await new Promise(r => setTimeout(r, 3000));

        // 在新窗口中访问目标页面以激活 cookie
        const liveUrl = `https://localads.chengzijianzhan.cn/lamp/pc/data2/liveCockpit?advid=${advId}`;
        logger.info(`[穿越] 在新窗口中加载目标页面: ${liveUrl}`);
        await newWin.loadURL(liveUrl);
        await new Promise(r => setTimeout(r, 3000));
        logger.info(`[穿越] 目标页面加载完成，URL: ${newWin.isDestroyed() ? '(窗口已销毁)' : newWin.webContents.getURL()}`);

        if (!newWin.isDestroyed()) newWin.close();
      } else {
        logger.info('[穿越] 未检测到新窗口（15s超时），尝试直接跳转');
        const liveUrl = `https://localads.chengzijianzhan.cn/lamp/pc/data2/liveCockpit?advid=${advId}`;
        logger.info(`[穿越] 直接加载目标页面: ${liveUrl}`);
        await win.loadURL(liveUrl);
        await new Promise(r => setTimeout(r, 3000));
        logger.info(`[穿越] 直接跳转完成，URL: ${win.webContents.getURL()}`);
      }

      // 保存 cookie
      await saveAccountCookiesFromSession(advId, ses);

      const allCookies = await ses.cookies.get({});
      const accountCookies: CookieData[] = allCookies
        .filter(c => (c.domain || '').includes('chengzijianzhan.cn'))
        .map(c => ({
          name: c.name,
          value: c.value,
          domain: c.domain || '',
          path: c.path || '/',
          expires: c.expirationDate || -1,
          httpOnly: c.httpOnly,
          secure: c.secure,
          sameSite: c.sameSite === 'no_restriction' ? 'None' as const
            : c.sameSite === 'lax' ? 'Lax' as const
              : c.sameSite === 'strict' ? 'Strict' as const
                : undefined,
        }));

      logger.info(`[穿越] 账户 ${advId} 获取到 ${accountCookies.length} 条 cookie`);
      return accountCookies;
    } catch (err) {
      logger.error(`[穿越] 账户 ${advId} 穿越过程异常:`, err);
      return [];
    } finally {
      if (!win.isDestroyed()) win.close();
    }
  }

  // 加入授权队列并触发后台处理
  enqueueAuth(advId: string) {
    if (this.authQueue.has(advId)) return;
    this.authQueue.add(advId);
    const account = this.accounts.get(advId);
    if (account) account.cookieStatus = 'authorizing';
    logger.info(`[授权队列] 添加 ${advId}，当前队列: ${Array.from(this.authQueue).join(', ')}`);
    this.processAuthQueue();
  }

  // 后台异步处理授权队列
  async processAuthQueue() {
    if (this.isAuthRunning || this.authQueue.size === 0) return;
    this.isAuthRunning = true;

    const pendingIds = Array.from(this.authQueue);
    this.authProgress = { isRunning: true, current: null, done: 0, total: pendingIds.length };
    logger.info(`[授权] 开始处理 ${pendingIds.length} 个账户: ${pendingIds.join(', ')}`);
    this.notifyUpdate();

    const ses = session.fromPartition('persist:auth');

    try {
      // 检查代理商 cookie 是否有效
      const agent = db.getAgent();
      let agentCookiesValid = false;
      if (agent?.cookies && agent.cookies !== '[]') {
        agentCookiesValid = await validateAgentCookies(JSON.parse(agent.cookies));
      }

      if (agentCookiesValid) {
        logger.info('[授权] 代理商 cookie 有效，使用无头窗口');
        // 加载代理商 cookie 到 session
        await loadAgentCookiesToSession(ses);
      } else {
        logger.info('[授权] 代理商 cookie 无效，需要手动登录');
        const win = new BrowserWindow({
          width: 1200,
          height: 800,
          show: true,
          webPreferences: { session: ses },
        });
        this.agentAuthWin = win;

        const loggedIn = await this.waitForAgentLogin(win, ses);
        if (!win.isDestroyed()) win.close();
        this.agentAuthWin = null;

        if (!loggedIn) {
          logger.error('[授权] 代理商登录超时');
          for (const id of pendingIds) {
            this.authQueue.delete(id);
            const acc = this.accounts.get(id);
            if (acc) acc.cookieStatus = 'invalid';
          }
          return;
        }
      }

      for (const advId of pendingIds) {
        this.authProgress.current = advId;
        this.notifyUpdate();
        try {
          const cookies = await this.traverseToAccount(advId, ses);
          const account = this.accounts.get(advId);
          if (cookies.length > 0 && account) {
            account.cookies = cookies;
            account.cookieStatus = 'valid';
            db.updateAccountStatus(advId, 'valid');
            // 穿越成功后立即拉取数据
            const result = await fetchLiveRooms(advId, cookies);
            if (result) {
              account.liveRooms = result.live;
              account.endedRooms = result.ended;
              account.lastFetchTime = Date.now();
            }
            logger.info(`[授权] 账户 ${advId} 授权成功`);
          } else {
            if (account) account.cookieStatus = 'invalid';
            logger.error(`[授权] 账户 ${advId} 穿越失败`);
          }
        } catch (err) {
          logger.error(`[授权] 账户 ${advId} 异常:`, err);
          const account = this.accounts.get(advId);
          if (account) account.cookieStatus = 'invalid';
        }
        this.authQueue.delete(advId);
        this.authProgress.done++;
        this.notifyUpdate();
      }
    } catch (err) {
      logger.error('[授权] 流程异常:', err);
      for (const id of pendingIds) {
        this.authQueue.delete(id);
        const acc = this.accounts.get(id);
        if (acc) acc.cookieStatus = 'invalid';
      }
    } finally {
      this.isAuthRunning = false;
      this.authProgress = { isRunning: false, current: null, done: 0, total: 0 };
      this.notifyUpdate();
      if (this.authQueue.size > 0) {
        this.processAuthQueue();
      }
    }
  }

  // 添加账户
  async addAccount(advId: string, name?: string): Promise<AccountData> {
    if (this.accounts.has(advId)) {
      return this.accounts.get(advId)!;
    }

    db.upsertAccount(advId, name);

    const record = db.getAccount(advId);
    let cookies: CookieData[] = [];
    let cookieStatus: CookieStatus = 'unknown';

    if (record?.cookies && record.cookies !== '[]') {
      cookies = JSON.parse(record.cookies);
      const isValid = await validateAccountCookies(record.adv_id, cookies);
      if (isValid) {
        cookieStatus = 'valid';
      } else {
        cookies = [];
        cookieStatus = 'invalid';
      }
    }

    const account: AccountData = {
      advId,
      name,
      liveRooms: [],
      endedRooms: [],
      lastFetchTime: 0,
      cookies,
      cookieStatus
    };
    this.accounts.set(advId, account);

    if (cookieStatus !== 'valid') {
      this.enqueueAuth(advId);
    } else {
      const result = await fetchLiveRooms(advId, cookies);
      if (result) {
        account.liveRooms = result.live;
        account.endedRooms = result.ended;
        account.lastFetchTime = Date.now();
      }
    }

    this.notifyUpdate();
    return account;
  }

  // 移除账户
  removeAccount(advId: string): boolean {
    this.accounts.delete(advId);
    this.authQueue.delete(advId);
    const removed = db.deleteAccount(advId);
    this.notifyUpdate();
    return removed;
  }

  // 获取直播间数据
  async getLiveRooms(advId: string): Promise<{ live: LiveRoomData[]; ended: LiveRoomData[] }> {
    const account = this.accounts.get(advId);
    if (!account) throw new Error(`账户 ${advId} 未初始化`);

    // 授权中的账户直接返回当前数据，不触发请求
    if (account.cookieStatus === 'authorizing') {
      return { live: account.liveRooms, ended: account.endedRooms };
    }

    if (account.cookies.length > 0) {
      const result = await fetchLiveRooms(advId, account.cookies);
      if (result !== null) {
        account.liveRooms = result.live;
        account.endedRooms = result.ended;
        account.lastFetchTime = Date.now();
        account.cookieStatus = 'valid';
        db.updateAccountStatus(advId, 'valid');
        return result;
      }
      logger.info(`账户 ${advId} cookie 失效，加入授权队列`);
      account.cookieStatus = 'invalid';
      account.cookies = [];
      db.updateAccountStatus(advId, 'invalid');
      this.enqueueAuth(advId);
    } else {
      this.enqueueAuth(advId);
    }

    return { live: account.liveRooms, ended: account.endedRooms };
  }

  // 定时刷新
  startAutoRefresh(intervalMs: number = 60000) {
    setInterval(async () => {
      for (const [advId, account] of this.accounts) {
        if (this.refreshingAccounts.has(advId)) continue;
        if (account.cookieStatus === 'authorizing') continue;
        this.refreshingAccounts.add(advId);
        try {
          if (account.cookies.length > 0) {
            const result = await fetchLiveRooms(advId, account.cookies);
            if (result) {
              account.liveRooms = result.live;
              account.endedRooms = result.ended;
              account.lastFetchTime = Date.now();
              account.cookieStatus = 'valid';
              logger.info(`[${new Date().toLocaleTimeString()}] 账户 ${advId} 刷新完成，直播中 ${result.live.length} 个，历史 ${result.ended.length} 个`);
            } else {
              logger.info(`[${new Date().toLocaleTimeString()}] 账户 ${advId} cookie 失效，触发自动重授权`);
              account.cookieStatus = 'invalid';
              account.cookies = [];
              db.updateAccountStatus(advId, 'invalid');
              this.enqueueAuth(advId);
            }
          }
        } catch (error) {
          logger.error(`刷新账户 ${advId} 失败:`, error);
        } finally {
          this.refreshingAccounts.delete(advId);
        }
      }
      this.notifyUpdate();
    }, intervalMs);
  }

  // 初始化：加载 DB 中所有账户
  async initialize() {
    const dbAccounts = db.getAllAccounts();

    for (const record of dbAccounts) {
      let cookies: CookieData[] = [];
      let cookieStatus: CookieStatus = 'unknown';

      if (record.cookies && record.cookies !== '[]') {
        cookies = JSON.parse(record.cookies);
        const isValid = await validateAccountCookies(record.adv_id, cookies);
        if (isValid) {
          cookieStatus = 'valid';
          logger.info(`账户 ${record.adv_id} cookie 有效`);
        } else {
          cookies = [];
          cookieStatus = 'invalid';
          logger.info(`账户 ${record.adv_id} cookie 无效`);
        }
      }

      this.accounts.set(record.adv_id, {
        advId: record.adv_id,
        name: record.name || undefined,
        liveRooms: [],
        endedRooms: [],
        lastFetchTime: 0,
        cookies,
        cookieStatus
      });
    }

    // 有效 cookie 的账户先拉数据
    for (const [advId, account] of this.accounts) {
      if (account.cookies.length > 0) {
        try {
          const result = await fetchLiveRooms(advId, account.cookies);
          if (result) {
            account.liveRooms = result.live;
            account.endedRooms = result.ended;
            account.lastFetchTime = Date.now();
          }
          logger.info(`账户 ${advId} 初始化完成，直播中 ${account.liveRooms.length} 个，历史 ${account.endedRooms.length} 个`);
        } catch (error) {
          logger.error(`账户 ${advId} 获取数据失败:`, error);
        }
      }
    }

    // 需要授权的账户加入队列
    for (const [advId, account] of this.accounts) {
      if (account.cookieStatus !== 'valid') {
        this.enqueueAuth(advId);
      }
    }

    this.notifyUpdate();
  }
}
