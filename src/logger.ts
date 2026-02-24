import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

const LOG_DIR = path.join(app.getPath('userData'), 'logs');
const MAX_AGE_DAYS = 7;

// 确保日志目录存在
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

function getLogFile(): string {
  const now = new Date();
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  return path.join(LOG_DIR, `${date}.log`);
}

function timestamp(): string {
  return new Date().toISOString().replace('T', ' ').replace('Z', '');
}

function write(level: string, ...args: any[]) {
  const msg = args.map(a => {
    if (a instanceof Error) return `${a.message}\n${a.stack}`;
    if (typeof a === 'object') {
      try { return JSON.stringify(a); } catch { return String(a); }
    }
    return String(a);
  }).join(' ');

  const line = `[${timestamp()}] [${level}] ${msg}\n`;

  // 同时输出到控制台
  if (level === 'ERROR') {
    process.stderr.write(line);
  } else {
    process.stdout.write(line);
  }

  // 写入文件
  try {
    fs.appendFileSync(getLogFile(), line);
  } catch { /* 忽略写入失败 */ }
}

export const logger = {
  info: (...args: any[]) => write('INFO', ...args),
  warn: (...args: any[]) => write('WARN', ...args),
  error: (...args: any[]) => write('ERROR', ...args),
  debug: (...args: any[]) => write('DEBUG', ...args),
  getLogDir: () => LOG_DIR,
};

// 清理过期日志
export function cleanOldLogs() {
  try {
    const files = fs.readdirSync(LOG_DIR);
    const cutoff = Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
    for (const file of files) {
      if (!file.endsWith('.log')) continue;
      const filePath = path.join(LOG_DIR, file);
      const stat = fs.statSync(filePath);
      if (stat.mtimeMs < cutoff) {
        fs.unlinkSync(filePath);
        logger.info(`[日志清理] 删除过期日志: ${file}`);
      }
    }
  } catch (e) {
    // 忽略清理失败
  }
}
