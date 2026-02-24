import { app, BrowserWindow } from 'electron';
import * as path from 'path';
import { AuthManager } from './auth-manager';
import { registerIpcHandlers } from './ipc-handlers';
import { cleanOldLogs } from './logger';

let mainWindow: BrowserWindow | null = null;
const authManager = new AuthManager();

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '../public/dashboard.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  authManager.setMainWindow(mainWindow);
}

app.whenReady().then(async () => {
  // 清理过期日志
  cleanOldLogs();

  // 注册 IPC handlers
  registerIpcHandlers(authManager);

  // 创建主窗口
  createMainWindow();

  // 初始化（加载 DB 账户、验证 cookie、拉取数据）
  await authManager.initialize();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
