/**
 * UI 页面离线检查（不联网、不依赖浏览器）。
 *
 * 为什么需要这个脚本：
 * `src/ui/page.ts` 与 `src/adm/page.ts` 都把整页 HTML 放在一个模板字面量里，
 * 其中还各嵌了一段内联 JS。TypeScript 只检查外层 `.ts` 的语法，**对内层
 * HTML/JS 完全不检查**，而模板字面量有两个静默陷阱：
 *   1. 内层若写了 `\n` / `\d` 这类转义，会被模板字面量提前消费掉，产出与源码不一致；
 *   2. 内层若写了 `</script>`，浏览器 HTML 解析器会提前结束脚本块。
 * 这两类问题都不会在构建期报错，只会在浏览器里表现为「页面空白」或「行为诡异」。
 * 因此这里用一趟纯文本 + 纯语法的确定性检查把它们挡住。
 *
 * 另外对 `src/disguise/page.ts`（Cloudflare 404 伪装页）做轻量检查：
 * 伪装页的价值在于「看起来与真实 CF 错误页一致且零外链请求」，一旦有人往里
 * 加了外链资源或丢了关键结构，伪装就失效了，这里把这两条底线固化成断言。
 *
 * 用法：node scripts/ui-check.mjs
 */

import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

const results = [];
function check(name, fn) {
  try {
    const detail = fn();
    results.push({ name, ok: true, detail });
  } catch (err) {
    results.push({ name, ok: false, detail: err instanceof Error ? err.message : String(err) });
  }
}
function assert(cond, message) {
  if (!cond) throw new Error(message);
}

// ------------------------------------------------------------------ //
// 可复用的整页检查：模板字面量提取 + 9 项通用检查 + 页面专属检查
// ------------------------------------------------------------------ //

/**
 * 对一个「整页 HTML 存于单个模板字面量」的 page.ts 跑通用检查。
 *
 * 通用 9 项：
 *   模板字面量可提取 / HTML 首尾结构完整 / 内层无反斜杠 / 内层无嵌套模板字面量 /
 *   未使用 innerHTML 注入 / 可提取内联脚本 / 脚本语法合法 / 脚本内不含 </script> /
 *   关键元素 id 齐全
 *
 * extraChecks: [{ name, run(html, script) → detail }]，用于各页面特有的断言。
 */
function runPageChecks(label, pagePath, marker, requiredIds, extraChecks) {
  const source = readFileSync(pagePath, 'utf8');

  // 注意：page.ts 的文件头注释里也可能出现反引号（用于说明模板字面量的陷阱），
  // 因此不能用「第一个反引号」定位，必须先锚定到导出语句。
  const markerIndex = source.indexOf(marker);
  const start = markerIndex < 0 ? -1 : source.indexOf('`', markerIndex);
  const end = source.lastIndexOf('`');

  check(`[${label}] 模板字面量可提取`, () => {
    assert(markerIndex >= 0, `未找到导出语句：${marker}`);
    assert(start >= 0 && end > start, '未找到成对的模板字面量定界符');
    return `源码 ${source.length} 字符，HTML 内容 ${end - start - 1} 字符`;
  });

  const html = source.slice(start + 1, end);

  check(`[${label}] HTML 首尾结构完整`, () => {
    assert(html.startsWith('<!DOCTYPE html>'), 'HTML 未以 <!DOCTYPE html> 开头');
    assert(html.trimEnd().endsWith('</html>'), 'HTML 未以 </html> 结尾');
    return 'doctype + </html> 均在位';
  });

  /**
   * 关键约束：内层内容不得出现反斜杠。
   * 反斜杠在模板字面量里是转义引导符，出现即意味着源码字符与产出字符不一致
   * （例如 `\d` 会退化成 `d`，`\n` 会变成真实换行把字符串字面量截断）。
   * 内联的 CSS / HTML / JS 都不需要反斜杠，因此「零反斜杠」是一条可断言的硬约束。
   */
  check(`[${label}] 内层内容无反斜杠（转义风险）`, () => {
    const index = html.indexOf('\\');
    assert(index === -1, `第 ${index} 个字符处出现反斜杠：…${html.slice(Math.max(0, index - 40), index + 40)}…`);
    return '未出现反斜杠，模板字面量不会消费任何转义';
  });

  check(`[${label}] 内层无嵌套模板字面量`, () => {
    const index = html.indexOf('`');
    assert(index === -1, `内层出现反引号，位置 ${index}`);
    const dollarIndex = html.indexOf('${');
    assert(dollarIndex === -1, `内层出现 \${ 插值，位置 ${dollarIndex}`);
    return '无反引号、无 ${} 插值';
  });

  check(`[${label}] 未使用 innerHTML 注入动态内容`, () => {
    assert(!html.includes('.innerHTML'), '出现 .innerHTML，上游标题中的 HTML 片段会被当作结构注入');
    assert(!html.includes('insertAdjacentHTML'), '出现 insertAdjacentHTML');
    assert(!html.includes('document.write'), '出现 document.write');
    return '全部动态文本走 textContent / createTextNode';
  });

  const scriptStart = html.indexOf('<script>');
  const scriptEnd = html.indexOf('</script>');

  check(`[${label}] 可提取内联脚本`, () => {
    assert(scriptStart >= 0, '未找到 <script> 起始标签');
    assert(scriptEnd > scriptStart, '未找到 </script> 结束标签');
    return `脚本 ${scriptEnd - scriptStart - 8} 字符`;
  });

  const script = html.slice(scriptStart + 8, scriptEnd);

  /**
   * 诊断开关：按行号转储内联脚本。
   * 语法错误只在浏览器里才暴露，且嵌在 page.ts 的模板字面量中间，
   * 直接看 page.ts 的行号对不上，所以留一个能按「内联脚本行号」查看的口子。
   *   UI_DUMP_FROM=505 UI_DUMP_TO=540 node scripts/ui-check.mjs
   */
  if (process.env.UI_DUMP_FROM && label === 'ui') {
    const lines = script.split('\n');
    const from = Math.max(1, Number(process.env.UI_DUMP_FROM) || 1);
    const to = Math.min(lines.length, Number(process.env.UI_DUMP_TO) || from + 30);
    for (let i = from; i <= to; i += 1) {
      console.log(String(i).padStart(4) + ' | ' + lines[i - 1]);
    }
    process.exit(0);
  }

  check(`[${label}] 脚本语法合法（vm.Script 解析）`, () => {
    // 用 vm.Script 只做编译、不执行，能在没有浏览器的环境里捕获语法错误，
    // 并且会报出行号 —— 内联脚本的语法错误在 tsc 阶段完全不可见。
    try {
      new vm.Script(script, { filename: `${pagePath}[inline-script]` });
    } catch (err) {
      const line = String((err && err.stack) || '').split('\n')[0];
      const lines = script.split('\n');
      // 从 vm 的行号里尽量还原出错行，给出上下文
      const matched = String((err && err.stack) || '').match(/(\d+)/);
      let context = '';
      if (matched) {
        const n = Number(matched[1]);
        context = '｜附近：' + lines.slice(Math.max(0, n - 2), n + 1).join(' ⏎ ').trim().slice(0, 220);
      }
      throw new Error(line + context);
    }
    return '编译通过，无语法错误';
  });

  check(`[${label}] 脚本内不含 </script>（会被 HTML 解析器提前截断）`, () => {
    assert(!script.includes('</script'), '脚本内出现 </script>');
    return '未出现提前闭合序列';
  });

  /**
   * 关键 DOM 锚点：这些 id / data 属性是 smoke 与端到端测试的断言目标，
   * 改名会让测试静默失效，因此在这里固化下来。
   */
  check(`[${label}] 关键元素 id 齐全`, () => {
    const missing = requiredIds.filter((id) => !html.includes('id="' + id + '"'));
    assert(missing.length === 0, `缺少 id：${missing.join(', ')}`);
    return `${requiredIds.length} 个 id 全部存在`;
  });

  for (const extra of extraChecks) {
    check(`[${label}] ${extra.name}`, () => extra.run(html, script));
  }
}

// ------------------------------------------------------------------ //
// /ui 控制台页面（9 通用 + 3 专属 = 12 项）
// ------------------------------------------------------------------ //

runPageChecks(
  'ui',
  resolve(here, '../src/ui/page.ts'),
  'export const UI_HTML = ',
  [
    'healthPill', 'themeBtn', 'tabs',
    'videoForm', 'videoInput', 'videoOut', 'videoExampleBtn',
    'userForm', 'userInput', 'userOut',
    'searchForm', 'searchType', 'searchInput', 'searchOut',
    'favForm', 'favInput', 'favOut',
    'apiOut', 'toast',
  ],
  [
    {
      name: '五个标签页锚点齐全',
      run(html) {
        const tabs = ['video', 'user', 'search', 'favlist', 'api'];
        const missingTabs = tabs.filter((name) => !html.includes('data-tab="' + name + '"'));
        assert(missingTabs.length === 0, `缺少 tab：${missingTabs.join(', ')}`);
        const missingPanels = tabs.filter((name) => !html.includes('id="panel-' + name + '"'));
        assert(missingPanels.length === 0, `缺少面板：${missingPanels.join(', ')}`);
        return '5 个 tab 与 5 个 panel 一一对应';
      },
    },
    {
      name: '覆盖全部 12 个接口路径',
      run(html, script) {
        // 页面应当把服务端的每个接口都用起来（健康检查与自描述除外，它们单独断言）
        const used = [
          '/api/video/', '/api/user/', '/api/search/video', '/api/search/user',
          '/api/favlist/', '/api/health',
        ];
        const missing = used.filter((p) => !script.includes(p));
        assert(missing.length === 0, `未调用的接口前缀：${missing.join(', ')}`);
        const suffixes = ['/playurl', '/qualities', '/danmaku', '/pages', '/collection'];
        const missingSuffix = suffixes.filter((s) => !script.includes(s));
        assert(missingSuffix.length === 0, `未调用的子路径：${missingSuffix.join(', ')}`);
        return '视频 6 个 + UP 主 2 个 + 搜索 2 个 + 收藏夹 1 个 + 健康检查均被调用';
      },
    },
    {
      name: '软拦截告警会被渲染',
      run(html, script) {
        assert(script.includes('meta.warning'), '未读取响应的 meta.warning');
        assert(script.includes('v_voucher'), '未对搜索类风控（v_voucher）做说明');
        return '投稿软拦截与搜索风控都有显式提示';
      },
    },
  ],
);

// ------------------------------------------------------------------ //
// /adm 管理后台页面（9 通用 + 3 专属 = 12 项）
// ------------------------------------------------------------------ //

runPageChecks(
  'adm',
  resolve(here, '../src/adm/page.ts'),
  'export const ADM_HTML: string = ',
  [
    'authArea', 'panelArea', 'disabledArea',
    'tokenInput', 'loginBtn', 'authErr',
    'policyList', 'saveBtn', 'resetBtn', 'logoutBtn', 'toast',
  ],
  [
    {
      name: '三态容器与启用开关属性齐全',
      run(html) {
        // 三态切换依赖 .area/.area.active 类与 body 上的服务端注入属性，缺一不可
        assert(html.includes('class="area"'), '缺少 .area 容器类');
        assert(html.includes("'area active'") || html.includes('"area active"'), '页面 JS 未实现 active 态切换');
        assert(html.includes('data-admin-enabled="false"'), '缺少服务端注入点 data-admin-enabled');
        assert(html.includes("getAttribute('data-admin-enabled')"), '页面 JS 未读取启用开关属性');
        return 'auth / panel / disabled 三态 + data-admin-enabled 注入点均在位';
      },
    },
    {
      name: '管理接口调用齐全',
      run(html, script) {
        const called = ['/adm/api/session', '/adm/login', '/adm/logout', '/adm/api/policy', '/api/health'];
        const missing = called.filter((p) => !script.includes(p));
        assert(missing.length === 0, `页面未调用：${missing.join(', ')}`);
        return 'session / login / logout / policy / health 全部被页面使用';
      },
    },
    {
      name: '策略可见性切换机制（public / token）',
      run(html, script) {
        assert(script.includes("'public'") && script.includes("'token'"), '页面 JS 未区分 public/token');
        assert(html.includes('toggle public') || script.includes('toggle public'), '缺少 .toggle.public 样式锚点');
        assert(html.includes('toggle token') || script.includes('toggle token'), '缺少 .toggle.token 样式锚点');
        assert(script.includes('需令牌') && script.includes('公开'), '缺少可见性按钮文案');
        return '策略行切换按钮可表达 public ↔ token 两态';
      },
    },
  ],
);

// ------------------------------------------------------------------ //
// Cloudflare 404 伪装页（4 项轻量检查）
// ------------------------------------------------------------------ //

const DISGUISE_PATH = resolve(here, '../src/disguise/page.ts');
const disguiseSource = readFileSync(DISGUISE_PATH, 'utf8');

check('[disguise] 关键伪装结构齐全', () => {
  assert(disguiseSource.includes('cf-error-details'), '缺少 cf-error-details（真实 CF 错误页的根结构 id）');
  assert(disguiseSource.includes('Error code 404'), '缺少 Error code 404 文案');
  assert(disguiseSource.includes('cf-error-footer'), '缺少 Ray ID footer 结构');
  return 'cf-error-details / Error code 404 / cf-error-footer 均在位';
});

check('[disguise] 图标全部使用 data URI（≥5 处）', () => {
  const count = disguiseSource.split('data:image/svg+xml').length - 1;
  assert(count >= 5, `data URI 图标只有 ${count} 处（期望 ≥5，cf-icon-* 均应为内联 SVG）`);
  return `${count} 处 data:image/svg+xml 图标`;
});

check('[disguise] 零外链资源引用', () => {
  // 伪装页必须零外链：任何 src/href/url() 指向第三方都会产生可识别的请求指纹。
  // 唯一豁免是 footer 里复刻真实 CF 错误页的 cloudflare.com <a> 链接（纯导航，不发请求）。
  const httpRefs = disguiseSource.match(/https?:\/\/[^\s"'`<>\\)]+/g) ?? [];
  const foreign = httpRefs.filter((u) => !u.startsWith('https://www.cloudflare.com'));
  assert(foreign.length === 0, `出现外链资源引用：${foreign.join(', ')}`);
  const cfCount = httpRefs.filter((u) => u.startsWith('https://www.cloudflare.com')).length;
  assert(cfCount >= 2, `footer 的 cloudflare.com 链接缺失（期望 ≥2 处）`);
  return `外链仅 cloudflare.com 文本链接 ${cfCount} 处（官方错误页同款 footer）`;
});

check('[disguise] 响应形态对齐真实 CF 404', () => {
  assert(disguiseSource.includes("'CF-Ray'"), '响应头缺少 CF-Ray');
  assert(disguiseSource.includes("Server: 'cloudflare'") || disguiseSource.includes("'Server': 'cloudflare'"), "响应头缺少 Server: cloudflare");
  assert(disguiseSource.includes('status: 404'), '响应状态码不是 404');
  assert(disguiseSource.includes("robots\" content=\"noindex") || disguiseSource.includes('noindex'), '缺少 noindex meta');
  return 'CF-Ray / Server: cloudflare / 404 / noindex 均在位';
});

// ------------------------------------------------------------------ //
// 汇总
// ------------------------------------------------------------------ //

console.log('');
for (const item of results) {
  const icon = item.ok ? 'PASS' : 'FAIL';
  console.log(`[${icon}] ${item.name} — ${item.detail}`);
}
const failed = results.filter((r) => !r.ok).length;
console.log('');
console.log(`RESULT pass=${results.length - failed} fail=${failed}（12 ui + 12 adm + 4 disguise = ${results.length} 项）`);
process.exit(failed === 0 ? 0 : 1);
