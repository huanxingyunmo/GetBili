/**
 * GetBili 管理后台 —— 单文件 UI 页面（HTML + CSS + 原生 JS）。
 *
 * 职责：令牌登录 + 接口公开策略管理，两个功能共用一张内联页面，由页面 JS
 * 依据 <body data-admin-enabled> 属性与 /adm/api/session 的结果在三态间切换：
 *   - #disabledArea：服务端未配置 ADMIN_TOKEN，后台未启用；
 *   - #authArea：    未登录，展示令牌输入框；
 *   - #panelArea：   已登录，展示接口策略列表与保存 / 撤销 / 登出操作。
 *
 * 为什么整页内联成一个字符串、而不是放静态资源目录：
 * Workers 运行时没有 fs，页面必须参与打包。内联字符串不需要任何打包器配置，
 * `wrangler dev` 与线上行为完全一致，也不必为一张页面引入 Static Assets 绑定。
 *
 * 服务端开关注入：admPage() 通过 <body data-admin-enabled="true|false"> 属性
 * 注入「ADMIN_TOKEN 是否已配置」，页面 JS 读取该属性做初判。刻意不用内联 JSON
 * 注入 —— 属性是 HTML 转义的最简形式，彻底绕开字符串转义与 XSS 注入面，
 * 且令牌本身永远不会出现在页面源码里。
 *
 * 编写约定（重要，改动本文件前务必遵守）：
 * 1. 内层 JS 不使用嵌套模板字面量 —— 一律用字符串拼接，避免反引号转义问题；
 * 2. 内层 JS 不使用任何反斜杠（正则、\n、\' 都不行）—— 模板字面量里的反斜杠
 *    会被外层解析，静默改变语义；JSON 处理一律走 JSON.parse / JSON.stringify；
 * 3. 所有动态文本走 textContent 或 document.createTextNode，不用 innerHTML，
 *    接口描述等上游文本里出现 HTML 片段时不会被当作结构注入；
 * 4. 内层 JS 不得出现 </script> 字样。
 *
 * 安全基线：
 * - 管理态每次进入都拉取服务端最新策略，不做 localStorage 持久化（策略属于
 *   服务端状态，本地缓存会造成「看到的」与「生效的」不一致）；
 * - 令牌输入框 type=password，登录成功后立即清空输入框，不回显。
 */

import type { Env } from '../types';

export const ADM_HTML: string = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>GetBili 管理后台 · 哔哩哔哩信息 API</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%23fb7299'/%3E%3Ctext x='16' y='23' font-size='19' text-anchor='middle' fill='white' font-family='sans-serif'%3EB%3C/text%3E%3C/svg%3E" />
<style>
:root {
  --accent: #fb7299;
  --accent-2: #23ade5;
  --ok: #0f8fc4;
  --bad: #d64f78;
  --warn: #b57d10;
  --bg: #f5f6fa;
  --card: #ffffff;
  --text: #16181f;
  --muted: #6b7280;
  --border: #e3e6ee;
  --chip: #f0f2f7;
  --shadow: 0 1px 2px rgba(16, 24, 40, .05), 0 8px 24px rgba(16, 24, 40, .06);
  --radius: 12px;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
html[data-theme="dark"] {
  --bg: #101219;
  --card: #191c25;
  --text: #e9ecf3;
  --muted: #98a1b3;
  --border: #2b3040;
  --chip: #232837;
  --shadow: 0 1px 2px rgba(0, 0, 0, .4), 0 10px 28px rgba(0, 0, 0, .35);
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font: 14px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  -webkit-font-smoothing: antialiased;
}
.topbar {
  display: flex; align-items: center; justify-content: space-between; gap: 16px;
  padding: 14px 22px; background: var(--card); border-bottom: 1px solid var(--border);
  position: sticky; top: 0; z-index: 20;
}
.brand { display: flex; align-items: center; gap: 12px; min-width: 0; }
.logo {
  width: 38px; height: 38px; border-radius: 11px; flex: none;
  background: linear-gradient(135deg, var(--accent), #ff9ec0);
  color: #fff; font-weight: 700; font-size: 19px;
  display: flex; align-items: center; justify-content: center;
}
.brand h1 { margin: 0; font-size: 16px; font-weight: 650; letter-spacing: .2px; }
.brand p { margin: 1px 0 0; font-size: 12px; color: var(--muted); }
.topbar-actions { display: flex; align-items: center; gap: 9px; flex: none; }
.pill {
  font-size: 12px; padding: 4px 11px; border-radius: 999px;
  background: var(--chip); color: var(--muted); white-space: nowrap;
}
.pill.ok { background: rgba(35, 173, 229, .13); color: var(--ok); }
.pill.bad { background: rgba(251, 114, 153, .15); color: var(--bad); }
.pill.warn { background: rgba(255, 170, 0, .16); color: var(--warn); }
.ghost-btn, .primary-btn {
  appearance: none; font: inherit; font-weight: 550; cursor: pointer;
  padding: 7px 15px; border-radius: 9px; border: 1px solid var(--border);
  background: var(--card); color: var(--text);
}
.ghost-btn:hover { border-color: var(--accent-2); color: var(--accent-2); }
.primary-btn { background: var(--accent); border-color: var(--accent); color: #fff; }
.primary-btn:hover { filter: brightness(1.06); }
main { max-width: 880px; margin: 0 auto; padding: 22px; }
.area { display: none; }
.area.active { display: block; animation: fade .18s ease; }
@keyframes fade { from { opacity: 0; transform: translateY(3px); } to { opacity: 1; transform: none; } }
.card {
  background: var(--card); border: 1px solid var(--border);
  border-radius: var(--radius); box-shadow: var(--shadow);
  padding: 20px 22px;
}
.card h2 { margin: 0 0 4px; font-size: 16px; font-weight: 650; }
.muted { color: var(--muted); font-size: 13px; margin: 4px 0 16px; }
.auth-card { max-width: 380px; margin: 56px auto 0; padding: 26px 28px 28px; }
#tokenInput {
  width: 100%; font: inherit; padding: 9px 12px; border-radius: 9px;
  border: 1px solid var(--border); background: var(--bg); color: var(--text);
  outline: none; margin-bottom: 12px;
}
#tokenInput:focus { border-color: var(--accent-2); }
#loginBtn { width: 100%; padding: 9px 15px; }
.auth-err {
  display: none; margin: 12px 0 0; padding: 8px 12px; border-radius: 8px;
  background: rgba(251, 114, 153, .12); color: var(--bad); font-size: 13px;
}
.auth-err.show { display: block; }
.panel-head {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  flex-wrap: wrap; margin-bottom: 4px;
}
.panel-head h2 { margin: 0; }
.panel-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.row { display: flex; align-items: center; justify-content: space-between; gap: 14px; padding: 11px 2px; }
.row + .row { border-top: 1px solid var(--border); }
.row-info { min-width: 0; }
.row-path { font-family: var(--mono); font-size: 13px; font-weight: 600; word-break: break-all; }
.row-path .m { color: var(--accent-2); }
.row-desc { font-size: 12px; color: var(--muted); margin-top: 2px; }
.toggle {
  appearance: none; font: inherit; font-size: 12px; font-weight: 600; cursor: pointer;
  padding: 5px 0; min-width: 78px; border-radius: 999px; text-align: center;
  border: 1px solid var(--border); background: var(--chip); color: var(--muted); flex: none;
}
.toggle.public { background: rgba(35, 173, 229, .13); color: var(--ok); border-color: transparent; }
.toggle.token { background: rgba(251, 114, 153, .15); color: var(--bad); border-color: transparent; }
.toast {
  position: fixed; left: 50%; bottom: 26px; z-index: 50;
  transform: translateX(-50%) translateY(8px);
  background: var(--text); color: var(--card);
  padding: 9px 18px; border-radius: 999px; font-size: 13px;
  opacity: 0; pointer-events: none; transition: opacity .2s ease, transform .2s ease;
}
.toast.show { opacity: 1; transform: translateX(-50%); }
.toast.err { background: var(--bad); color: #fff; }
</style>
</head>
<body data-admin-enabled="false">
<div class="topbar">
  <div class="brand">
    <div class="logo">B</div>
    <div>
      <h1>GetBili 管理后台</h1>
      <p>哔哩哔哩信息 API · 接口公开策略</p>
    </div>
  </div>
  <div class="topbar-actions">
    <span class="pill warn" id="dirtyPill" style="display:none">未保存更改</span>
    <span class="pill" id="healthPill" style="display:none">服务 --</span>
    <button class="ghost-btn" id="themeBtn" type="button">深色</button>
  </div>
</div>
<main>
  <section class="area" id="authArea">
    <div class="card auth-card">
      <h2>登录</h2>
      <p class="muted">输入管理令牌以继续。令牌由服务端环境变量 ADMIN_TOKEN 配置。</p>
      <input type="password" id="tokenInput" placeholder="管理令牌" autocomplete="current-password" />
      <button type="button" id="loginBtn" class="primary-btn">登录</button>
      <div class="auth-err" id="authErr"></div>
    </div>
  </section>
  <section class="area" id="panelArea">
    <div class="card">
      <div class="panel-head">
        <h2>接口公开策略</h2>
        <div class="panel-actions">
          <button type="button" id="saveBtn" class="primary-btn">保存</button>
          <button type="button" id="resetBtn" class="ghost-btn">撤销</button>
          <button type="button" id="logoutBtn" class="ghost-btn">登出</button>
        </div>
      </div>
      <p class="muted">「公开」接口任何人可直接调用；「需令牌」接口仅持有管理令牌的调用方可访问。修改后需点击「保存」生效。</p>
      <div id="policyList"></div>
    </div>
  </section>
  <section class="area" id="disabledArea">
    <div class="card">
      <h2>管理后台未启用</h2>
      <p class="muted">管理后台未启用：请配置环境变量 ADMIN_TOKEN 后再访问。</p>
    </div>
  </section>
</main>
<div class="toast" id="toast"></div>
<script>
(function () {
  'use strict';
  function $(id) { return document.getElementById(id); }
  var themeBtn = $('themeBtn');
  var tokenInput = $('tokenInput');
  var loginBtn = $('loginBtn');
  var authErr = $('authErr');
  var policyList = $('policyList');
  var saveBtn = $('saveBtn');
  var resetBtn = $('resetBtn');
  var logoutBtn = $('logoutBtn');
  var toastEl = $('toast');
  var healthPill = $('healthPill');
  var dirtyPill = $('dirtyPill');

  // 服务端已保存的策略、本地草稿、接口契约列表。全部只存内存，不落 localStorage。
  var serverPolicy = {};
  var draft = {};
  var endpointList = [];
  var toastTimer = null;
  var saving = false;

  // ---------------- 主题（与管理台页面同款明暗切换） ----------------
  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    themeBtn.textContent = theme === 'dark' ? '浅色' : '深色';
    try { localStorage.setItem('gb_adm_theme', theme); } catch (e) { /* 隐私模式等场景忽略 */ }
  }
  var savedTheme = 'light';
  try {
    if (localStorage.getItem('gb_adm_theme') === 'dark') savedTheme = 'dark';
  } catch (e) { /* 同上 */ }
  applyTheme(savedTheme);
  themeBtn.addEventListener('click', function () {
    var cur = document.documentElement.getAttribute('data-theme');
    applyTheme(cur === 'dark' ? 'light' : 'dark');
  });

  // ---------------- 三态切换 ----------------
  function show(which) {
    $('authArea').className = which === 'auth' ? 'area active' : 'area';
    $('panelArea').className = which === 'panel' ? 'area active' : 'area';
    $('disabledArea').className = which === 'disabled' ? 'area active' : 'area';
  }

  // ---------------- toast ----------------
  function toast(text, isErr) {
    toastEl.textContent = text;
    toastEl.className = isErr ? 'toast show err' : 'toast show';
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.className = 'toast'; }, 2200);
  }

  // ---------------- 策略列表渲染 ----------------
  function paintToggle(btn, value) {
    btn.textContent = value === 'token' ? '需令牌' : '公开';
    btn.className = value === 'token' ? 'toggle token' : 'toggle public';
  }

  function makeRow(ep) {
    var row = document.createElement('div');
    row.className = 'row';
    var info = document.createElement('div');
    info.className = 'row-info';
    var pathLine = document.createElement('div');
    pathLine.className = 'row-path';
    var m = document.createElement('span');
    m.className = 'm';
    m.textContent = ep.method;
    pathLine.appendChild(m);
    pathLine.appendChild(document.createTextNode(' ' + ep.path));
    var desc = document.createElement('div');
    desc.className = 'row-desc';
    desc.textContent = ep.query ? ep.desc + '；' + ep.query : ep.desc;
    info.appendChild(pathLine);
    info.appendChild(desc);
    var btn = document.createElement('button');
    btn.type = 'button';
    paintToggle(btn, draft[ep.path] || 'public');
    btn.addEventListener('click', function () {
      var next = (draft[ep.path] || 'public') === 'public' ? 'token' : 'public';
      draft[ep.path] = next;
      paintToggle(btn, next);
      updateDirty();
    });
    row.appendChild(info);
    row.appendChild(btn);
    return row;
  }

  function renderList() {
    while (policyList.firstChild) policyList.removeChild(policyList.firstChild);
    endpointList.forEach(function (ep) { policyList.appendChild(makeRow(ep)); });
    updateDirty();
  }

  function updateDirty() {
    var dirty = endpointList.some(function (ep) {
      return (draft[ep.path] || 'public') !== (serverPolicy[ep.path] || 'public');
    });
    dirtyPill.style.display = dirty ? '' : 'none';
  }

  // 以服务端返回为准同步本地状态；draft 未覆盖到的接口按「公开」兜底
  function syncServerPolicy(policy) {
    serverPolicy = {};
    draft = {};
    Object.keys(policy).forEach(function (k) {
      serverPolicy[k] = policy[k];
      draft[k] = policy[k];
    });
  }

  // ---------------- 数据加载 ----------------
  function loadPolicy() {
    fetch('/adm/api/policy')
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var d = (j && j.data) || {};
        endpointList = d.endpoints || [];
        syncServerPolicy(d.policy || {});
        renderList();
      })
      .catch(function () { toast('策略加载失败', true); });
  }

  function pingHealth() {
    healthPill.style.display = '';
    healthPill.className = 'pill';
    healthPill.textContent = '检测中';
    fetch('/api/health')
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var up = !!j && j.code === 0;
        healthPill.textContent = up ? '服务正常' : '服务异常';
        healthPill.className = up ? 'pill ok' : 'pill bad';
      })
      .catch(function () {
        healthPill.textContent = '服务异常';
        healthPill.className = 'pill bad';
      });
  }

  // ---------------- 登录 / 登出 ----------------
  function enterPanel() {
    show('panel');
    loadPolicy();
    pingHealth();
  }

  function doLogin() {
    authErr.textContent = '';
    authErr.className = 'auth-err';
    fetch('/adm/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: tokenInput.value })
    }).then(function (r) {
      if (r.status === 401) {
        authErr.textContent = '令牌不正确';
        authErr.className = 'auth-err show';
        return null;
      }
      return r.json();
    }).then(function (j) {
      if (!j) return;
      tokenInput.value = '';
      enterPanel();
    }).catch(function () {
      authErr.textContent = '网络错误，请重试';
      authErr.className = 'auth-err show';
    });
  }
  loginBtn.addEventListener('click', doLogin);
  tokenInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') doLogin();
  });

  logoutBtn.addEventListener('click', function () {
    fetch('/adm/logout', { method: 'POST' })
      .then(function () {
        tokenInput.value = '';
        healthPill.style.display = 'none';
        dirtyPill.style.display = 'none';
        show('auth');
      })
      .catch(function () { toast('登出失败', true); });
  });

  // ---------------- 保存 / 撤销 ----------------
  saveBtn.addEventListener('click', function () {
    if (saving) return;
    saving = true;
    var policy = {};
    endpointList.forEach(function (ep) { policy[ep.path] = draft[ep.path] || 'public'; });
    fetch('/adm/api/policy', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ policy: policy })
    }).then(function (r) {
      return r.json().then(function (j) { return { status: r.status, body: j }; });
    }).then(function (res) {
      if (res.status === 200 && res.body && res.body.data) {
        syncServerPolicy(res.body.data.policy || {});
        renderList();
        toast('已保存');
      } else {
        toast('保存失败：' + ((res.body && res.body.message) || '未知错误'), true);
      }
    }).catch(function () {
      toast('保存失败：网络错误', true);
    }).then(function () {
      saving = false;
    });
  });

  resetBtn.addEventListener('click', function () {
    loadPolicy();
    toast('已撤销本地修改');
  });

  // ---------------- 启动 ----------------
  // 先读服务端注入的 data-admin-enabled 属性做初判，未启用就不发任何请求；
  // 启用时再向 session 接口确认登录态，管理态每次进入都拉最新策略。
  if (document.body.getAttribute('data-admin-enabled') !== 'true') {
    show('disabled');
  } else {
    fetch('/adm/api/session')
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var d = (j && j.data) || {};
        if (!d.enabled) { show('disabled'); return; }
        if (!d.authed) { show('auth'); return; }
        enterPanel();
      })
      .catch(function () { show('auth'); });
  }
})();
</script>
</body>
</html>`;

/**
 * 输出管理后台页面。
 *
 * 服务端唯一注入点：data-admin-enabled 属性（见文件头说明）。页面 JS 据此
 * 在「未启用 / 登录 / 管理态」三态间切换，无需任何服务端模板能力。
 *
 * 响应头与 /ui 控制台保持同一套安全基线：no-store 防止登录态页面被缓存，
 * CSP 只放行页面确实需要的指令（管理页不加载外部图片与 iframe，比 /ui 更紧）。
 */
export function admPage(env: Env): Response {
  const enabled = env.ADMIN_TOKEN !== undefined && env.ADMIN_TOKEN !== '';
  // 该字面量在 ADM_HTML 中只出现一次（body 起始标签），replace 定向替换安全
  const html = ADM_HTML.replace(
    'data-admin-enabled="false"',
    enabled ? 'data-admin-enabled="true"' : 'data-admin-enabled="false"',
  );
  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: https:",
        "connect-src 'self'",
        "base-uri 'none'",
        "object-src 'none'",
      ].join('; '),
    },
  });
}
