# 直播数据大屏

巨量本地推直播间数据监控桌面客户端，基于 Electron 构建。通过代理商后台账户穿越机制，实现多账户直播间数据的集中监控与管理。

## 功能

- **多账户管理** — 支持从代理商后台批量导入广告账户，统一管理
- **代理商授权** — 自动化登录代理商后台，Cookie 持久化存储
- **账户穿越** — 通过代理商后台自动穿越到客户账户，获取数据访问权限
- **直播间监控** — 实时展示直播中/已结束直播间的核心数据（观看人数、花费、GMV）
- **数据大屏** — 一键打开巨量本地推原生直播大屏，Cookie 天然共享无需额外登录
- **漏斗分析** — 直播间维度的曝光→观看→商品点击→下单转化漏斗
- **自动刷新** — 60 秒服务端定时刷新 + 前端数据推送，Cookie 失效自动重新授权
- **应用内更新** — 基于 GitHub Releases 的版本检测与一键更新

## 技术栈

| 组件 | 技术 |
|------|------|
| 桌面框架 | Electron 35 |
| 语言 | TypeScript |
| 数据库 | better-sqlite3 (SQLite) |
| 进程通信 | IPC (ipcMain / ipcRenderer) |
| 打包 | electron-builder |

## 架构

```
┌─────────────────────────────────────────────┐
│                  Electron                    │
│  ┌─────────────┐    IPC    ┌──────────────┐ │
│  │  Renderer    │ ◄──────► │  Main Process │ │
│  │  dashboard   │          │              │ │
│  │  .html       │          │  AuthManager  │ │
│  │              │          │  DataFetcher  │ │
│  └─────────────┘          │  CookieManager│ │
│                            │  SQLite DB    │ │
│                            └──────────────┘ │
└─────────────────────────────────────────────┘
```

**核心优势**：Electron 的 `session` 机制使代理商登录、账户穿越、数据大屏访问共享同一浏览器会话，Cookie 天然互通，无需反向代理。

## 快速开始

### 安装包

从 [Releases](https://github.com/nick350035105/live-dashboard/releases) 下载最新 `.dmg` 安装包，拖入 Applications 即可使用。

### 从源码运行

```bash
# 克隆
git clone https://github.com/nick350035105/live-dashboard.git
cd live-dashboard

# 安装依赖
npm install

# 编译原生模块（better-sqlite3）
npx electron-rebuild

# 启动
npm start
```

### 打包

```bash
# 生成 dmg 安装包
npm run dist

# 输出在 release/ 目录
```

## 项目结构

```
src/
├── main.ts            # 主进程入口，窗口创建与生命周期
├── preload.ts         # 安全桥接，暴露 window.api
├── ipc-handlers.ts    # IPC 通道注册（14+ 个接口）
├── auth-manager.ts    # 代理商登录、账户穿越、授权队列
├── cookie-manager.ts  # Cookie 验证、格式转换、Session 读写
├── data-fetcher.ts    # 直播间数据、账户列表、漏斗数据获取
├── db.ts              # SQLite 数据层
└── updater.ts         # 版本检测与应用内更新
public/
└── dashboard.html     # 前端界面（单文件 HTML）
```

## 使用流程

1. **启动应用** → 自动检测代理商 Cookie 状态
2. **代理商登录** → 右上角点击授权按钮，在弹出窗口中完成登录
3. **添加账户** → 侧边栏点击「+」从代理商下的账户列表中批量添加
4. **自动穿越** → 系统自动通过代理商后台穿越到每个客户账户
5. **数据监控** → 主界面展示所有账户的直播间数据，60 秒自动刷新
6. **打开大屏** → 点击直播间卡片上的入口，直接打开原生数据大屏

## License

ISC
