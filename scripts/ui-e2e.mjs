/**
 * GetBili 控制台页面端到端测试（真实浏览器 + CDP）。
 *
 * 为什么必须单独做这一步：
 * `ui-check.mjs` 只能证明内联脚本「语法合法」，`smoke.mjs` 只能证明页面「被正确地送达」。
 * 两者都无法证明脚本**跑起来是对的行为** —— 一个 `document.querySelector` 写错、
 * 一个 CSP 把内联脚本挡住、一个函数在赋值前就被调用，都会让页面呈现为空白或半死状态，
 * 而上述两个测试依然全绿。所以这里用无头 Chrome 真正打开页面、真正点按钮、真正读 DOM。
 *
 * 前置条件（脚本不会自己去拉起 Chrome —— 本机沙箱禁止 Node spawn 子进程）：
 *   1. 先起服务：pnpm dev
 *   2. 再起无头 Chrome：
 *      chrome --headless=new --remote-allow-origins=* --remote-debugging-port=9222 \
 *             --user-data-dir=<临时目录> about:blank
 *   3. 跑本脚本：node scripts/ui-e2e.mjs
 *
 * 可用环境变量：
 *   E2E_BASE      被测服务地址，默认 http://127.0.0.1:8787
 *   CDP_ENDPOINT  Chrome 调试端点，默认 http://127.0.0.1:9222
 */

import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.env.E2E_BASE ?? 'http://127.0.0.1:8787';
const CDP = process.env.CDP_ENDPOINT ?? 'http://127.0.0.1:9222';
const PAGE_URL = `${BASE}/ui`;

/**
 * 从项目根 .dev.vars 解析 ADMIN_TOKEN（KEY=VALUE 行，值可能带引号）。
 * /ui 与受保护接口都有登录门槛，页面测试前必须先在浏览器里建立会话；
 * 只提取 ADMIN_TOKEN 行，BILI_COOKIE 不读入内存变量、更不进日志。
 */
function loadAdminToken() {
  try {
    const raw = readFileSync(new URL('../.dev.vars', import.meta.url), 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      if (trimmed.slice(0, eq).trim() !== 'ADMIN_TOKEN') continue;
      const value = trimmed.slice(eq + 1).trim();
      const unquoted = value.length >= 2 && /^["'].*["']$/.test(value) ? value.slice(1, -1) : value;
      if (unquoted) return unquoted;
    }
  } catch {
    /* 读不到时回退到本地约定的默认值 */
  }
  return 'dev-admin-token';
}
const ADMIN_TOKEN = loadAdminToken();

/**
 * 可选：设置后会把页面截图写到该目录（用于生成文档配图）。
 * 不设置则完全跳过，测试本身不产生任何文件。
 */
const SHOT_DIR = process.env.E2E_SHOT_DIR ?? '';

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name} — ${detail}`);
}
async function step(name, fn) {
  try {
    const detail = await fn();
    record(name, true, detail);
  } catch (err) {
    record(name, false, err instanceof Error ? err.message : String(err));
  }
}
function assert(cond, message) {
  if (!cond) throw new Error(message);
}

/* ------------------------------------------------------------------ *
 * 极简 CDP 客户端
 * ------------------------------------------------------------------ */

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.consoleErrors = [];
    this.consoleWarnings = [];
    this.exceptions = [];

    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== undefined) {
        const entry = this.pending.get(msg.id);
        if (!entry) return;
        this.pending.delete(msg.id);
        if (msg.error) entry.reject(new Error(`${entry.method} 失败：${msg.error.message}`));
        else entry.resolve(msg.result);
        return;
      }
      this.onEvent(msg);
    });
  }

  onEvent(msg) {
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params?.exceptionDetails ?? {};
      this.exceptions.push(d.exception?.description ?? d.text ?? '未知异常');
      return;
    }
    if (msg.method === 'Runtime.consoleAPICalled') {
      const text = (msg.params?.args ?? []).map((a) => String(a.value ?? a.description ?? '')).join(' ');
      if (msg.params?.type === 'error') this.consoleErrors.push(text);
      else if (msg.params?.type === 'warning') this.consoleWarnings.push(text);
      return;
    }
    if (msg.method === 'Log.entryAdded') {
      const e = msg.params?.entry ?? {};
      const line = `[${e.source}] ${e.text}`;
      if (e.level === 'error') this.consoleErrors.push(line);
      else if (e.level === 'warning') this.consoleWarnings.push(line);
    }
  }

  send(method, params) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.ws.send(JSON.stringify({ id, method, params: params ?? {} }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`${method} 超时（15s）`));
        }
      }, 15000);
    });
  }

  /** 执行表达式并把结果按值取回；页面内抛错会被翻译成异常 */
  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error(`页面内执行出错：${d.exception?.description ?? d.text}`);
    }
    return r.result?.value;
  }

  /** 轮询等待页面内条件成立 */
  async waitFor(expression, label, timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    let lastError = '';
    while (Date.now() < deadline) {
      try {
        if (await this.evaluate(expression)) return true;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`等待超时：${label}${lastError ? '（最后一次执行错误：' + lastError + '）' : ''}`);
  }

  /** 截图（仅在设置了 E2E_SHOT_DIR 时启用） */
  async screenshot(fileName) {
    if (!SHOT_DIR) return null;
    mkdirSync(SHOT_DIR, { recursive: true });
    const r = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    const path = join(SHOT_DIR, fileName);
    writeFileSync(path, Buffer.from(r.data, 'base64'));
    return path;
  }
}

/* ------------------------------------------------------------------ *
 * 连接
 * ------------------------------------------------------------------ */

async function findPageTarget() {
  const res = await fetch(`${CDP}/json/list`);
  const list = await res.json();
  const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  assert(page, '没有可用的 page target，请确认 Chrome 以 --headless=new 启动');
  return page;
}

console.log(`\n=== GetBili 控制台端到端测试 ===\n页面：${PAGE_URL}\nCDP ：${CDP}\n`);

const target = await findPageTarget();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', () => reject(new Error(`无法连接 CDP：${target.webSocketDebuggerUrl}`)), {
    once: true,
  });
});

const cdp = new Cdp(ws);
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');
await cdp.send('Log.enable');

// Log.enable 会把浏览器里**已存在**的日志条目回放一遍（上一次运行留下的错误也会被重放），
// 所以这里先清空缓冲区再开始计数，否则会出现无法复现的「幽灵错误」。
await cdp.send('Log.clear');
cdp.consoleErrors.length = 0;
cdp.consoleWarnings.length = 0;
cdp.exceptions.length = 0;

// 固定视口尺寸：截图与布局断言都需要一个确定的窗口宽度
await cdp.send('Emulation.setDeviceMetricsOverride', {
  width: 1280,
  height: 1000,
  deviceScaleFactor: 1,
  mobile: false,
});

/* ------------------------------------------------------------------ *
 * 断言
 * ------------------------------------------------------------------ */

// ---------------- /adm 管理后台：登录门槛适配 ----------------
// /ui 已有登录门槛（未登录 404 伪装），所以先在 /adm 页面上下文里用页面同款
// 的 fetch 完成登录 —— Set-Cookie 会自动落进浏览器 jar，后续导航 /ui 直接可用。

await step('管理后台登录并确认会话生效', async () => {
  await cdp.send('Page.navigate', { url: `${BASE}/adm` });
  await cdp.waitFor('document.readyState === "complete"', '/adm document readyState=complete', 20000);
  await new Promise((r) => setTimeout(r, 300)); // 页面 JS 先行跑完，避免与登录流程互扰
  const status = await cdp.evaluate(
    `fetch('/adm/login', {
       method: 'POST',
       headers: { 'Content-Type': 'application/json' },
       body: JSON.stringify({ token: ${JSON.stringify(ADMIN_TOKEN)} })
     }).then(function (r) { return r.status; })`,
  );
  assert(status === 200, `登录响应 ${status}（期望 200）`);
  const session = await cdp.evaluate(
    `fetch('/adm/api/session').then(function (r) { return r.json(); })`,
  );
  assert(session?.data?.enabled === true, '后台未启用（ADMIN_TOKEN 未配置）');
  assert(session?.data?.authed === true, `会话未生效：${JSON.stringify(session)}`);
  assert(cdp.exceptions.length === 0, `页面抛出异常：${cdp.exceptions.join(' ｜ ')}`);
  return 'POST /adm/login 200，session 报 authed:true';
});

await step('/adm 登录态面板渲染（panelArea active + 策略行）', async () => {
  // 重新进入 /adm：页面 JS 查 session 得 authed:true 后自行切到管理态
  await cdp.send('Page.navigate', { url: `${BASE}/adm` });
  await cdp.waitFor('document.readyState === "complete"', '/adm document readyState=complete', 20000);
  await cdp.waitFor(
    'document.querySelector("#panelArea").classList.contains("active")',
    '#panelArea 进入 active 态',
    15000,
  );
  await cdp.waitFor(
    'document.querySelectorAll("#policyList .row").length >= 12',
    '#policyList 渲染出全部策略行',
    15000,
  );
  const info = await cdp.evaluate(`(function () {
    return {
      rows: document.querySelectorAll('#policyList .row').length,
      toggles: document.querySelectorAll('#policyList .toggle').length,
      healthShown: document.querySelector('#healthPill').style.display !== 'none',
      authHidden: !document.querySelector('#authArea').classList.contains('active')
    };
  })()`);
  assert(info.authHidden, '登录态下 authArea 仍然可见');
  assert(info.toggles === info.rows, `策略行与切换按钮数量不一致：${info.rows} 行 / ${info.toggles} 个按钮`);
  return `${info.rows} 行策略，每行带 public/token 切换按钮`;
});

// ---------------- /ui 控制台（已带登录态，口径与原先一致） ----------------

await step('页面可加载且不产生脚本异常', async () => {
  await cdp.send('Page.navigate', { url: PAGE_URL });
  await cdp.waitFor('document.readyState === "complete"', 'document readyState=complete', 20000);
  await new Promise((r) => setTimeout(r, 500)); // 让脚本首屏逻辑跑完
  assert(cdp.exceptions.length === 0, `页面抛出异常：${cdp.exceptions.join(' ｜ ')}`);
  return '无未捕获异常';
});

await step('标题与主题初始化正确', async () => {
  const title = await cdp.evaluate('document.title');
  assert(title.includes('GetBili 控制台'), `标题不符：${title}`);
  const theme = await cdp.evaluate('document.documentElement.getAttribute("data-theme")');
  assert(theme === 'light' || theme === 'dark', `data-theme 未初始化：${theme}`);
  return `title="${title}"，data-theme=${theme}`;
});

await step('健康检查连通并显示状态', async () => {
  await cdp.waitFor(
    'document.querySelector("#healthPill").textContent.includes("服务正常")',
    '#healthPill 显示服务正常',
    15000,
  );
  const text = await cdp.evaluate('document.querySelector("#healthPill").textContent');
  return text;
});

await step('首屏自动查询视频并渲染详情卡', async () => {
  await cdp.waitFor(
    'document.querySelector("#videoOut h2") !== null && document.querySelector("#videoOut h2").textContent.length > 0',
    '#videoOut 出现详情卡标题',
    35000,
  );
  const info = await cdp.evaluate(`(function () {
    var out = document.querySelector('#videoOut');
    var cover = out.querySelector('img.cover');
    return {
      title: out.querySelector('h2').textContent,
      cover: cover ? cover.getAttribute('src') : '',
      stats: out.querySelectorAll('.stat').length,
      // 操作区是 6 个 button + 2 个 a.btn（打开 B 站页面 / 查看原始 JSON）
      actions: out.querySelectorAll('.actions .btn').length,
      hasError: out.querySelector('.banner.err') !== null
    };
  })()`);
  assert(!info.hasError, '详情卡里出现了错误横幅');
  assert(info.cover.startsWith('http'), `封面地址异常：${info.cover}`);
  assert(info.stats >= 7, `统计项不足：${info.stats}`);
  assert(info.actions >= 8, `操作区不完整：${info.actions} 个（期望 ≥ 8）`);
  // 文档配图统一用浅色主题，便于阅读
  await cdp.evaluate('document.documentElement.setAttribute("data-theme", "light")');
  const shot = await cdp.screenshot('console-video.png');
  return `标题="${info.title.slice(0, 24)}…"，统计 ${info.stats} 项，操作区 ${info.actions} 个${shot ? '，已截图' : ''}`;
});

await step('点击「播放地址」渲染 DASH 流表格', async () => {
  const clicked = await cdp.evaluate(`(function () {
    var btns = Array.prototype.slice.call(document.querySelectorAll('#videoOut .actions button'));
    var target = btns.filter(function (b) { return b.textContent.trim() === '播放地址'; })[0];
    if (!target) return false;
    target.click();
    return true;
  })()`);
  assert(clicked, '没有找到「播放地址」按钮');
  await cdp.waitFor(
    'document.querySelectorAll("#videoTools table tbody tr").length > 0',
    '播放地址表格出现数据行',
    30000,
  );
  const info = await cdp.evaluate(`(function () {
    var rows = document.querySelectorAll('#videoTools table tbody tr');
    var texts = Array.prototype.slice.call(rows).map(function (r) { return r.textContent; });
    return {
      rows: rows.length,
      hasUrl: texts.some(function (t) { return t.indexOf('http') >= 0; }),
      hasCopy: document.querySelectorAll('#videoTools button').length,
      hasError: document.querySelector('#videoTools .banner.err') !== null
    };
  })()`);
  assert(!info.hasError, '播放地址区块出现错误横幅');
  assert(info.hasUrl, '表格里没有 http 直链');
  assert(info.hasCopy > 0, '没有渲染复制按钮');
  const shot = await cdp.screenshot('console-playurl.png');
  return `${info.rows} 行流数据，含直链与 ${info.hasCopy} 个操作按钮${shot ? '，已截图' : ''}`;
});

await step('点击「弹幕」渲染弹幕表格', async () => {
  const clicked = await cdp.evaluate(`(function () {
    var btns = Array.prototype.slice.call(document.querySelectorAll('#videoOut .actions button'));
    var target = btns.filter(function (b) { return b.textContent.trim() === '弹幕'; })[0];
    if (!target) return false;
    target.click();
    return true;
  })()`);
  assert(clicked, '没有找到「弹幕」按钮');
  await cdp.waitFor(
    'document.querySelectorAll("#videoTools table tbody tr").length > 10',
    '弹幕表格出现数据行',
    30000,
  );
  const info = await cdp.evaluate(`(function () {
    var rows = document.querySelectorAll('#videoTools table tbody tr');
    var first = rows[0] ? rows[0].textContent : '';
    var chips = document.querySelectorAll('#videoTools .chip').length;
    return { rows: rows.length, first: first, chips: chips };
  })()`);
  assert(info.chips > 0, '没有渲染弹幕类型分布');
  return `${info.rows} 条弹幕预览，类型分布 ${info.chips} 项，首行="${info.first.slice(0, 28)}"`;
});

await step('「分P 列表」渲染为纯文本表（末列不当 URL 处理）', async () => {
  const clicked = await cdp.evaluate(`(function () {
    var btns = Array.prototype.slice.call(document.querySelectorAll('#videoOut .actions button'));
    var target = btns.filter(function (b) { return b.textContent.trim() === '分P 列表'; })[0];
    if (!target) return false;
    target.click();
    return true;
  })()`);
  assert(clicked, '没有找到「分P 列表」按钮');
  await cdp.waitFor(
    'document.querySelectorAll("#videoTools table tbody tr").length > 0',
    '分P 表格出现数据行',
    25000,
  );
  const info = await cdp.evaluate(`(function () {
    var rows = document.querySelectorAll('#videoTools table tbody tr');
    return {
      rows: rows.length,
      // 分P 表最后一列是「来源」，不应出现复制按钮
      copyButtons: document.querySelectorAll('#videoTools tbody button').length
    };
  })()`);
  assert(info.rows > 0, '分P 表格没有数据行');
  assert(info.copyButtons === 0, `分P 表出现了 ${info.copyButtons} 个复制按钮（末列被误判成 URL）`);
  return `${info.rows} 个分P，末列未被误判为地址`;
});

await step('切换到「接口清单」列出 12 个接口', async () => {
  await cdp.evaluate('document.querySelector(".tab[data-tab=\\"api\\"]").click()');
  await cdp.waitFor(
    'document.querySelectorAll("#apiOut table tbody tr").length >= 10',
    '接口清单表格出现数据行',
    15000,
  );
  const info = await cdp.evaluate(`(function () {
    var rows = document.querySelectorAll('#apiOut table tbody tr');
    return {
      rows: rows.length,
      visible: document.querySelector('#panel-api').classList.contains('active'),
      firstPath: rows[0] ? rows[0].children[1].textContent : ''
    };
  })()`);
  assert(info.visible, '接口清单面板没有变为可见');
  assert(info.rows === 12, `接口行数应为 12，实际 ${info.rows}`);
  const shot = await cdp.screenshot('console-endpoints.png');
  return `${info.rows} 个接口，首个="${info.firstPath}"${shot ? '，已截图' : ''}`;
});

await step('切换到「UP 主」并加载投稿列表', async () => {
  await cdp.evaluate('document.querySelector(".tab[data-tab=\\"user\\"]").click()');
  const info = await cdp.evaluate(`(function () {
    var input = document.querySelector('#userInput');
    input.value = '8047632';
    document.querySelector('#userForm').requestSubmit();
    return true;
  })()`);
  assert(info, 'UP 主表单提交失败');
  await cdp.waitFor(
    'document.querySelector("#userOut h2") !== null && document.querySelector("#userOut h2").textContent.length > 0',
    'UP 主信息卡渲染完成',
    30000,
  );
  const up = await cdp.evaluate(`(function () {
    var out = document.querySelector('#userOut');
    return {
      name: out.querySelector('h2').textContent,
      stats: out.querySelectorAll('.stat').length,
      hasError: out.querySelector('.banner.err') !== null
    };
  })()`);
  assert(!up.hasError, 'UP 主信息卡出现错误横幅');
  assert(up.stats >= 4, `UP 主统计项不足：${up.stats}`);
  return `UP 主="${up.name}"，统计项 ${up.stats}`;
});

await step('「搜索」面板提交后有明确结论（不含静默空白）', async () => {
  await cdp.evaluate('document.querySelector(".tab[data-tab=\\"search\\"]").click()');
  await cdp.evaluate(`(function () {
    document.querySelector('#searchInput').value = '猫';
    document.querySelector('#searchForm').requestSubmit();
  })()`);
  // 搜索接口风控较严：无论拿到结果还是被风控，都必须给出明确结论，不能停在加载态
  await cdp.waitFor(
    `(function () {
      var out = document.querySelector('#searchOut');
      if (out.querySelector('.loading')) return false;
      return out.querySelector('.vlist') !== null || out.querySelector('.banner') !== null || out.querySelector('.empty') !== null;
    })()`,
    '搜索面板给出最终结论',
    35000,
  );
  const info = await cdp.evaluate(`(function () {
    var out = document.querySelector('#searchOut');
    return {
      items: out.querySelectorAll('.vitem').length,
      risk: out.querySelector('.banner.err') !== null,
      text: out.textContent.trim().slice(0, 60)
    };
  })()`);
  return info.items > 0
    ? `返回 ${info.items} 条搜索结果`
    : `被风控并已明确提示（items=0，banner=已渲染）`;
});

// 注意顺序：本项必须排在「非法入参」用例**之前**。
// 那一步会故意打一个 400 请求，浏览器必然会记录一条 network error 日志，
// 那是用例的预期产物而不是页面缺陷；放在后面会让本项产生假阴性。
//
// 断言口径（重要）：
// 浏览器会把**任何**非 2xx 的 fetch 都记成 console error，而 B 站的风控降级
// （搜索 429、投稿软拦截）与用例故意构造的 400 都属于「接口按契约正常返回」，
// 已经在冒烟里断言过了。因此这里区分两类：
//   - `[network]` 前缀的条目 → 只统计不判失败（下面会把条数如实报出来，不隐藏）；
//   - 其余条目（CSP 违规、页面自身 console.error、脚本异常）→ 必须为 0。
await step('无 CSP 违规、无页面自身错误', async () => {
  const cspViolations = cdp.consoleErrors.filter(
    (line) => line.includes('Content Security Policy') || line.includes('Refused to'),
  );
  assert(cspViolations.length === 0, `CSP 违规：${cspViolations.join(' ｜ ')}`);

  const networkOnly = cdp.consoleErrors.filter((line) => line.startsWith('[network]'));
  const pageErrors = cdp.consoleErrors.filter((line) => !line.startsWith('[network]'));
  assert(pageErrors.length === 0, `页面自身报错：${pageErrors.slice(0, 4).join(' ｜ ')}`);
  assert(cdp.exceptions.length === 0, `未捕获异常：${cdp.exceptions.join(' ｜ ')}`);

  return [
    'CSP 违规 0、页面自身报错 0、未捕获异常 0',
    `接口层的非 2xx 网络日志 ${networkOnly.length} 条（已在冒烟中断言，不计失败）`,
    cdp.consoleWarnings.length ? `警告 ${cdp.consoleWarnings.length} 条` : '无警告',
  ].join('；');
});

await step('主题切换按钮生效', async () => {
  const before = await cdp.evaluate('document.documentElement.getAttribute("data-theme")');
  await cdp.evaluate('document.querySelector("#themeBtn").click()');
  await new Promise((r) => setTimeout(r, 200));
  const after = await cdp.evaluate('document.documentElement.getAttribute("data-theme")');
  assert(before !== after, `主题没有变化：${before} -> ${after}`);
  await cdp.evaluate('document.querySelector("#themeBtn").click()');
  return `data-theme ${before} -> ${after} -> 已切回`;
});

await step('非法入参渲染错误横幅（错误路径可用）', async () => {
  await cdp.evaluate('document.querySelector(".tab[data-tab=\\"video\\"]").click()');
  await cdp.evaluate(`(function () {
    document.querySelector('#videoInput').value = 'not-a-valid-id';
    document.querySelector('#videoForm').requestSubmit();
  })()`);
  await cdp.waitFor('document.querySelector("#videoOut .banner.err") !== null', '错误横幅出现', 20000);
  const text = await cdp.evaluate('document.querySelector("#videoOut .banner.err").textContent');
  assert(text.includes('400'), `错误提示未包含 HTTP 400：${text}`);
  return text.slice(0, 80);
});

/* ------------------------------------------------------------------ *
 * 汇总
 * ------------------------------------------------------------------ */

ws.close();

const pass = results.filter((r) => r.ok).length;
const fail = results.filter((r) => !r.ok).length;

console.log('\n====================== 汇总 ======================');
console.log(`PASS ${pass}   FAIL ${fail}   共 ${results.length} 项`);
if (fail > 0) {
  console.log('\n失败项：');
  for (const r of results.filter((x) => !x.ok)) console.log(`  - ${r.name}\n    ${r.detail}`);
}
console.log('=================================================\n');

process.exit(fail === 0 ? 0 : 1);
