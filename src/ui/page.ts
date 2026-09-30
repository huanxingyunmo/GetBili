/**
 * GetBili 控制台 —— 单文件 UI 页面（HTML + CSS + 原生 JS）。
 *
 * 为什么整页内联成一个字符串、而不是放静态资源目录：
 * Workers 运行时没有 fs，页面必须参与打包。内联字符串不需要任何打包器配置，
 * `wrangler dev` 与线上行为完全一致，也不必为一张调试页引入 Static Assets 绑定
 * 与额外的路由优先级规则。页面只有十几 KB，代价可以忽略。
 *
 * 编写约定（重要，改动本文件前务必遵守）：
 * 1. 内层 JS 不使用嵌套模板字面量 —— 一律用字符串拼接，避免反引号转义问题；
 * 2. 内层 JS 不使用含反斜杠的正则字面量 —— 模板字面量里 `\d` 会被解析成 `d`，
 *    会静默改变语义；需要匹配时用字符串方法；
 * 3. 所有动态文本走 textContent 或 document.createTextNode，不用 innerHTML，
 *    上游标题里出现 HTML 片段时不会被当作结构注入。
 */

export const UI_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>GetBili 控制台 · 哔哩哔哩信息 API</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%23fb7299'/%3E%3Ctext x='16' y='23' font-size='19' text-anchor='middle' fill='white' font-family='sans-serif'%3EB%3C/text%3E%3C/svg%3E" />
<style>
:root {
  --accent: #fb7299;
  --accent-2: #23ade5;
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
a { color: var(--accent-2); text-decoration: none; }
a:hover { text-decoration: underline; }
code { font-family: var(--mono); font-size: .92em; background: var(--chip); padding: 1px 5px; border-radius: 5px; }

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
.pill.ok { background: rgba(35, 173, 229, .13); color: #0f8fc4; }
.pill.bad { background: rgba(251, 114, 153, .15); color: #d64f78; }

.tabs {
  display: flex; gap: 4px; padding: 12px 22px 0; max-width: 1180px; margin: 0 auto;
  flex-wrap: wrap;
}
.tab {
  appearance: none; border: 0; background: transparent; color: var(--muted);
  font: inherit; font-weight: 550; padding: 8px 15px; border-radius: 9px 9px 0 0;
  cursor: pointer; border-bottom: 2px solid transparent;
}
.tab:hover { color: var(--text); background: var(--card); }
.tab.active { color: var(--accent); border-bottom-color: var(--accent); background: var(--card); }

main { max-width: 1180px; margin: 0 auto; padding: 18px 22px 72px; }
.panel { display: none; }
.panel.active { display: block; animation: fade .18s ease; }
@keyframes fade { from { opacity: 0; transform: translateY(3px); } to { opacity: 1; transform: none; } }

.card {
  background: var(--card); border: 1px solid var(--border);
  border-radius: var(--radius); box-shadow: var(--shadow);
  padding: 18px; margin-bottom: 16px;
}
.card > h2, .card > h3 { margin: 0 0 12px; font-size: 15px; font-weight: 650; }
.card-sub { margin: 0 0 14px; color: var(--muted); font-size: 12.5px; }

.querybar { display: flex; gap: 9px; flex-wrap: wrap; align-items: center; }
.input, select {
  appearance: none; font: inherit; color: var(--text); background: var(--card);
  border: 1px solid var(--border); border-radius: 9px; padding: 9px 12px; min-width: 0;
}
.input { flex: 1 1 300px; }
.input:focus, select:focus { outline: 2px solid rgba(251, 114, 153, .35); outline-offset: 1px; border-color: var(--accent); }
.btn {
  appearance: none; font: inherit; font-weight: 550; cursor: pointer;
  border: 1px solid var(--border); background: var(--card); color: var(--text);
  border-radius: 9px; padding: 9px 15px; white-space: nowrap;
}
.btn:hover { border-color: var(--accent); color: var(--accent); }
.btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
.btn.primary:hover { filter: brightness(1.06); color: #fff; }
.btn.sm { padding: 4px 10px; font-size: 12.5px; border-radius: 7px; }
.btn[disabled] { opacity: .5; cursor: not-allowed; }
.hint { color: var(--muted); font-size: 12.5px; margin: 10px 0 0; }

.video-head { display: flex; gap: 16px; flex-wrap: wrap; }
.cover {
  width: 264px; aspect-ratio: 16 / 9; object-fit: cover; border-radius: 10px;
  background: var(--chip); flex: none;
}
.video-meta { flex: 1 1 340px; min-width: 0; }
.video-meta h2 { margin: 0 0 8px; font-size: 17px; line-height: 1.45; font-weight: 650; word-break: break-word; }
.owner-row { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; flex-wrap: wrap; }
.avatar { width: 26px; height: 26px; border-radius: 50%; object-fit: cover; background: var(--chip); }
.muted { color: var(--muted); }
.tiny { font-size: 12px; }
.stats { display: flex; flex-wrap: wrap; gap: 7px; margin-bottom: 10px; }
.stat {
  background: var(--chip); border-radius: 8px; padding: 6px 11px; min-width: 74px;
}
.stat b { display: block; font-size: 14px; font-weight: 650; }
.stat span { font-size: 11.5px; color: var(--muted); }
.desc {
  color: var(--muted); font-size: 12.5px; white-space: pre-wrap; word-break: break-word;
  max-height: 5.2em; overflow: hidden; position: relative;
}
.desc.open { max-height: none; }
.actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 16px; padding-top: 14px; border-top: 1px dashed var(--border); }

.chips { display: flex; gap: 7px; flex-wrap: wrap; }
.chip {
  border: 1px solid var(--border); border-radius: 999px; padding: 4px 11px; font-size: 12.5px;
  background: var(--chip); color: var(--muted);
}
.chip.on { background: rgba(35, 173, 229, .14); border-color: rgba(35, 173, 229, .5); color: #0f8fc4; font-weight: 550; }

table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--border); vertical-align: top; }
th { color: var(--muted); font-weight: 550; white-space: nowrap; }
tbody tr:last-child td { border-bottom: 0; }
tbody tr:hover { background: var(--chip); }
.tbl-wrap { overflow-x: auto; }
.mono { font-family: var(--mono); font-size: 11.5px; word-break: break-all; }

.vlist { display: grid; gap: 10px; }
.vitem { display: flex; gap: 12px; padding: 9px; border: 1px solid var(--border); border-radius: 10px; align-items: flex-start; }
.vitem:hover { border-color: var(--accent); }
.vthumb { width: 132px; aspect-ratio: 16 / 9; border-radius: 7px; object-fit: cover; background: var(--chip); flex: none; }
.vbody { min-width: 0; flex: 1 1 auto; }
.vbody .t { font-weight: 550; margin-bottom: 4px; word-break: break-word; display: block; color: var(--text); }
.vbody .t:hover { color: var(--accent); text-decoration: none; }
.vmeta { color: var(--muted); font-size: 12px; display: flex; gap: 10px; flex-wrap: wrap; }
.dur { position: relative; }
.badge { background: rgba(0,0,0,.62); color: #fff; border-radius: 5px; padding: 1px 6px; font-size: 11.5px; }

.banner { border-radius: 10px; padding: 11px 13px; font-size: 13px; margin-bottom: 14px; border: 1px solid; }
.banner.warn { background: rgba(255, 176, 32, .12); border-color: rgba(255, 176, 32, .45); color: #8a5a00; }
html[data-theme="dark"] .banner.warn { color: #ffcf7a; }
.banner.err { background: rgba(251, 114, 153, .12); border-color: rgba(251, 114, 153, .45); color: #b93a63; }
html[data-theme="dark"] .banner.err { color: #ff9cba; }

.empty { color: var(--muted); font-size: 13px; padding: 26px 0; text-align: center; }
.spinner {
  width: 15px; height: 15px; border-radius: 50%; display: inline-block; vertical-align: -2px;
  border: 2px solid var(--border); border-top-color: var(--accent); animation: spin .7s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
.loading { color: var(--muted); font-size: 13px; padding: 14px 0; }

.pager { display: flex; align-items: center; gap: 10px; margin-top: 13px; flex-wrap: wrap; }
.pager .info { color: var(--muted); font-size: 12.5px; }

#toast {
  position: fixed; left: 50%; bottom: 26px; transform: translate(-50%, 14px);
  background: #16181f; color: #fff; padding: 10px 17px; border-radius: 10px;
  font-size: 13px; opacity: 0; pointer-events: none; transition: all .2s ease; z-index: 60;
  max-width: min(560px, 90vw);
}
#toast.show { opacity: 1; transform: translate(-50%, 0); }
#toast.err { background: #c0335e; }

.frame-wrap { margin-top: 13px; }
.frame-wrap iframe { width: 100%; aspect-ratio: 16 / 9; border: 1px solid var(--border); border-radius: 10px; background: #000; }

.kv { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 9px; }
.kv > div { background: var(--chip); border-radius: 8px; padding: 8px 11px; }
.kv .k { font-size: 11.5px; color: var(--muted); }
.kv .v { font-size: 13px; word-break: break-word; }
.sect { margin-top: 18px; }
.sect > h3 { margin: 0 0 10px; font-size: 14px; font-weight: 650; }
.row-flex { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
</style>
</head>
<body>

<header class="topbar">
  <div class="brand">
    <div class="logo">B</div>
    <div>
      <h1>GetBili 控制台</h1>
      <p>哔哩哔哩视频信息 API 调试台 · 与接口同源，无需配置跨域</p>
    </div>
  </div>
  <div class="topbar-actions">
    <span class="pill" id="healthPill">检查服务…</span>
    <button class="btn sm" id="themeBtn" type="button">切换主题</button>
  </div>
</header>

<nav class="tabs" id="tabs">
  <button class="tab active" type="button" data-tab="video">视频</button>
  <button class="tab" type="button" data-tab="user">UP 主</button>
  <button class="tab" type="button" data-tab="search">搜索</button>
  <button class="tab" type="button" data-tab="favlist">收藏夹</button>
  <button class="tab" type="button" data-tab="api">接口清单</button>
</nav>

<main>
  <section class="panel active" id="panel-video">
    <div class="card">
      <form class="querybar" id="videoForm">
        <input class="input" id="videoInput" type="text" placeholder="BV 号 / av 号 / 视频链接，例如 BV1GJ411x7h7" autocomplete="off" spellcheck="false" />
        <button class="btn primary" type="submit">查询视频</button>
        <button class="btn" type="button" id="videoExampleBtn">填入示例</button>
      </form>
      <p class="hint">三种入参都可以：BV 号（<code>BV1GJ411x7h7</code>）、av 号（<code>av80431534</code>）、完整链接（<code>https://www.bilibili.com/video/BV1GJ411x7h7</code>）。</p>
    </div>
    <div id="videoOut"></div>
  </section>

  <section class="panel" id="panel-user">
    <div class="card">
      <form class="querybar" id="userForm">
        <input class="input" id="userInput" type="text" placeholder="UP 主 UID 或空间链接，例如 8047632" autocomplete="off" spellcheck="false" />
        <button class="btn primary" type="submit">查询 UP 主</button>
      </form>
      <p class="hint">投稿列表接口在游客身份下可能被 B 站按账号与时窗风控，页面会如实提示而不返回空的假结果。</p>
    </div>
    <div id="userOut"></div>
  </section>

  <section class="panel" id="panel-search">
    <div class="card">
      <form class="querybar" id="searchForm">
        <select id="searchType">
          <option value="video">视频</option>
          <option value="user">UP 主</option>
        </select>
        <input class="input" id="searchInput" type="text" placeholder="搜索关键词" autocomplete="off" spellcheck="false" />
        <button class="btn primary" type="submit">搜索</button>
      </form>
      <p class="hint">搜索接口风控较严，若被拦截会显示「已识别风控」提示，而不是当作「没有结果」。</p>
    </div>
    <div id="searchOut"></div>
  </section>

  <section class="panel" id="panel-favlist">
    <div class="card">
      <form class="querybar" id="favForm">
        <input class="input" id="favInput" type="text" placeholder="收藏夹 media_id 或含 fid= 的收藏夹链接" autocomplete="off" spellcheck="false" />
        <button class="btn primary" type="submit">查询收藏夹</button>
      </form>
      <p class="hint">公开收藏夹可直接查询；私密收藏夹需要服务端配置 <code>BILI_COOKIE</code>。</p>
    </div>
    <div id="favOut"></div>
  </section>

  <section class="panel" id="panel-api">
    <div id="apiOut"><div class="loading"><span class="spinner"></span> 读取接口清单…</div></div>
  </section>
</main>

<div id="toast" role="status" aria-live="polite"></div>

<script>
(function () {
  'use strict';

  /* ------------------------------------------------------------------ *
   * 基础工具
   * ------------------------------------------------------------------ */

  function q1(sel) { return document.querySelector(sel); }

  function qAll(sel) {
    return Array.prototype.slice.call(document.querySelectorAll(sel));
  }

  function txt(value) {
    return document.createTextNode(value === undefined || value === null ? '' : String(value));
  }

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (key) {
        var value = attrs[key];
        if (value === undefined || value === null || value === false) return;
        if (key === 'class') node.className = value;
        else if (key === 'text') node.appendChild(txt(value));
        else if (key === 'style') node.setAttribute('style', value);
        else if (key.indexOf('on') === 0 && typeof value === 'function') {
          node.addEventListener(key.slice(2).toLowerCase(), value);
        } else if (key === 'dataset') {
          Object.keys(value).forEach(function (dk) { node.dataset[dk] = value[dk]; });
        } else {
          node.setAttribute(key, value === true ? '' : value);
        }
      });
    }
    if (children) {
      (Array.isArray(children) ? children : [children]).forEach(function (child) {
        if (child === null || child === undefined || child === false) return;
        node.appendChild(typeof child === 'string' || typeof child === 'number' ? txt(child) : child);
      });
    }
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function mount(node, children) {
    clear(node);
    if (children) {
      (Array.isArray(children) ? children : [children]).forEach(function (child) {
        node.appendChild(child);
      });
    }
    return node;
  }

  function loadingBox(label) {
    return el('div', { class: 'loading' }, [el('span', { class: 'spinner' }), ' ' + label]);
  }

  function emptyBox(label) {
    return el('div', { class: 'empty', text: label });
  }

  function banner(kind, message) {
    return el('div', { class: 'banner ' + kind, text: message });
  }

  /* ------------------------------------------------------------------ *
   * 格式化
   * ------------------------------------------------------------------ */

  function pad2(n) { return n < 10 ? '0' + n : String(n); }

  function fmtCount(n) {
    var v = Number(n);
    if (!isFinite(v)) return '—';
    if (Math.abs(v) >= 100000000) return (v / 100000000).toFixed(1) + ' 亿';
    if (Math.abs(v) >= 10000) return (v / 10000).toFixed(1) + ' 万';
    return String(v);
  }

  function fmtDuration(sec) {
    var total = Math.max(0, Math.floor(Number(sec) || 0));
    var h = Math.floor(total / 3600);
    var m = Math.floor((total % 3600) / 60);
    var s = total % 60;
    if (h > 0) return h + ':' + pad2(m) + ':' + pad2(s);
    return m + ':' + pad2(s);
  }

  function fmtProgress(ms) {
    return fmtDuration(Math.floor((Number(ms) || 0) / 1000));
  }

  function fmtTime(ts) {
    var sec = Number(ts) || 0;
    if (!sec) return '—';
    var d = new Date(sec * 1000);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
      ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  function fmtBandwidth(bps) {
    var v = Number(bps) || 0;
    if (v >= 1000000) return (v / 1000000).toFixed(2) + ' Mbps';
    return Math.round(v / 1000) + ' kbps';
  }

  var MODE_LABEL = { 1: '滚动', 2: '滚动', 3: '滚动', 4: '底部', 5: '顶部', 6: '逆向', 7: '高级', 8: '代码', 9: 'BAS' };

  function colorHex(value) {
    var hex = (Number(value) || 0).toString(16).toUpperCase();
    while (hex.length < 6) hex = '0' + hex;
    return '#' + hex;
  }

  /* ------------------------------------------------------------------ *
   * 请求层：统一信封解析 + 错误对象
   * ------------------------------------------------------------------ */

  function ApiError(message, code, status, detail) {
    this.name = 'ApiError';
    this.message = message;
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
  ApiError.prototype = Object.create(Error.prototype);

  function api(path) {
    return fetch(path, { headers: { Accept: 'application/json' } }).then(function (res) {
      return res.text().then(function (text) {
        var body = null;
        try { body = JSON.parse(text); } catch (e) { body = null; }
        if (!body) {
          throw new ApiError('响应不是合法 JSON（HTTP ' + res.status + '）', -1, res.status, text.slice(0, 300));
        }
        return { status: res.status, body: body };
      });
    });
  }

  function apiOk(path) {
    return api(path).then(function (r) {
      if (r.body.code !== 0) {
        throw new ApiError(
          r.body.message || '上游返回错误',
          r.body.code,
          r.status,
          r.body.detail === undefined ? null : r.body.detail
        );
      }
      return { data: r.body.data, meta: r.body.meta || null };
    });
  }

  /** 统一错误渲染：风控类错误单独提示，因为它不是「没有数据」 */
  function errorCard(err) {
    var code = err && err.code;
    var riskHint = '';
    if (code === -412) riskHint = '（B 站风控拦截：需要登录态 Cookie，或在服务端配置 BILI_COOKIE 后重试）';
    else if (code === -352) riskHint = '（签名校验失败：请确认服务端已启用 WBI 签名与设备指纹）';
    else if (code === -404) riskHint = '（对象不存在，或上游明确返回 404）';
    return banner('err', '请求失败：' + ((err && err.message) || '未知错误') + '　code=' + code + '　HTTP=' + (err && err.status) + riskHint);
  }

  function copyText(value, label) {
    var promise;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      promise = navigator.clipboard.writeText(value);
    } else {
      promise = new Promise(function (resolve, reject) {
        try {
          var ta = document.createElement('textarea');
          ta.value = value;
          ta.setAttribute('style', 'position:fixed;top:-1000px');
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          document.body.removeChild(ta);
          resolve();
        } catch (e) { reject(e); }
      });
    }
    promise.then(function () { toast('已复制' + (label ? '：' + label : '')); })
      .catch(function () { toast('复制失败，请手动选择文本', true); });
  }

  var toastTimer = null;
  function toast(message, isError) {
    var node = q1('#toast');
    node.textContent = message;
    node.className = isError ? 'show err' : 'show';
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { node.className = ''; }, 2600);
  }

  function copyBtn(value, label) {
    return el('button', {
      class: 'btn sm',
      type: 'button',
      text: '复制' + (label || ''),
      onclick: function () { copyText(value, label); }
    });
  }

  /* ------------------------------------------------------------------ *
   * 主题
   * ------------------------------------------------------------------ */

  var THEME_KEY = 'getbili-theme';

  function applyTheme(theme) {
    var root = document.documentElement;
    if (theme === 'dark' || theme === 'light') root.setAttribute('data-theme', theme);
    else {
      var prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
      root.setAttribute('data-theme', prefersDark ? 'dark' : 'light');
    }
    try { localStorage.setItem(THEME_KEY, theme); } catch (e) { /* 隐私模式下忽略 */ }
  }

  (function initTheme() {
    var saved = 'auto';
    try { saved = localStorage.getItem(THEME_KEY) || 'auto'; } catch (e) { saved = 'auto'; }
    applyTheme(saved);
  })();

  q1('#themeBtn').addEventListener('click', function () {
    var cur = document.documentElement.getAttribute('data-theme');
    applyTheme(cur === 'dark' ? 'light' : 'dark');
  });

  /* ------------------------------------------------------------------ *
   * 标签页
   * ------------------------------------------------------------------ */

  q1('#tabs').addEventListener('click', function (ev) {
    var btn = ev.target.closest ? ev.target.closest('.tab') : null;
    if (!btn) return;
    var name = btn.dataset.tab;
    qAll('.tab').forEach(function (t) { t.classList.toggle('active', t === btn); });
    qAll('.panel').forEach(function (p) { p.classList.toggle('active', p.id === 'panel-' + name); });
    if (name === 'api') loadEndpointList();
  });

  function showTab(name) {
    var btn = q1('.tab[data-tab="' + name + '"]');
    if (btn) btn.click();
  }

  /* ------------------------------------------------------------------ *
   * 健康检查
   * ------------------------------------------------------------------ */

  function refreshHealth() {
    var pill = q1('#healthPill');
    pill.textContent = '检查服务…';
    pill.className = 'pill';
    api('/api/health').then(function (r) {
      if (r.body.code === 0) {
        pill.textContent = r.body.data.anonymous ? '服务正常 · 游客身份' : '服务正常 · 已登录';
        pill.className = 'pill ok';
      } else {
        pill.textContent = '服务异常 code=' + r.body.code;
        pill.className = 'pill bad';
      }
    }).catch(function () {
      pill.textContent = '服务不可达';
      pill.className = 'pill bad';
    });
  }

  /* ------------------------------------------------------------------ *
   * 视频项 / 分页 复用渲染
   * ------------------------------------------------------------------ */

  function videoItem(item, onOpenVideo) {
    var thumb = el('img', { class: 'vthumb', src: item.cover, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' });
    var title = el('a', {
      class: 't',
      href: item.url,
      target: '_blank',
      rel: 'noreferrer',
      text: item.title || '（无标题）'
    });
    title.addEventListener('click', function (ev) {
      if (!onOpenVideo) return;
      ev.preventDefault();
      onOpenVideo(item.bvid);
    });
    var meta = el('div', { class: 'vmeta' }, [
      el('span', { text: 'UP：' + (item.ownerName || '—') }),
      el('span', { text: '播放 ' + fmtCount(item.play) }),
      el('span', { text: '弹幕 ' + fmtCount(item.danmaku) }),
      el('span', { text: fmtTime(item.pubdate) }),
      el('span', { class: 'badge', text: fmtDuration(item.duration) })
    ]);
    return el('div', { class: 'vitem' }, [thumb, el('div', { class: 'vbody' }, [title, meta])]);
  }

  function pager(page, pageCount, total, onGo) {
    var prev = el('button', { class: 'btn sm', type: 'button', text: '上一页', disabled: page <= 1, onclick: function () { onGo(page - 1); } });
    var next = el('button', { class: 'btn sm', type: 'button', text: '下一页', disabled: pageCount > 0 ? page >= pageCount : false, onclick: function () { onGo(page + 1); } });
    return el('div', { class: 'pager' }, [
      prev, next,
      el('span', { class: 'info', text: '第 ' + page + ' / ' + (pageCount || '?') + ' 页 · 共 ' + fmtCount(total) + ' 条' })
    ]);
  }

  /* ------------------------------------------------------------------ *
   * 视频面板
   * ------------------------------------------------------------------ */

  var currentVideo = null;

  function statBox(value, label) {
    return el('div', { class: 'stat' }, [el('b', { text: fmtCount(value) }), el('span', { text: label })]);
  }

  function renderVideoDetail(payload) {
    var d = payload.detail;
    var meta = payload.meta;
    currentVideo = d;

    var cover = el('img', { class: 'cover', src: d.cover, alt: '视频封面', referrerpolicy: 'no-referrer' });
    var avatar = el('img', { class: 'avatar', src: d.owner.face, alt: '', referrerpolicy: 'no-referrer' });

    var openUp = el('button', {
      class: 'btn sm', type: 'button', text: '查看该 UP 主',
      onclick: function () {
        q1('#userInput').value = String(d.owner.mid);
        showTab('user');
        loadUser(d.owner.mid);
      }
    });

    var desc = el('div', { class: 'desc', text: d.desc || '（无简介）' });
    var descToggle = el('button', {
      class: 'btn sm', type: 'button', text: '展开简介',
      onclick: function () {
        var open = desc.classList.toggle('open');
        descToggle.textContent = open ? '收起简介' : '展开简介';
      }
    });

    var head = el('div', { class: 'video-head' }, [
      cover,
      el('div', { class: 'video-meta' }, [
        el('h2', { text: d.title || '（无标题）' }),
        el('div', { class: 'owner-row' }, [
          avatar,
          el('span', { text: d.owner.name || '—' }),
          el('span', { class: 'muted tiny', text: 'UID ' + d.owner.mid }),
          openUp
        ]),
        el('div', { class: 'stats' }, [
          statBox(d.stat.view, '播放'),
          statBox(d.stat.danmaku, '弹幕'),
          statBox(d.stat.like, '点赞'),
          statBox(d.stat.coin, '投币'),
          statBox(d.stat.favorite, '收藏'),
          statBox(d.stat.reply, '评论'),
          statBox(d.stat.share, '分享')
        ]),
        el('div', { class: 'vmeta' }, [
          el('span', { text: '分区：' + (d.tname || '—') }),
          el('span', { text: '时长：' + fmtDuration(d.duration) }),
          el('span', { text: '分P：' + d.pageCount }),
          el('span', { text: '发布：' + fmtTime(d.pubdate) }),
          el('span', { class: 'mono', text: d.bvid + ' / aid ' + d.aid + ' / cid ' + d.cid }),
          el('span', { text: '分辨率：' + d.dimension.width + '×' + d.dimension.height })
        ]),
        el('div', { class: 'row-flex', style: 'margin-top:8px' }, [desc, descToggle]),
        d.collection ? el('div', { class: 'row-flex', style: 'margin-top:10px' }, [
          el('span', { class: 'chip on', text: '属于合集：' + d.collection.title + '（' + d.collection.count + ' 个视频）' })
        ]) : null
      ])
    ]);

    function action(label, handler) {
      return el('button', { class: 'btn', type: 'button', text: label, onclick: handler });
    }

    var tools = el('div', { id: 'videoTools' });

    var actions = el('div', { class: 'actions' }, [
      action('播放地址', function () { loadPlayUrl(tools, d.bvid, d.cid, 80); }),
      action('可用清晰度', function () { loadQualities(tools, d.bvid); }),
      action('弹幕', function () { loadDanmaku(tools, d.bvid); }),
      action('分P 列表', function () { loadPages(tools, d.bvid, d); }),
      action('所属合集', function () { loadVideoCollection(tools, d.bvid); }),
      action('官方播放器', function () { renderIframePlayer(tools, d.bvid, d.cid); }),
      el('a', { class: 'btn', href: d.url, target: '_blank', rel: 'noreferrer', text: '打开 B 站页面' }),
      el('a', { class: 'btn', href: '/api/video/' + d.bvid, target: '_blank', rel: 'noreferrer', text: '查看原始 JSON' })
    ]);

    var nodes = [];
    if (meta && meta.warning) nodes.push(banner('warn', meta.warning));
    if (d.state !== 0) nodes.push(banner('warn', '注意：该视频 state=' + d.state + '（非 0 表示状态异常，可能已下架或仅 UP 主可见）。'));
    nodes.push(el('div', { class: 'card' }, [head, actions, tools]));
    return nodes;
  }

  function loadVideo(input) {
    var out = q1('#videoOut');
    mount(out, loadingBox('正在查询视频 ' + input + ' …'));
    return apiOk('/api/video/' + encodeURIComponent(input) + '?qualities=1')
      .then(function (r) { mount(out, renderVideoDetail({ detail: r.data, meta: r.meta })); })
      .catch(function (err) { mount(out, errorCard(err)); });
  }

  function loadPlayUrl(target, bvid, cid, qn) {
    mount(target, loadingBox('正在获取播放地址（qn=' + qn + '）…'));
    apiOk('/api/video/' + bvid + '/playurl?qn=' + qn + '&cid=' + cid).then(function (r) {
      var d = r.data;

      var summary = el('div', { class: 'kv' }, [
        el('div', {}, [el('div', { class: 'k', text: '流格式' }), el('div', { class: 'v', text: d.format })]),
        el('div', {}, [el('div', { class: 'k', text: '请求清晰度' }), el('div', { class: 'v', text: d.requestQn + '（' + qualityName(d.acceptQuality, d.requestQn) + '）' })]),
        el('div', {}, [el('div', { class: 'k', text: '实际清晰度' }), el('div', { class: 'v', text: d.qn + '（' + (d.qualityName || qualityName(d.acceptQuality, d.qn)) + '）' })]),
        el('div', {}, [el('div', { class: 'k', text: '视频流数 / 音频流数' }), el('div', { class: 'v', text: (d.dash ? d.dash.video.length : 0) + ' / ' + (d.dash ? d.dash.audio.length : 0) })]),
        el('div', {}, [el('div', { class: 'k', text: '时长' }), el('div', { class: 'v', text: fmtDuration(Math.floor((d.timelength || 0) / 1000)) })])
      ]);

      var nodes = [el('div', { class: 'sect' }, [el('h3', { text: '播放地址 · 概览' }), summary])];

      if (d.requestQn !== d.qn) {
        nodes.push(banner('warn', '实际返回的清晰度（' + d.qn + '）与请求的（' + d.requestQn + '）不一致，这是游客身份下的常见降级；配置 BILI_COOKIE 可改善。'));
      }

      if (d.dash) {
        nodes.push(el('div', { class: 'sect' }, [
          el('h3', { text: 'DASH 视频流' }),
          urlTable(['id', '清晰度', '分辨率', '帧率', '编码', '码率', '地址'], d.dash.video.map(function (s) {
            return [s.id, s.qualityName, s.width + '×' + s.height, s.frameRate, s.codecs, fmtBandwidth(s.bandwidth), s.baseUrl];
          }))
        ]));
        nodes.push(el('div', { class: 'sect' }, [
          el('h3', { text: 'DASH 音频流' }),
          urlTable(['id', '音质', '分辨率', '帧率', '编码', '码率', '地址'], d.dash.audio.map(function (s) {
            return [s.id, s.qualityName, '—', '—', s.codecs, fmtBandwidth(s.bandwidth), s.baseUrl];
          }))
        ]));
      }

      if (d.durl && d.durl.length) {
        nodes.push(el('div', { class: 'sect' }, [
          el('h3', { text: 'durl 整段流（含音轨，可直接播放）' }),
          el('div', { class: 'vlist' }, d.durl.map(function (seg) {
            return el('div', { class: 'vitem' }, [
              el('div', { class: 'vbody' }, [
                el('div', { text: '分段 ' + seg.order + ' · ' + fmtDuration(Math.floor(seg.length / 1000)) + ' · ' + Math.round(seg.size / 1048576) + ' MB' }),
                el('div', { class: 'mono', text: seg.url })
              ]),
              el('div', { class: 'row-flex' }, [
                copyBtn(seg.url, '地址'),
                el('a', { class: 'btn sm', href: seg.url, target: '_blank', rel: 'noreferrer', text: '打开' })
              ])
            ]);
          }))
        ]));
      }

      if (d.best && (d.best.video || d.best.audio)) {
        var bestRows = [];
        if (d.best.video) bestRows.push(el('div', { class: 'kv' }, [
          el('div', {}, [el('div', { class: 'k', text: '最佳视频流' }), el('div', { class: 'v', text: d.best.video.qualityName + ' · ' + d.best.video.codecs })]),
          el('div', {}, [el('div', { class: 'k', text: '操作' }), el('div', { class: 'v' }, [copyBtn(d.best.video.baseUrl, '视频地址')])])
        ]));
        if (d.best.audio) bestRows.push(el('div', { class: 'kv' }, [
          el('div', {}, [el('div', { class: 'k', text: '最佳音频流' }), el('div', { class: 'v', text: (d.best.audio.qualityName || '—') + ' · ' + d.best.audio.codecs })]),
          el('div', {}, [el('div', { class: 'k', text: '操作' }), el('div', { class: 'v' }, [copyBtn(d.best.audio.baseUrl, '音频地址')])])
        ]));
        nodes.push(el('div', { class: 'sect' }, [
          el('h3', { text: '服务端挑选的最佳流' }),
          el('div', { class: 'vlist' }, bestRows),
          el('p', { class: 'card-sub', text: '提示：DASH 的音视频是分离的，直接用 video 标签播放只有画面没有声音；要在浏览器里完整播放需要用 MSE 合流，或使用「官方播放器」。' })
        ]));
      }

      mount(target, nodes);
    }).catch(function (err) { mount(target, errorCard(err)); });
  }

  function qualityName(list, qn) {
    if (!list) return '未知';
    for (var i = 0; i < list.length; i += 1) {
      if (list[i].qn === qn) return list[i].description;
    }
    return '未知';
  }

  function tableShell(headers, bodyRows) {
    var headRow = el('tr', {}, headers.map(function (label) { return el('th', { text: label }); }));
    return el('div', { class: 'tbl-wrap' }, [
      el('table', {}, [el('thead', {}, [headRow]), el('tbody', {}, bodyRows)])
    ]);
  }

  /**
   * 通用数据表：单元格只放文本，不做任何特殊解释。
   * 分P 列表这类表格的最后一列是「来源」而不是地址，必须走这个函数，
   * 否则会被当成 URL 渲染出复制按钮。
   */
  function dataTable(headers, rows) {
    return tableShell(headers, rows.map(function (row) {
      return el('tr', {}, row.map(function (cell) {
        return typeof cell === 'string' || typeof cell === 'number'
          ? el('td', { text: String(cell) })
          : el('td', {}, [cell]);
      }));
    }));
  }

  /** 带直链的表格：约定**最后一列**是 URL，渲染成截断地址 + 复制 + 打开 */
  function urlTable(headers, rows) {
    return tableShell(headers, rows.map(function (row) {
      return el('tr', {}, row.map(function (cell, index) {
        if (index !== headers.length - 1) return el('td', { text: String(cell) });
        var url = String(cell);
        return el('td', {}, [
          el('div', { class: 'mono', text: url.slice(0, 96) + (url.length > 96 ? '…' : '') }),
          el('div', { class: 'row-flex', style: 'margin-top:6px' }, [
            copyBtn(url, '地址'),
            el('a', { class: 'btn sm', href: url, target: '_blank', rel: 'noreferrer', text: '打开' })
          ])
        ]);
      }));
    }));
  }

  function loadQualities(target, bvid) {
    mount(target, loadingBox('正在探测可用清晰度…'));
    apiOk('/api/video/' + bvid + '/qualities').then(function (r) {
      var list = r.data.qualities || [];
      var chips = el('div', { class: 'chips' }, list.map(function (q) {
        return el('span', { class: 'chip' + (q.available ? ' on' : ''), text: q.qn + ' ' + q.description + (q.available ? ' · 有流' : ' · 无流') });
      }));
      mount(target, [el('div', { class: 'sect' }, [
        el('h3', { text: '可用清晰度（共 ' + list.length + ' 项，cid=' + r.data.cid + '）' }),
        list.length ? chips : emptyBox('没有探测到可用清晰度'),
        el('p', { class: 'card-sub', text: '「有流」表示该清晰度确实返回了可播放地址；游客身份下高清晰度通常只有预览流。' })
      ])]);
    }).catch(function (err) { mount(target, errorCard(err)); });
  }

  function loadDanmaku(target, bvid) {
    mount(target, loadingBox('正在拉取弹幕…'));
    apiOk('/api/video/' + bvid + '/danmaku?format=json').then(function (r) {
      var list = r.data.danmaku || [];
      var modeCount = {};
      list.forEach(function (item) { modeCount[item.mode] = (modeCount[item.mode] || 0) + 1; });
      var modeChips = el('div', { class: 'chips' }, Object.keys(modeCount).sort().map(function (mode) {
        return el('span', { class: 'chip', text: (MODE_LABEL[mode] || 'mode ' + mode) + ' ' + modeCount[mode] + ' 条' });
      }));

      var preview = list.slice(0, 120);
      var table = dataTable(['时间', '类型', '颜色', '内容'], preview.map(function (item) {
        return [
          fmtProgress(item.progress),
          MODE_LABEL[item.mode] || String(item.mode),
          el('span', { class: 'chip', text: colorHex(item.color) }),
          item.content
        ];
      }));

      mount(target, [el('div', { class: 'sect' }, [
        el('h3', { text: '弹幕（共 ' + r.data.count + ' 条，cid=' + r.data.cid + '）' }),
        modeChips,
        el('div', { style: 'margin-top:12px' }, [table]),
        list.length > preview.length ? el('p', { class: 'card-sub', text: '为保持页面流畅，上表只展示前 ' + preview.length + ' 条；完整数据请用下方链接。' }) : null,
        el('div', { class: 'row-flex', style: 'margin-top:10px' }, [
          el('a', { class: 'btn sm', href: '/api/video/' + bvid + '/danmaku?format=json', target: '_blank', rel: 'noreferrer', text: '查看 JSON' }),
          el('a', { class: 'btn sm', href: '/api/video/' + bvid + '/danmaku?format=xml', target: '_blank', rel: 'noreferrer', text: '查看 XML' })
        ])
      ])]);
    }).catch(function (err) { mount(target, errorCard(err)); });
  }

  function loadPages(target, bvid, detail) {
    mount(target, loadingBox('正在获取分P 列表…'));
    apiOk('/api/video/' + bvid + '/pages').then(function (r) {
      var pages = r.data.pages || [];
      mount(target, [el('div', { class: 'sect' }, [
        el('h3', { text: '分P 列表（共 ' + r.data.count + ' 个）' }),
        pages.length
          ? dataTable(['P', 'cid', '标题', '时长', '来源'], pages.map(function (p) {
              return [p.page, p.cid, p.title, fmtDuration(p.duration), p.from];
            }))
          : emptyBox('该视频没有分P 信息'),
        pages.length > 1 ? el('p', { class: 'card-sub', text: '点击任意一行可取该分P 的播放地址。' }) : null
      ])]);
      if (detail && pages.length > 1) {
        // 分P 表格里的 cid 可点击切换播放地址请求
        var rows = target.querySelectorAll('tbody tr');
        rows.forEach(function (row, index) {
          row.style.cursor = 'pointer';
          row.title = '点击获取该分P 的播放地址';
          row.addEventListener('click', function () {
            loadPlayUrl(target, detail.bvid, pages[index].cid, 80);
          });
        });
      }
    }).catch(function (err) { mount(target, errorCard(err)); });
  }

  function loadVideoCollection(target, bvid) {
    mount(target, loadingBox('正在查询所属合集…'));
    apiOk('/api/video/' + bvid + '/collection').then(function (r) {
      var info = r.data.info;
      var videos = r.data.videos || [];
      mount(target, [el('div', { class: 'sect' }, [
        el('h3', { text: '所属合集 / 收藏夹' }),
        el('div', { class: 'kv' }, [
          el('div', {}, [el('div', { class: 'k', text: '类型' }), el('div', { class: 'v', text: info.type })]),
          el('div', {}, [el('div', { class: 'k', text: '标题' }), el('div', { class: 'v', text: info.title || '—' })]),
          el('div', {}, [el('div', { class: 'k', text: 'ID' }), el('div', { class: 'v', text: info.id })]),
          el('div', {}, [el('div', { class: 'k', text: '总数' }), el('div', { class: 'v', text: info.count })]),
          el('div', {}, [el('div', { class: 'k', text: 'UP 主' }), el('div', { class: 'v', text: info.upperName || '—' })])
        ]),
        videos.length ? el('div', { class: 'vlist', style: 'margin-top:12px' }, videos.map(function (v) { return videoItem(v, openVideoInPanel); })) : emptyBox('没有展开到合集内的视频')
      ])]);
    }).catch(function (err) {
      if (err.code === -404) {
        mount(target, [emptyBox('该视频不属于任何合集（上游返回 404，属正常情况）')]);
        return;
      }
      mount(target, errorCard(err));
    });
  }

  function renderIframePlayer(target, bvid, cid) {
    var src = 'https://player.bilibili.com/player.html?bvid=' + bvid + '&cid=' + cid + '&autoplay=0&high_quality=1';
    mount(target, [el('div', { class: 'sect' }, [
      el('h3', { text: '官方播放器（iframe 嵌入）' }),
      el('div', { class: 'frame-wrap' }, [el('iframe', { src: src, allowfullscreen: true, frameborder: '0', scrolling: 'no' })]),
      el('p', { class: 'card-sub', text: '使用哔哩哔哩官方播放器嵌入，播放的是官方页面而非接口返回的直链。' })
    ])]);
    showToastSafe('已加载官方播放器，若长时间黑屏请检查网络对 player.bilibili.com 的可达性');
  }

  function showToastSafe(message) { toast(message); }

  function openVideoInPanel(bvid) {
    showTab('video');
    q1('#videoInput').value = bvid;
    loadVideo(bvid);
  }

  q1('#videoForm').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var value = q1('#videoInput').value.trim();
    if (!value) { toast('请输入 BV 号 / av 号 / 视频链接', true); return; }
    loadVideo(value);
  });

  q1('#videoExampleBtn').addEventListener('click', function () {
    q1('#videoInput').value = 'BV1GJ411x7h7';
    loadVideo('BV1GJ411x7h7');
  });

  /* ------------------------------------------------------------------ *
   * UP 主面板
   * ------------------------------------------------------------------ */

  var currentMid = null;

  function renderUploader(info) {
    var head = el('div', { class: 'video-head' }, [
      el('img', { class: 'cover', style: 'width:96px;height:96px;aspect-ratio:1/1;border-radius:50%', src: info.face, alt: '', referrerpolicy: 'no-referrer' }),
      el('div', { class: 'video-meta' }, [
        el('h2', { text: info.name || '（无昵称）' }),
        el('div', { class: 'owner-row' }, [
          el('span', { class: 'muted tiny', text: 'UID ' + info.mid }),
          el('span', { class: 'chip', text: '等级 LV' + info.level }),
          el('span', { class: 'chip', text: info.sex === '男' ? '男' : info.sex === '女' ? '女' : '保密' }),
          el('a', { class: 'btn sm', href: info.url, target: '_blank', rel: 'noreferrer', text: '打开空间' })
        ]),
        el('div', { class: 'stats' }, [
          statBox(info.follower, '粉丝'),
          statBox(info.following, '关注'),
          statBox(info.video, '投稿'),
          statBox(info.likes, '获赞')
        ]),
        el('div', { class: 'desc open', text: info.sign || '（这个人很神秘，什么都没写）' })
      ])
    ]);
    var tools = el('div', { id: 'userTools' });
    var listBox = el('div', { id: 'userVideos', style: 'margin-top:16px' });
    var actions = el('div', { class: 'actions' }, [
      el('button', {
        class: 'btn', type: 'button', text: '加载投稿列表',
        onclick: function () { loadUserVideos(listBox, info.mid, 1); }
      }),
      el('button', {
        class: 'btn', type: 'button', text: '按播放量排序',
        onclick: function () { loadUserVideos(listBox, info.mid, 1, 'click'); }
      }),
      el('a', { class: 'btn', href: '/api/user/' + info.mid, target: '_blank', rel: 'noreferrer', text: '查看原始 JSON' })
    ]);
    return el('div', { class: 'card' }, [head, actions, tools, listBox]);
  }

  function loadUser(rawInput) {
    var out = q1('#userOut');
    var mid = String(rawInput === undefined ? q1('#userInput').value : rawInput).trim();
    if (!mid) { toast('请输入 UP 主 UID 或空间链接', true); return; }
    mount(out, loadingBox('正在查询 UP 主 ' + mid + ' …'));
    apiOk('/api/user/' + encodeURIComponent(mid)).then(function (r) {
      currentMid = r.data.mid;
      mount(out, [renderUploader(r.data)]);
    }).catch(function (err) { mount(out, errorCard(err)); });
  }

  function loadUserVideos(target, mid, page, order) {
    mount(target, loadingBox('正在加载投稿列表（第 ' + page + ' 页）…'));
    var query = '/api/user/' + mid + '/videos?page=' + page + '&pageSize=12' + (order ? '&order=' + order : '');
    apiOk(query).then(function (r) {
      var d = r.data;
      var nodes = [];
      if (r.meta && r.meta.warning) nodes.push(banner('warn', r.meta.warning));
      nodes.push(el('h3', { text: '投稿列表' }));
      nodes.push(d.items.length
        ? el('div', { class: 'vlist' }, d.items.map(function (v) { return videoItem(v, openVideoInPanel); }))
        : emptyBox('没有返回投稿'));
      nodes.push(pager(d.page, d.pageCount, d.total, function (next) { loadUserVideos(target, mid, next, order); }));
      mount(target, nodes);
    }).catch(function (err) { mount(target, errorCard(err)); });
  }

  q1('#userForm').addEventListener('submit', function (ev) {
    ev.preventDefault();
    loadUser();
  });

  /* ------------------------------------------------------------------ *
   * 搜索面板
   * ------------------------------------------------------------------ */

  function doSearch(page) {
    var out = q1('#searchOut');
    var type = q1('#searchType').value;
    var keyword = q1('#searchInput').value.trim();
    if (!keyword) { toast('请输入搜索关键词', true); return; }
    mount(out, loadingBox('正在搜索「' + keyword + '」…'));
    var path = type === 'user'
      ? '/api/search/user?keyword=' + encodeURIComponent(keyword) + '&page=' + page + '&pageSize=12'
      : '/api/search/video?keyword=' + encodeURIComponent(keyword) + '&page=' + page + '&pageSize=12';

    apiOk(path).then(function (r) {
      var d = r.data;
      var nodes = [];
      nodes.push(el('h3', { text: (type === 'user' ? 'UP 主搜索' : '视频搜索') + '结果' }));
      if (!d.items.length) {
        nodes.push(emptyBox('没有返回结果'));
      } else if (type === 'user') {
        nodes.push(el('div', { class: 'vlist' }, d.items.map(function (u) {
          return el('div', { class: 'vitem' }, [
            el('img', { class: 'vthumb', style: 'width:56px;aspect-ratio:1/1;border-radius:50%', src: u.face, alt: '', referrerpolicy: 'no-referrer' }),
            el('div', { class: 'vbody' }, [
              el('div', { text: u.name || '（无昵称）' }),
              el('div', { class: 'vmeta' }, [
                el('span', { text: 'UID ' + u.mid }),
                el('span', { text: '粉丝 ' + fmtCount(u.fans) }),
                el('span', { text: '投稿 ' + fmtCount(u.videos) })
              ]),
              el('div', { class: 'muted tiny', text: u.sign || '' })
            ]),
            el('button', {
              class: 'btn sm', type: 'button', text: '查看',
              onclick: function () {
                q1('#userInput').value = String(u.mid);
                showTab('user');
                loadUser(u.mid);
              }
            })
          ]);
        })));
      } else {
        nodes.push(el('div', { class: 'vlist' }, d.items.map(function (v) { return videoItem(v, openVideoInPanel); })));
      }
      nodes.push(pager(d.page, d.pageCount, d.total, function (next) { doSearch(next); }));
      mount(out, nodes);
    }).catch(function (err) {
      var nodes = [errorCard(err)];
      if (err.code === -412) {
        nodes.push(el('div', { class: 'card' }, [
          el('p', { class: 'card-sub', text: '这是被正确识别的风控，而不是「搜索没有结果」。上游此时只返回 v_voucher 而没有任何结果集，服务端已把它判成 -412 而不是静默返回空列表。' })
        ]));
      }
      mount(out, nodes);
    });
  }

  q1('#searchForm').addEventListener('submit', function (ev) {
    ev.preventDefault();
    doSearch(1);
  });

  /* ------------------------------------------------------------------ *
   * 收藏夹面板
   * ------------------------------------------------------------------ */

  function loadFavlist(page) {
    var out = q1('#favOut');
    var raw = q1('#favInput').value.trim();
    if (!raw) { toast('请输入收藏夹 media_id 或链接', true); return; }
    mount(out, loadingBox('正在查询收藏夹…'));
    apiOk('/api/favlist/' + encodeURIComponent(raw) + '?page=' + page + '&pageSize=12').then(function (r) {
      var d = r.data;
      var info = d.info;
      var nodes = [el('div', { class: 'card' }, [
        el('h2', { text: info.title || '（无标题收藏夹）' }),
        el('div', { class: 'kv' }, [
          el('div', {}, [el('div', { class: 'k', text: 'media_id' }), el('div', { class: 'v', text: info.id })]),
          el('div', {}, [el('div', { class: 'k', text: '类型' }), el('div', { class: 'v', text: info.type })]),
          el('div', {}, [el('div', { class: 'k', text: '内容数' }), el('div', { class: 'v', text: info.count })]),
          el('div', {}, [el('div', { class: 'k', text: '创建者' }), el('div', { class: 'v', text: info.upperName || '—' })]),
          el('div', {}, [el('div', { class: 'k', text: '创建者 UID' }), el('div', { class: 'v', text: info.mid || '—' })])
        ]),
        el('div', { class: 'actions' }, [
          el('a', { class: 'btn sm', href: '/api/favlist/' + info.id, target: '_blank', rel: 'noreferrer', text: '查看原始 JSON' })
        ])
      ])];
      nodes.push(el('div', { class: 'card' }, [
        el('h3', { text: '收藏内容' }),
        d.videos.length
          ? el('div', { class: 'vlist' }, d.videos.map(function (v) { return videoItem(v, openVideoInPanel); }))
          : emptyBox('没有返回视频'),
        pager(d.page, d.pageCount, d.total, function (next) { loadFavlist(next); })
      ]));
      mount(out, nodes);
    }).catch(function (err) { mount(out, errorCard(err)); });
  }

  q1('#favForm').addEventListener('submit', function (ev) {
    ev.preventDefault();
    loadFavlist(1);
  });

  /* ------------------------------------------------------------------ *
   * 接口清单面板
   * ------------------------------------------------------------------ */

  var endpointsLoaded = false;

  function loadEndpointList() {
    if (endpointsLoaded) return;
    var out = q1('#apiOut');
    mount(out, loadingBox('读取接口清单…'));
    apiOk('/').then(function (r) {
      var service = r.data.service;
      var endpoints = r.data.endpoints || [];
      var auth = r.data.auth || {};
      endpointsLoaded = true;

      var rows = endpoints.map(function (e) {
        return el('tr', {}, [
          el('td', { class: 'mono', text: e.method }),
          el('td', {}, [el('a', { class: 'mono', href: e.path.replace(':id', 'BV1GJ411x7h7').replace(':mid', '8047632').replace(':mediaId', '1'), target: '_blank', rel: 'noreferrer', text: e.path })]),
          el('td', { text: e.desc }),
          el('td', { class: 'mono', text: e.query || '—' })
        ]);
      });

      mount(out, [el('div', { class: 'card' }, [
        el('h2', { text: service.name + ' v' + service.version }),
        el('p', { class: 'card-sub', text: service.description }),
        banner('warn', auth.usingCookie
          ? '当前服务端已配置 BILI_COOKIE（登录态），高清晰度与风控敏感接口的成功率更高。'
          : '当前以游客身份请求，只能拿到低清晰度流，且投稿 / 搜索类接口可能被风控。服务端配置 BILI_COOKIE 可改善。'),
        el('div', { class: 'tbl-wrap' }, [el('table', {}, [
          el('thead', {}, [el('tr', {}, [el('th', { text: '方法' }), el('th', { text: '路径' }), el('th', { text: '说明' }), el('th', { text: '查询参数' })])]),
          el('tbody', {}, rows)
        ])]),
        el('p', { class: 'card-sub', style: 'margin-top:12px', text: service.disclaimer })
      ])]);
    }).catch(function (err) { mount(out, errorCard(err)); });
  }

  /* ------------------------------------------------------------------ *
   * 启动
   * ------------------------------------------------------------------ */

  refreshHealth();
  loadEndpointList();

  // 预填一个示例并自动查询，让页面打开即有内容
  q1('#videoInput').value = 'BV1GJ411x7h7';
  loadVideo('BV1GJ411x7h7');
})();
</script>
</body>
</html>
`;
