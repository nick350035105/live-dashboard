import Database from 'better-sqlite3';
import * as path from 'path';
import { app } from 'electron';

// 自定义 Cookie 接口，替代 Playwright 的 Cookie 类型
export interface CookieData {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

export interface AgentRecord {
  id: number;
  name: string | null;
  cookies: string;
  status: 'valid' | 'invalid' | 'unknown';
  last_check_time: number | null;
  created_at: number;
  updated_at: number;
}

export interface AccountRecord {
  id: number;
  adv_id: string;
  name: string | null;
  agent_id: number | null;
  cookies: string;
  status: 'valid' | 'invalid' | 'unknown';
  last_check_time: number | null;
  created_at: number;
  updated_at: number;
}

class DatabaseManager {
  private db: Database.Database;

  constructor() {
    const dbPath = path.join(app.getPath('userData'), 'data.db');
    this.db = new Database(dbPath);
    this.init();
  }

  private init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT,
        cookies TEXT DEFAULT '[]',
        status TEXT DEFAULT 'unknown',
        last_check_time INTEGER,
        created_at INTEGER,
        updated_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        adv_id TEXT UNIQUE NOT NULL,
        name TEXT,
        agent_id INTEGER,
        cookies TEXT DEFAULT '[]',
        status TEXT DEFAULT 'unknown',
        last_check_time INTEGER,
        created_at INTEGER,
        updated_at INTEGER,
        FOREIGN KEY (agent_id) REFERENCES agents(id)
      );
    `);

    // 确保有默认代理商
    const agent = this.db.prepare('SELECT * FROM agents WHERE id = 1').get();
    if (!agent) {
      const now = Date.now();
      this.db.prepare('INSERT INTO agents (id, name, created_at, updated_at) VALUES (1, ?, ?, ?)').run('默认代理商', now, now);
    }
  }

  // 代理商相关
  getAgent(id: number = 1): AgentRecord | undefined {
    return this.db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as AgentRecord | undefined;
  }

  updateAgentCookies(cookies: CookieData[], status: 'valid' | 'invalid' | 'unknown' = 'valid', id: number = 1) {
    const now = Date.now();
    this.db.prepare('UPDATE agents SET cookies = ?, status = ?, last_check_time = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(cookies), status, now, now, id);
  }

  updateAgentStatus(status: 'valid' | 'invalid' | 'unknown', id: number = 1) {
    const now = Date.now();
    this.db.prepare('UPDATE agents SET status = ?, last_check_time = ?, updated_at = ? WHERE id = ?')
      .run(status, now, now, id);
  }

  // 账户相关
  getAccount(advId: string): AccountRecord | undefined {
    return this.db.prepare('SELECT * FROM accounts WHERE adv_id = ?').get(advId) as AccountRecord | undefined;
  }

  getAllAccounts(): AccountRecord[] {
    return this.db.prepare('SELECT * FROM accounts').all() as AccountRecord[];
  }

  upsertAccount(advId: string, name?: string, agentId: number = 1): AccountRecord {
    const now = Date.now();
    const existing = this.getAccount(advId);
    if (existing) {
      if (name) {
        this.db.prepare('UPDATE accounts SET name = ?, updated_at = ? WHERE adv_id = ?').run(name, now, advId);
      }
      return this.getAccount(advId)!;
    }
    this.db.prepare('INSERT INTO accounts (adv_id, name, agent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(advId, name || null, agentId, now, now);
    return this.getAccount(advId)!;
  }

  updateAccountCookies(advId: string, cookies: CookieData[], status: 'valid' | 'invalid' | 'unknown' = 'valid') {
    const now = Date.now();
    this.db.prepare('UPDATE accounts SET cookies = ?, status = ?, last_check_time = ?, updated_at = ? WHERE adv_id = ?')
      .run(JSON.stringify(cookies), status, now, now, advId);
  }

  updateAccountStatus(advId: string, status: 'valid' | 'invalid' | 'unknown') {
    const now = Date.now();
    this.db.prepare('UPDATE accounts SET status = ?, last_check_time = ?, updated_at = ? WHERE adv_id = ?')
      .run(status, now, now, advId);
  }

  deleteAccount(advId: string): boolean {
    const result = this.db.prepare('DELETE FROM accounts WHERE adv_id = ?').run(advId);
    return result.changes > 0;
  }

  close() {
    this.db.close();
  }
}

let _db: DatabaseManager | null = null;

export function getDb(): DatabaseManager {
  if (!_db) {
    _db = new DatabaseManager();
  }
  return _db;
}

export const db = new Proxy({} as DatabaseManager, {
  get(_target, prop) {
    return (getDb() as any)[prop];
  }
});
