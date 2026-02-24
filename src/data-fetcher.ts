import { CookieData } from './db';
import { buildCookieString } from './cookie-manager';
import { logger } from './logger';

export interface LiveRoomData {
  room_id: string;
  custom_room_title: string;
  custom_room_start_time: string;
  custom_room_end_time: string;
  custom_room_duration: number;
  custom_room_status: string;
  custom_room_cover_url: string;
  custom_aweme_nick_name: string;
  custom_aweme_unique_id: string;
  custom_aweme_user_avatar: string;
  custom_aweme_auth_type: string;
  anchor_id: string;
  all_live_watch_cnt_td: number;
  all_ad_cost_amount_td: number;
  all_groupon_live_pay_amount_td: number;
}

const REQUEST_HEADERS = {
  'Content-Type': 'application/json',
  'accept': 'application/json, text/plain, */*',
  'accept-language': 'zh',
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
  'sec-ch-ua': '"Not:A-Brand";v="99", "Google Chrome";v="145", "Chromium";v="145"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"macOS"',
};

function formatLocalTime(date: Date): string {
  const y = date.getFullYear();
  const M = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const h = String(date.getHours()).padStart(2, '0');
  const m = String(date.getMinutes()).padStart(2, '0');
  const s = String(date.getSeconds()).padStart(2, '0');
  return `${y}-${M}-${d} ${h}:${m}:${s}`;
}

// 获取代理商下所有广告账户列表
export async function fetchAvailableAccounts(agentCookies: CookieData[], accountCate: number = 8): Promise<{ advId: string; advName: string; balance: number; status: string }[]> {
  const cookieStr = agentCookies
    .filter(c => c.domain.includes('oceanengine.com') || c.domain.includes('bytedance.com'))
    .map(c => `${c.name}=${c.value}`)
    .join('; ');

  const csrfCookie = agentCookies.find(c => c.name.toLowerCase().includes('csrf'));
  const csrfToken = csrfCookie?.value || '';

  const now = new Date();
  const end = formatLocalTime(new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59));
  const start30 = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const begin = formatLocalTime(new Date(start30.getFullYear(), start30.getMonth(), start30.getDate(), 0, 0, 0));

  const allAccounts: { advId: string; advName: string; balance: number; status: string }[] = [];
  let page = 1;
  const pageSize = 100;

  while (true) {
    const response = await fetch('https://agent.oceanengine.com/agent-advertising/monitor/overview/adv/bidding/list/query', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json;charset=UTF-8',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'zh',
        'cookie': cookieStr,
        'cg-csrf-token': csrfToken,
        'Referer': 'https://agent.oceanengine.com/admin/optimizeModule/dataSummary/bidding/bidding-adv',
        'User-Agent': REQUEST_HEADERS['user-agent'],
        'sec-ch-ua': REQUEST_HEADERS['sec-ch-ua'],
        'sec-ch-ua-mobile': REQUEST_HEADERS['sec-ch-ua-mobile'],
        'sec-ch-ua-platform': REQUEST_HEADERS['sec-ch-ua-platform'],
      },
      body: JSON.stringify({
        filter: { advClassifyType: "2", accountCate },
        pagination: { page, pageSize },
        sorts: [{ field: "total_balance", order: "DESC" }],
        metricFields: ["total_balance"],
        dimensions: ["advId", "advName", "accountStatus", "firstIndustryName", "secondIndustryName"],
        statTimeRange: { begin, end }
      })
    });

    const data: any = await response.json();
    if (data.code !== 0 && data.code !== 'success') {
      throw new Error(data.msg || data.message || '获取账户列表失败，可能需要重新登录代理商');
    }

    const list = data.data?.data || data.data?.list || [];
    for (const item of list) {
      if (!item.advId) continue;
      const balanceMetric = (item.metrics || []).find((m: any) => m.field === 'total_balance');
      allAccounts.push({
        advId: String(item.advId),
        advName: item.advName || '',
        balance: balanceMetric ? parseFloat(balanceMetric.rawValue || '0') : 0,
        status: item.accountStatus || ''
      });
    }

    const total = parseInt(data.data?.total || data.data?.realTotal || '0', 10);
    if (allAccounts.length >= total || list.length < pageSize) break;
    page++;
  }

  logger.info(`获取到 ${allAccounts.length} 个可用账户`);
  return allAccounts;
}

// 获取直播间数据
export async function fetchLiveRooms(advId: string, cookies: CookieData[], historyDays?: number): Promise<{ live: LiveRoomData[]; ended: LiveRoomData[] } | null> {
  const cookieStr = cookies
    .filter(c => c.domain.includes('chengzijianzhan.cn'))
    .map(c => `${c.name}=${c.value}`)
    .join('; ');

  const now = new Date();
  const endTime = formatLocalTime(now);

  const baseDimensions = [
    "room_id", "custom_room_title", "custom_room_start_time", "custom_room_end_time",
    "custom_room_duration", "custom_room_status", "custom_room_cover_url", "custom_has_roi2_ad",
    "custom_aweme_nick_name", "custom_aweme_unique_id", "custom_aweme_user_avatar", "custom_aweme_auth_type"
  ];

  const parseRows = (rows: any[]): LiveRoomData[] => rows.map((row: any) => {
    const d = row.Dimensions || {};
    const m = row.Metrics || {};
    return {
      room_id: d.room_id?.ValueStr || '',
      custom_room_title: d.custom_room_title?.ValueStr || '',
      custom_room_start_time: d.custom_room_start_time?.ValueStr || '',
      custom_room_end_time: d.custom_room_end_time?.ValueStr || '',
      custom_room_duration: d.custom_room_duration?.Value || d.custom_room_duration?.ValueStr || '',
      custom_room_status: d.custom_room_status?.ValueStr || '',
      custom_room_cover_url: d.custom_room_cover_url?.ValueStr || '',
      custom_aweme_nick_name: d.custom_aweme_nick_name?.ValueStr || '',
      custom_aweme_unique_id: d.custom_aweme_unique_id?.ValueStr || '',
      custom_aweme_user_avatar: d.custom_aweme_user_avatar?.ValueStr || '',
      custom_aweme_auth_type: d.custom_aweme_auth_type?.ValueStr || '',
      anchor_id: d.anchor_id?.ValueStr || '',
      all_live_watch_cnt_td: m.all_live_watch_cnt_td?.Value || 0,
      all_ad_cost_amount_td: m.all_ad_cost_amount_td?.Value || 0,
      all_groupon_live_pay_amount_td: m.all_groupon_live_pay_amount_td?.Value || 0
    };
  });

  try {
    // 1) 正在直播
    const liveStartDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const liveRes = await fetch(`https://localads.chengzijianzhan.cn/api/lamp/pc/v2/statistics/data/statQuery?advid=${advId}`, {
      method: 'POST',
      headers: { ...REQUEST_HEADERS, 'cookie': cookieStr },
      body: JSON.stringify({
        StartTime: formatLocalTime(liveStartDate),
        EndTime: endTime,
        Filters: {
          ConditionRelationshipType: 1,
          Conditions: [{ Field: "advertiser_id", Values: [advId], Operator: 7 }]
        },
        Dimensions: baseDimensions,
        FrameId: "7325383500012503049",
        ModuleId: "7486002605693354035",
        DataSetKey: "live_analysis_living_rooms",
        Metrics: ["all_ad_cost_amount_td", "all_groupon_live_pay_amount_td", "all_live_watch_cnt_td"],
        PageParams: { Limit: 500, Offset: 0 },
        OrderBy: [{ Field: "all_ad_cost_amount_td", Type: 2 }, { Field: "room_id", Type: 2 }]
      })
    });
    const liveData: any = await liveRes.json();
    if (liveData.code !== 0 && liveData.code !== 'success' && liveData.status_code !== 0) {
      return null;
    }
    const liveRooms = parseRows(liveData.data?.StatsData?.Rows || []);

    // 2) 历史直播（带翻页）
    const endedDays = historyDays || 7;
    const endedStartDate = new Date(now.getTime() - endedDays * 24 * 60 * 60 * 1000);
    const endedStartTime = `${endedStartDate.getFullYear()}-${String(endedStartDate.getMonth() + 1).padStart(2, '0')}-${String(endedStartDate.getDate()).padStart(2, '0')} 00:00:00`;
    const endedMetrics = [
      "all_groupon_live_pay_amount_td", "all_groupon_live_pay_order_cnt_td",
      "all_live_watch_cnt_td", "all_live_watch_ucnt_td",
      "all_ad_cost_amount_td", "roi2_ad_cost_amount_td", "std_ad_cost_amount_td"
    ];
    const fetchPageSize = 50;
    let allEndedRooms: LiveRoomData[] = [];
    let offset = 0;

    while (true) {
      const endedRes = await fetch(`https://localads.chengzijianzhan.cn/api/lamp/pc/v2/statistics/data/statQuery?advid=${advId}`, {
        method: 'POST',
        headers: { ...REQUEST_HEADERS, 'cookie': cookieStr },
        body: JSON.stringify({
          StartTime: endedStartTime,
          EndTime: endTime,
          Filters: {
            ConditionRelationshipType: 1,
            Conditions: [
              { Field: "advertiser_id", Values: [advId], Operator: 7 },
              { Field: "is_bind_ad", Values: ["1"], Operator: 7 },
              { Field: "custom_aweme_auth_type", Values: ["1", "2"], Operator: 7 }
            ]
          },
          Dimensions: baseDimensions,
          FrameId: "7325383500012503049",
          ModuleId: "7487942504222982182",
          DataSetKey: "live_analysis_live_details",
          Metrics: endedMetrics,
          PageParams: { Limit: fetchPageSize, Offset: offset }
        })
      });
      const endedData: any = await endedRes.json();
      const rows = endedData.data?.StatsData?.Rows || [];
      allEndedRooms.push(...parseRows(rows));
      const total = endedData.data?.StatsData?.TotalCount || 0;
      offset += fetchPageSize;
      if (offset >= total || rows.length < fetchPageSize) break;
    }

    // 从历史列表中去掉正在直播的（避免重复）
    const liveRoomIds = new Set(liveRooms.map(r => r.room_id));
    const endedRooms = allEndedRooms.filter(r => !liveRoomIds.has(r.room_id));

    return { live: liveRooms, ended: endedRooms };
  } catch (error) {
    logger.error(`获取账户 ${advId} 数据失败:`, error);
    return null;
  }
}

// 获取直播间漏斗数据
export async function getRoomFunnelData(advId: string, roomId: string, anchorId: string, cookies: CookieData[]): Promise<any> {
  const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
  const now = new Date();
  const endTime = formatLocalTime(new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59));
  const startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const startTime = formatLocalTime(new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate(), 0, 0, 0));

  try {
    const response = await fetch(`https://localads.chengzijianzhan.cn/api/lamp/pc/v2/statistics/data/statQuery?advid=${advId}`, {
      method: 'POST',
      headers: {
        ...REQUEST_HEADERS,
        'cookie': cookieStr
      },
      body: JSON.stringify({
        StartTime: startTime,
        EndTime: endTime,
        Filters: {
          ConditionRelationshipType: 1,
          Conditions: [
            { Field: "advertiser_id", Values: [advId], Operator: 7 },
            { Field: "room_id", Values: [roomId], Operator: 7 },
            { Field: "anchor_id", Values: [anchorId], Operator: 7 },
            { Field: "is_bind_ad", Values: ["1"], Operator: 7 }
          ]
        },
        Dimensions: [],
        FrameId: "7325383500012503049",
        ModuleId: "7487940410766196763",
        DataSetKey: "live_analysis_live_funnel",
        Metrics: ["all_live_show_cnt_td", "all_live_watch_cnt_td", "all_groupon_live_product_click_cnt_td", "all_groupon_live_pay_order_cnt_td"],
        PageParams: { Limit: 1000, Offset: 0 }
      })
    });

    const data: any = await response.json();
    const rows = data.data?.StatsData?.Rows || [];
    if (rows.length > 0) {
      const m = rows[0].Metrics || {};
      return {
        all_live_show_cnt_td: m.all_live_show_cnt_td?.Value || 0,
        all_live_watch_cnt_td: m.all_live_watch_cnt_td?.Value || 0,
        all_groupon_live_product_click_cnt_td: m.all_groupon_live_product_click_cnt_td?.Value || 0,
        all_groupon_live_pay_order_cnt_td: m.all_groupon_live_pay_order_cnt_td?.Value || 0
      };
    }
  } catch (error) {
    logger.error('获取漏斗数据失败:', error);
  }
  return null;
}
