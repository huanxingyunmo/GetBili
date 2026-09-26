/**
 * GetBili 全接口冒烟测试。
 *
 * 会真实请求本地 wrangler dev 服务（默认 http://127.0.0.1:8787），
 * 由服务端再去请求真实的 B 站上游接口。
 *
 * 用法：
 *   pnpm dev                 # 另一个终端先起服务
 *   node scripts/smoke.mjs
 *   SMOKE_BASE=http://127.0.0.1:8788 node scripts/smoke.mjs
 */

const BASE = process.env.SMOKE_BASE ?? 'http://127.0.0.1:8787';

/** 备选测试视频：取第一个能正常返回详情的 */
const VIDEO_CANDIDATES = ['BV1GJ411x7h7', 'BV17x411w7KC', 'BV1xx411c7mD', 'BV1uv411q7Mv'];

/**
 * 投稿列表的兜底 UP 主。
 *
 * `/x/space/wbi/arc/search` 的风控是按「账号 + 时间窗口」波动的，且 UP 主搜索
 * 接口本身常被拦（v_voucher），导致候选 mid 列表可能只剩详情接口给出的那一个。
 * 这里固定几个不同量级、不同领域的 mid 兜底，避免整项被误报成 SKIP。
 */
const UPLOADER_MID_FALLBACKS = [8047632, 2267573, 703007996];

const results = [];
let ctx = {};

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  const icon = ok === true ? 'PASS' : ok === 'skip' ? 'SKIP' : 'FAIL';
  console.log(`[${icon}] ${name}${detail ? ` — ${detail}` : ''}`);
}

async function check(name, fn) {
  try {
    const detail = await fn();
    record(name, true, detail);
  } catch (err) {
    record(name, false, err instanceof Error ? err.message : String(err));
  }
}

async function skipIf(cond, name, fn, reason) {
  if (cond) {
    record(name, 'skip', reason);
    return;
  }
  await check(name, fn);
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

/** 发请求并返回 { status, body, text } */
async function req(path, expectStatus = 200) {
  const url = path.startsWith('http') ? path : `${BASE}${path}`;
  const res = await fetch(url, { headers: { Accept: 'application/json, application/xml, */*' } });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  ctx.lastText = text;
  if (expectStatus !== null) {
    assert(
      res.status === expectStatus,
      `${path} 期望 HTTP ${expectStatus}，实际 ${res.status}：${text.slice(0, 200)}`,
    );
  }
  return { status: res.status, body, text };
}

/** 请求并断言业务 code === 0 */
async function reqOk(path) {
  const { body, text } = await req(path, 200);
  assert(body && body.code === 0, `${path} 业务码非 0：${text.slice(0, 200)}`);
  return body;
}

console.log(`\n=== GetBili 冒烟测试  base=${BASE} ===\n`);

// ---------- 0. 服务可达性 ----------
try {
  await req('/api/health', 200);
} catch (err) {
  console.error(`无法连接本地服务 ${BASE}，请先运行 pnpm dev。\n${err.message}`);
  process.exit(1);
}

// ---------- 1. 服务自描述 ----------
await check('GET / 服务自描述', async () => {
  const body = await reqOk('/');
  assert(body.data?.service?.name === 'GetBili API', '服务名不符');
  assert(Array.isArray(body.data.endpoints) && body.data.endpoints.length >= 10, '接口清单缺失');
  return `接口数 ${body.data.endpoints.length}，anonymous=${body.data.auth?.usingCookie === false}`;
});

await check('GET /api/health 健康检查', async () => {
  const body = await reqOk('/api/health');
  assert(body.data.status === 'ok', '状态异常');
  return `anonymous=${body.data.anonymous}`;
});

// ---------- 2. 选一个可用的测试视频 ----------
let bvid = null;
for (const candidate of VIDEO_CANDIDATES) {
  const { body } = await req(`/api/video/${candidate}`, null);
  if (body && body.code === 0) {
    bvid = candidate;
    break;
  }
}
if (!bvid) {
  record('挑选测试视频', false, `候选全部不可用：${VIDEO_CANDIDATES.join(', ')}`);
} else {
  record('挑选测试视频', true, bvid);
}
ctx.bvid = bvid;

const VIDEO = bvid ? `/api/video/${bvid}` : '/api/video/BV1GJ411x7h7';

// ---------- 3. 视频详情 ----------
await skipIf(
  !bvid,
  'GET /api/video/:id 视频详情',
  async () => {
    const body = await reqOk(`${VIDEO}?qualities=1`);
    const d = body.data;
    assert(d.bvid === bvid, `bvid 不一致：${d.bvid}`);
    assert(typeof d.aid === 'number' && d.aid > 0, `aid 异常：${d.aid}`);
    assert(typeof d.cid === 'number' && d.cid > 0, `cid 异常：${d.cid}`);
    assert(typeof d.title === 'string' && d.title.length > 0, 'title 为空');
    assert(d.cover.startsWith('https://'), `cover 未规范化：${d.cover}`);
    assert(typeof d.owner?.mid === 'number' && d.owner.mid > 0, 'owner.mid 异常');
    assert(typeof d.stat?.view === 'number', 'stat.view 缺失');
    assert(Array.isArray(d.pages) && d.pages.length > 0, 'pages 为空');
    assert(d.pages[0].cid > 0 && d.pages[0].title.length > 0, '第 1 P 字段缺失');
    assert(d.pageCount === d.pages.length, `pageCount(${d.pageCount}) != pages.length(${d.pages.length})`);
    assert(
      Array.isArray(d.qualities) && d.qualities.length > 0,
      'qualities=1 未返回清晰度列表',
    );
    const available = d.qualities.filter((q) => q.available).map((q) => `${q.qn}:${q.description}`);
    ctx.ownerMid = d.owner.mid;
    ctx.cid = d.cid;
    return `「${d.title.slice(0, 24)}」 UP=${d.owner.name} 时长=${d.duration}s 分P=${d.pageCount} 清晰度(可用)=[${available.join(' ')}]`;
  },
  '无可用测试视频',
);

// ---------- 4. 分 P ----------
await skipIf(
  !bvid,
  'GET /api/video/:id/pages 分P列表',
  async () => {
    const body = await reqOk(`${VIDEO}/pages`);
    assert(body.data.count === body.data.pages.length, 'count 与 pages 长度不一致');
    assert(body.data.pages[0].cid > 0, 'cid 异常');
    return `${body.data.count} 个分P，首个="${body.data.pages[0].title.slice(0, 20)}"`;
  },
  '无可用测试视频',
);

// ---------- 5. 清晰度 ----------
await skipIf(
  !bvid,
  'GET /api/video/:id/qualities 可用清晰度',
  async () => {
    const body = await reqOk(`${VIDEO}/qualities`);
    assert(body.data.cid > 0, 'cid 异常');
    assert(body.data.qualities.length > 0, '清晰度列表为空');
    return `${body.data.count} 项：[${body.data.qualities.map((q) => q.description).join(', ')}]`;
  },
  '无可用测试视频',
);

// ---------- 6. 播放地址（核心能力） ----------
await skipIf(
  !bvid,
  'GET /api/video/:id/playurl 播放地址',
  async () => {
    const body = await reqOk(`${VIDEO}/playurl?qn=80`);
    const d = body.data;
    assert(d.format === 'dash' || d.format === 'durl', `未知 format=${d.format}`);
    assert(d.bvid === bvid, 'bvid 不一致');
    assert(d.cid > 0, 'cid 异常');
    assert(d.qualityName.length > 0, 'qualityName 为空');

    const hasDash = d.dash && d.dash.video.length > 0 && d.dash.audio.length > 0;
    const hasDurl = Array.isArray(d.durl) && d.durl.length > 0;
    assert(hasDash || hasDurl, '既无 dash 也无 durl');

    if (hasDash) {
      const v = d.best.video;
      const a = d.best.audio;
      assert(v && v.baseUrl.startsWith('http'), 'best.video.baseUrl 异常');
      assert(a && a.baseUrl.startsWith('http'), 'best.audio.baseUrl 异常');
      // 校验 best 选择策略：应为 <= 请求清晰度中的最高者
      assert(v.id <= d.requestQn, `best.video.id=${v.id} 高于请求清晰度 ${d.requestQn}`);
      return `format=dash 流数=video(${d.dash.video.length})/audio(${d.dash.audio.length}) best=video[qn=${v.id} ${v.qualityName} ${v.codecs}] audio[${a.bandwidth}bps] 实际qn=${d.qn}`;
    }
    return `format=durl 段数=${d.durl.length} 地址=${d.durl[0].url.slice(0, 48)}...`;
  },
  '无可用测试视频',
);

// ---------- 7. 弹幕 JSON ----------
await skipIf(
  !bvid,
  'GET /api/video/:id/danmaku?format=json 弹幕',
  async () => {
    const body = await reqOk(`${VIDEO}/danmaku?format=json&maxSegments=2`);
    const d = body.data;
    assert(d.cid > 0, 'cid 异常');
    assert(Array.isArray(d.danmaku) && d.danmaku.length > 0, `弹幕为空（count=${d.count}）`);
    const first = d.danmaku[0];
    assert(typeof first.content === 'string' && first.content.length > 0, '弹幕内容为空');
    assert(typeof first.progress === 'number' && first.progress >= 0, 'progress 异常');
    assert(typeof first.id === 'number' && first.id > 0, 'id 异常');
    assert(typeof first.mode === 'number', 'mode 异常');
    assert(typeof first.color === 'number', 'color 异常');
    const modes = new Set(d.danmaku.map((x) => x.mode));
    return `共 ${d.count} 条，首条=${JSON.stringify(first.content.slice(0, 18))} progress=${first.progress}ms mode集合=[${[...modes].join(',')}]`;
  },
  '无可用测试视频',
);

// ---------- 8. 弹幕 XML ----------
await skipIf(
  !bvid,
  'GET /api/video/:id/danmaku?format=xml XML 输出',
  async () => {
    const { status, text } = await req(`${VIDEO}/danmaku?format=xml&maxSegments=1`, 200);
    assert(status === 200, `HTTP ${status}`);
    assert(text.startsWith('<?xml version="1.0" encoding="UTF-8"?>'), '缺少 XML 声明');
    assert(text.includes('<i>') && text.includes('</i>'), '缺少 <i> 根节点');
    const dCount = (text.match(/<d p="/g) ?? []).length;
    assert(dCount > 0, 'XML 中没有 <d> 弹幕节点');
    // 校验 p 属性为 8 段
    const m = text.match(/<d p="([^"]+)"/);
    const parts = m[1].split(',');
    assert(parts.length === 8, `p 属性应为 8 段，实际 ${parts.length}`);
    return `${dCount} 条 <d> 节点，p="${parts.join(',')}"`;
  },
  '无可用测试视频',
);

// ---------- 9. 合集 ----------
await skipIf(
  !bvid,
  'GET /api/video/:id/collection 所属合集',
  async () => {
    const { body, status } = await req(`${VIDEO}/collection`, null);
    if (status === 404 || (body && body.code === -404)) {
      return '该视频不属于任何合集（上游 404，符合预期）';
    }
    assert(body && body.code === 0, `意外响应：${JSON.stringify(body)?.slice(0, 160)}`);
    const d = body.data;
    assert(d.info.type === 'collection', 'type 异常');
    assert(d.videos.length > 0, '合集视频列表为空');
    assert(d.videos[0].bvid.startsWith('BV'), 'bvid 异常');
    assert(d.videos[0].cover.startsWith('https://'), 'cover 未规范化');
    return `合集「${d.info.title}」共 ${d.info.count} 个视频，首个=${d.videos[0].bvid}`;
  },
  '无可用测试视频',
);

// ---------- 10. UP 主信息 ----------
await skipIf(
  !ctx.ownerMid,
  'GET /api/user/:mid UP主信息',
  async () => {
    const body = await reqOk(`/api/user/${ctx.ownerMid}`);
    const d = body.data;
    assert(d.mid === ctx.ownerMid, `mid 不一致：${d.mid}`);
    assert(d.name.length > 0, 'name 为空');
    assert(d.face.startsWith('https://'), `face 未规范化：${d.face}`);
    assert(typeof d.follower === 'number', 'follower 缺失');
    assert(typeof d.video === 'number', 'video 缺失');
    return `${d.name} 粉丝=${d.follower} 投稿=${d.video} 等级=${d.level}`;
  },
  '未取到 UP 主 mid',
);

// ---------- 11. UP 主投稿 ----------
// 该接口（/x/space/wbi/arc/search）有按账号 + 时间窗口波动的风控，
// 单个 mid 可能返回 -412「request was banned」。这里依次尝试多个 mid，
// 只要有一个成功即视为接口可用；全部失败则如实报告为 SKIP（环境性风控）。
let uploaderVideosMid = null;
{
  const candidates = [];
  if (ctx.ownerMid) candidates.push(ctx.ownerMid);
  for (const mid of UPLOADER_MID_FALLBACKS) {
    if (!candidates.includes(mid)) candidates.push(mid);
  }
  try {
    const body = await reqOk('/api/search/user?keyword=%E7%94%B5%E5%BD%B1&pageSize=10');
    for (const u of body.data.items ?? []) {
      if (u.mid && !candidates.includes(u.mid)) candidates.push(u.mid);
    }
  } catch {
    /* 搜索失败不阻断 */
  }
  let firstOkBody = null;
  let firstOkMid = null;
  for (const mid of candidates.slice(0, 5)) {
    const { body } = await req(`/api/user/${mid}/videos?page=1&pageSize=5`, null);
    if (!body || body.code !== 0) continue;
    if (firstOkBody === null) {
      firstOkBody = body;
      firstOkMid = mid;
    }
    // 优先选一个真正有数据的分支，这样才能验证字段映射
    if ((body.data?.items?.length ?? 0) > 0) {
      uploaderVideosMid = mid;
      ctx.uploaderVideosBody = body;
      break;
    }
  }
  if (uploaderVideosMid === null && firstOkBody !== null) {
    uploaderVideosMid = firstOkMid;
    ctx.uploaderVideosBody = firstOkBody;
  }
}

await skipIf(
  !uploaderVideosMid,
  'GET /api/user/:mid/videos 投稿列表',
  async () => {
    const body = ctx.uploaderVideosBody ?? (await reqOk(`/api/user/${uploaderVideosMid}/videos?page=1&pageSize=5`));
    const d = body.data;
    assert(Array.isArray(d.items), 'items 非数组');
    // 过滤关键词后可能为空（属于正常结果），但总数应可用
    assert(typeof d.total === 'number', 'total 缺失');
    assert(d.page === 1 && d.pageSize === 5, `分页回显异常 page=${d.page} size=${d.pageSize}`);
    if (d.items.length === 0) {
      // 空列表必须携带软拦截告警（否则就是静默的错误答案）
      assert(
        typeof body.meta?.warning === 'string' && body.meta.warning.length > 0,
        '返回空列表但未携带软拦截告警（静默错误答案）',
      );
      return `mid=${uploaderVideosMid} 返回空列表（total=0），已附软拦截告警`;
    }
    const first = d.items[0];
    assert(first.bvid.startsWith('BV'), `bvid 异常：${first.bvid}`);
    assert(first.title.length > 0, 'title 为空');
    assert(first.url.includes(first.bvid), 'url 与 bvid 不匹配');
    // 上游时长字段是 "04:28" 文本，这里验证确实被解析成了秒数
    assert(first.duration > 0, `duration 未正确解析（长度字段 length 解析失败）：${first.duration}`);
    return `mid=${uploaderVideosMid} total=${d.total} pageCount=${d.pageCount} hasMore=${d.hasMore} 首个=${first.bvid}「${first.title.slice(0, 18)}」时长=${first.duration}s`;
  },
  '所有候选 UP 主均被风控拦截（-412），属环境性问题；配置 BILI_COOKIE 可显著改善',
);

// ---------- 12. 视频搜索（WBI 签名链路） ----------
// 搜索接口对同 IP 的连续请求会限流（返回 v_voucher 风控应答）。这里轮换多个
// 关键词、并在两次之间稍作等待，给它合理通过的机会。
await check('GET /api/search/video 视频搜索', async () => {
  const keywords = ['罗翔', '影视飓风', '纪录片'];
  let riskMessage = '';
  for (const keyword of keywords) {
    const { status, body } = await req(
      `/api/search/video?keyword=${encodeURIComponent(keyword)}&pageSize=5`,
      null,
    );
    if (status === 200 && body?.code === 0) {
      const d = body.data;
      assert(Array.isArray(d.items) && d.items.length > 0, `静默返回空列表 —— 风控未被识别`);
      const first = d.items[0];
      assert(first.bvid.startsWith('BV'), `bvid 异常：${first.bvid}`);
      assert(first.title.length > 0, 'title 为空');
      assert(!first.title.includes('<em'), `标题未清理高亮标签：${first.title}`);
      assert(first.cover.startsWith('https://'), `cover 未规范化：${first.cover}`);
      assert(first.duration > 0, `duration 未解析（应为 MM:SS 文本转秒数）：${first.duration}`);
      return `关键词「${keyword}」total=${d.total} 首个=${first.bvid}「${first.title.slice(0, 20)}」时长=${first.duration}s`;
    }
    assert(status === 429 && body?.code === -412, `意外响应 HTTP ${status}：${JSON.stringify(body).slice(0, 140)}`);
    riskMessage = body.message;
    await new Promise((r) => setTimeout(r, 1500));
  }
  // 所有关键词都被限流：行为本身是正确的（明确报错而非伪成功空列表），如实记录
  return `全部关键词被 B 站限流拦截（已正确识别，未伪成功）：${riskMessage.slice(0, 40)}…`;
});

// ---------- 13. UP 主搜索 ----------
// 说明：UP 主搜索（search_type=bili_user）在未登录状态下高概率被 B 站要求
// 风控验证（响应只有 v_voucher）。此处接受两种「正确」结果：
//   a) 正常返回搜索结果
//   b) 明确报错（429 / code=-412）并提示配置 BILI_COOKIE
// 唯一不可接受的是「HTTP 200 + 空列表」这种静默伪成功。
await check('GET /api/search/user UP主搜索（含风控处理）', async () => {
  const { status, body } = await req('/api/search/user?keyword=%E5%93%94%E5%93%A9&pageSize=5', null);

  if (status === 200 && body?.code === 0) {
    const d = body.data;
    assert(Array.isArray(d.items) && d.items.length > 0, '静默返回空列表 —— 风控未被识别');
    const first = d.items[0];
    assert(first.mid > 0, `mid 异常：${first.mid}`);
    assert(first.name.length > 0, 'name 为空');
    assert(!first.name.includes('<em'), '昵称未清理高亮标签');
    return `total=${d.total} 首个=mid:${first.mid}「${first.name}」粉丝=${first.fans}`;
  }

  assert(status === 429, `期望 200 或 429，实际 ${status}：${JSON.stringify(body).slice(0, 160)}`);
  assert(body?.code === -412, `风控错误码应为 -412，实际 ${body?.code}`);
  assert(
    typeof body.message === 'string' && body.message.includes('BILI_COOKIE'),
    '风控错误信息未提示 BILI_COOKIE 解决方案',
  );
  return `已正确识别风控：HTTP ${status} code=${body.code}「${body.message.slice(0, 34)}…」`;
});

// ---------- 14. 收藏夹 ----------
// 收藏夹是否可读取决于 UP 主有没有把文件夹设为公开，随机 UP 主大多没有。
// 因此先从候选 UP 主动态探测，探测不到时回退到一个实测存在的公开收藏夹
// （B站 × WAIC AI会客厅，up_mid=8047632），保证该接口每轮都能被真实验证。
const KNOWN_PUBLIC_FAVLIST = 4026748432;
let favMediaId = null;
let favOwnerName = '';
{
  const candidateMids = [];
  if (ctx.ownerMid) candidateMids.push(ctx.ownerMid);
  try {
    const body = await reqOk('/api/search/user?keyword=%E5%93%94%E5%93%A9&pageSize=10');
    for (const u of body.data.items ?? []) {
      if (u.mid && !candidateMids.includes(u.mid)) candidateMids.push(u.mid);
    }
  } catch {
    /* 搜索可能被风控，不阻断 */
  }
  candidateMids.push(8047632);

  for (const mid of candidateMids.slice(0, 12)) {
    try {
      const res = await fetch(
        `https://api.bilibili.com/x/v3/fav/folder/created/list-all?up_mid=${mid}`,
        {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
            Referer: 'https://space.bilibili.com/',
          },
        },
      );
      const json = await res.json();
      const list = json?.data?.list ?? [];
      const hit = list.find((f) => (f.media_count ?? 0) > 0);
      if (hit?.id) {
        favMediaId = hit.id;
        favOwnerName = `mid=${mid} ${hit.title ?? ''}`;
        break;
      }
    } catch {
      /* 继续尝试下一个 */
    }
  }

  if (!favMediaId) {
    favMediaId = KNOWN_PUBLIC_FAVLIST;
    favOwnerName = '已知公开收藏夹（探测未命中，使用固定用例）';
  }
}

await check('GET /api/favlist/:mediaId 收藏夹内容', async () => {
  const body = await reqOk(`/api/favlist/${favMediaId}?page=1&pageSize=5`);
  const d = body.data;
  assert(d.info.type === 'favlist', 'type 异常');
  assert(d.info.id === favMediaId, `info.id 不一致：${d.info.id}`);
  assert(d.info.title.length > 0, 'info.title 为空');
  assert(d.info.count > 0, `info.count 异常：${d.info.count}`);
  assert(d.info.upperName.length > 0, 'info.upperName 为空');
  assert(Array.isArray(d.videos) && d.videos.length > 0, 'videos 为空');
  assert(d.page === 1 && d.pageSize === 5, '分页回显异常');

  const first = d.videos[0];
  assert(first.bvid.startsWith('BV'), `bvid 异常：${first.bvid}`);
  assert(first.title.length > 0, 'title 为空');
  assert(first.cover.startsWith('https://'), `cover 未规范化：${first.cover}`);
  assert(first.duration > 0, `duration 异常：${first.duration}`);
  assert(first.ownerName.length > 0, 'ownerName 为空');
  assert(typeof d.hasMore === 'boolean', 'hasMore 非布尔');

  return `收藏夹「${d.info.title}」(up=${d.info.upperName}) total=${d.info.count} 返回=${d.videos.length} 首个=${first.bvid}「${first.title.slice(0, 18)}」时长=${first.duration}s`;
});

// ---------- 15. 错误处理 ----------
await check('错误处理：非法视频标识 → 400', async () => {
  const { status, body } = await req('/api/video/not-a-valid-id', null);
  assert(status === 400, `期望 400，实际 ${status}`);
  assert(body?.code === -400, `期望 code=-400，实际 ${body?.code}`);
  return `HTTP 400，code=${body.code}，msg=${body.message.slice(0, 40)}`;
});

await check('错误处理：缺少 keyword → 400', async () => {
  const { status, body } = await req('/api/search/video', null);
  assert(status === 400, `期望 400，实际 ${status}`);
  return `HTTP 400，msg=${body.message.slice(0, 40)}`;
});

await check('错误处理：不存在的路由 → 404', async () => {
  const { status, body } = await req('/api/does-not-exist', null);
  assert(status === 404, `期望 404，实际 ${status}`);
  return `HTTP 404，msg=${body.message.slice(0, 40)}`;
});

await check('错误处理：非法/不存在的 BV → 绝不返回伪成功', async () => {
  // BV1zzzzzzzzzz 是格式合法但上游拒绝的号；断言不会出现 code=0 的「伪成功」
  const { status, body } = await req('/api/video/BV1zzzzzzzzzz', null);
  assert([400, 404, 502].includes(status), `期望 400/404/502，实际 ${status}`);
  assert(body?.code !== 0, `不应返回成功，实际 code=${body?.code}`);
  assert(body?.data === null || body?.data === undefined, '错误响应不应携带 data');
  return `HTTP ${status}，code=${body.code}，msg=${(body.message ?? '').slice(0, 40)}`;
});

// ---------- 16. CORS ----------
await check('CORS：普通请求带回允许来源', async () => {
  const res = await fetch(`${BASE}/api/health`, { headers: { Origin: 'https://example.com' } });
  const allow = res.headers.get('access-control-allow-origin');
  assert(allow !== null, '缺少 Access-Control-Allow-Origin');
  return `Allow-Origin=${allow}`;
});

await check('CORS：OPTIONS 预检 → 204', async () => {
  const res = await fetch(`${BASE}/api/video/BV1GJ411x7h7`, {
    method: 'OPTIONS',
    headers: { Origin: 'https://example.com', 'Access-Control-Request-Method': 'GET' },
  });
  assert(res.status === 204, `期望 204，实际 ${res.status}`);
  return `204，Allow-Methods=${res.headers.get('access-control-allow-methods')}`;
});

// ---------- 17. 完整链接作为入参 ----------
await skipIf(
  !bvid,
  '兼容入参：URL 编码的完整视频链接',
  async () => {
    const encoded = encodeURIComponent(`https://www.bilibili.com/video/${bvid}/?spm_id_from=333.999`);
    const body = await reqOk(`/api/video/${encoded}`);
    assert(body.data.bvid === bvid, `bvid 不一致：${body.data.bvid}`);
    return `解析成功 → ${body.data.bvid}`;
  },
  '无可用测试视频',
);

// ---------- 汇总 ----------
const pass = results.filter((r) => r.ok === true).length;
const fail = results.filter((r) => r.ok === false).length;
const skip = results.filter((r) => r.ok === 'skip').length;

console.log('\n====================== 汇总 ======================');
console.log(`PASS ${pass}   FAIL ${fail}   SKIP ${skip}   共 ${results.length} 项`);
if (fail > 0) {
  console.log('\n失败项：');
  for (const r of results.filter((x) => x.ok === false)) {
    console.log(`  - ${r.name}\n    ${r.detail}`);
  }
}
console.log('=================================================\n');

process.exit(fail === 0 ? 0 : 1);
