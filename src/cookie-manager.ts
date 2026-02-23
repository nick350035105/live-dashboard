import { session as electronSession } from 'electron';
import { db, CookieData } from './db';

// 从 cookie 数组构建请求头中的 Cookie 字符串
export function buildCookieString(cookies: CookieData[], domain: string): string {
  return cookies
    .filter(c => domain.includes(c.domain.replace(/^\./, '')))
    .map(c => `${c.name}=${c.value}`)
    .join('; ');
}

// 验证代理商 cookie 是否有效
export async function validateAgentCookies(cookies: CookieData[]): Promise<boolean> {
  try {
    const cookieStr = buildCookieString(cookies, 'oceanengine.com');
    const response = await fetch('https://agent.oceanengine.com/agent/user/user-info/', {
      method: 'GET',
      headers: {
        'accept': 'application/json, text/plain, */*',
        'accept-language': 'zh',
        'cookie': cookieStr,
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
        'sec-ch-ua': '"Not:A-Brand";v="99", "Google Chrome";v="145", "Chromium";v="145"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"macOS"',
        'referer': 'https://agent.oceanengine.com/admin/homepage',
        'x-sw-cache': '7'
      }
    });

    if (response.status === 200) {
      const data: any = await response.json();
      if (data && data.data && data.code !== 8) {
        console.log('代理商 cookie 有效');
        return true;
      }
    }
    console.log('代理商 cookie 无效');
    return false;
  } catch (error) {
    console.error('验证代理商 cookie 失败:', error);
    return false;
  }
}

// 验证账户 cookie 是否有效
export async function validateAccountCookies(advId: string, cookies: CookieData[]): Promise<boolean> {
  try {
    const cookieStr = buildCookieString(cookies, 'chengzijianzhan.cn');
    const response = await fetch(`https://localads.chengzijianzhan.cn/api/lamp/pc/v2/account/user/userInfo?advid=${advId}`, {
      method: 'GET',
      headers: {
        'accept': 'application/json, text/plain, */*',
        'cookie': cookieStr,
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36'
      }
    });

    if (response.status === 200) {
      const data: any = await response.json();
      if (data && (data.code === 0 || data.code === 'success' || data.status_code === 0) && data.data) {
        console.log(`账户 ${advId} cookie 有效`);
        return true;
      }
    }
    console.log(`账户 ${advId} cookie 无效`);
    return false;
  } catch (error) {
    console.error(`验证账户 ${advId} cookie 失败:`, error);
    return false;
  }
}

// Electron cookie 与 CookieData 的格式转换
function toElectronCookie(c: CookieData): Electron.CookiesSetDetails {
  const detail: Electron.CookiesSetDetails = {
    url: `http${c.secure ? 's' : ''}://${c.domain.replace(/^\./, '')}${c.path || '/'}`,
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path || '/',
    secure: c.secure,
    httpOnly: c.httpOnly,
  };
  if (c.expires && c.expires > 0) {
    detail.expirationDate = c.expires;
  }
  if (c.sameSite) {
    detail.sameSite = c.sameSite.toLowerCase() as 'unspecified' | 'no_restriction' | 'lax' | 'strict';
    if (detail.sameSite === 'none' as any) detail.sameSite = 'no_restriction';
  }
  return detail;
}

function fromElectronCookie(c: Electron.Cookie): CookieData {
  return {
    name: c.name,
    value: c.value,
    domain: c.domain || '',
    path: c.path || '/',
    expires: c.expirationDate || -1,
    httpOnly: c.httpOnly,
    secure: c.secure,
    sameSite: c.sameSite === 'no_restriction' ? 'None'
      : c.sameSite === 'lax' ? 'Lax'
        : c.sameSite === 'strict' ? 'Strict'
          : undefined,
  };
}

// 加载代理商 cookie 到 Electron session
export async function loadAgentCookiesToSession(ses: Electron.Session): Promise<boolean> {
  const agent = db.getAgent();
  if (!agent || !agent.cookies || agent.cookies === '[]') {
    console.log('数据库中无代理商 cookie');
    return false;
  }

  try {
    const cookies: CookieData[] = JSON.parse(agent.cookies);
    if (cookies.length === 0) return false;

    const isValid = await validateAgentCookies(cookies);
    if (!isValid) {
      db.updateAgentStatus('invalid');
      return false;
    }

    for (const c of cookies) {
      await ses.cookies.set(toElectronCookie(c));
    }
    db.updateAgentStatus('valid');
    return true;
  } catch (error) {
    console.error('加载代理商 cookie 失败:', error);
    return false;
  }
}

// 从 Electron session 保存代理商 cookie
export async function saveAgentCookiesFromSession(ses: Electron.Session) {
  const allCookies = await ses.cookies.get({});
  const agentCookies = allCookies
    .filter(c => (c.domain || '').includes('oceanengine.com') || (c.domain || '').includes('bytedance.com'))
    .map(fromElectronCookie);
  db.updateAgentCookies(agentCookies, 'valid');
  console.log(`已保存 ${agentCookies.length} 条代理商 cookie`);
}

// 从 Electron session 保存账户 cookie
export async function saveAccountCookiesFromSession(advId: string, ses: Electron.Session) {
  const allCookies = await ses.cookies.get({});
  const accountCookies = allCookies
    .filter(c => (c.domain || '').includes('chengzijianzhan.cn'))
    .map(fromElectronCookie);
  db.updateAccountCookies(advId, accountCookies, 'valid');
  console.log(`已保存账户 ${advId} 的 ${accountCookies.length} 条 cookie`);
}
