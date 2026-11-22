(function () {
  "use strict";
  var BASE = "__BASE__";
  var MGMT = "/v0/management" + BASE;
  var HOST_MGMT = "/v0/management";
  var logSeq = 0;
  var logTimer = null;
  var queueTimer = null;
  var lastQueueSeq = 0;
  var stopped = false;
  var authReady = false;

  // ---- 主题、免责提示条与多视图标签切换 ----
  var THEME_STORE_KEY = "tierbridge-ui-theme";
  var NOTICE_STORE_KEY = "tierbridge-notice-dismissed";
  var currentTheme = "auto";
  var activeView = "accounts";

  function applyTheme(mode) {
    currentTheme = (mode === "light" || mode === "dark") ? mode : "auto";
    if (currentTheme === "auto") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", currentTheme);
    try { localStorage.setItem(THEME_STORE_KEY, currentTheme); } catch (e) { /* 忽略 */ }
    var label = document.getElementById("themeLabel");
    var icon = document.getElementById("themeIcon");
    if (label) label.textContent = currentTheme === "light" ? "浅色" : (currentTheme === "dark" ? "深色" : "自动");
    if (icon) {
      icon.textContent = currentTheme === "light" ? "☀" : (currentTheme === "dark" ? "☾" : "◐");
    }
  }

  function initTheme() {
    var saved = "auto";
    try { saved = migrateStoredValue(localStorage, THEME_STORE_KEY, "freetier-ui-theme") || "auto"; } catch (e) { /* 忽略 */ }
    applyTheme(saved);
    var btn = document.getElementById("btnTheme");
    if (btn) {
      btn.addEventListener("click", function () {
        var next = currentTheme === "auto" ? "light" : (currentTheme === "light" ? "dark" : "auto");
        applyTheme(next);
      });
    }
  }

  function setNoticeVisible(visible) {
    var bar = document.getElementById("disclaimerBar");
    var btn = document.getElementById("btnNoticeToggle");
    if (bar) bar.hidden = !visible;
    if (btn) btn.classList.toggle("active", !!visible);
    try { localStorage.setItem(NOTICE_STORE_KEY, visible ? "0" : "1"); } catch (e) { /* 忽略 */ }
  }

  function initNotice() {
    var dismissed = false;
    try { dismissed = migrateStoredValue(localStorage, NOTICE_STORE_KEY, "freetier-notice-dismissed") === "1"; } catch (e) { /* 忽略 */ }
    setNoticeVisible(!dismissed);
    var closeBtn = document.getElementById("btnCloseDisclaimer");
    var toggleBtn = document.getElementById("btnNoticeToggle");
    if (closeBtn) closeBtn.addEventListener("click", function () { setNoticeVisible(false); });
    if (toggleBtn) {
      toggleBtn.addEventListener("click", function () {
        var bar = document.getElementById("disclaimerBar");
        setNoticeVisible(bar ? bar.hidden : true);
      });
    }
  }

  var VALID_VIEWS = ["accounts", "models", "tasks", "settings", "logs"];

  function switchView(name, updateHash) {
    if (VALID_VIEWS.indexOf(name) < 0) name = "accounts";
    if (name === "tasks" && taskModulesReady && taskModules.length === 0) name = "accounts";
    activeView = name;
    VALID_VIEWS.forEach(function (v) {
      var sec = document.getElementById("view-" + v);
      if (sec) sec.classList.toggle("active", v === name);
    });
    Array.prototype.forEach.call(document.querySelectorAll("#mainTabs a[data-view]"), function (tab) {
      var isAct = tab.getAttribute("data-view") === name;
      tab.classList.toggle("active", isAct);
      tab.setAttribute("aria-selected", isAct ? "true" : "false");
    });
    if (updateHash !== false) {
      try {
        if (location.hash !== "#view-" + name) history.replaceState(null, "", "#view-" + name);
      } catch (e) { /* 忽略 */ }
    }
    if (typeof syncAllTableScrollShadows === "function") {
      requestAnimationFrame(syncAllTableScrollShadows);
    }
  }

  function initTabs() {
    Array.prototype.forEach.call(document.querySelectorAll("#mainTabs a[data-view]"), function (tab) {
      tab.addEventListener("click", function (ev) {
        ev.preventDefault();
        switchView(tab.getAttribute("data-view"), true);
      });
    });
    function syncFromHash() {
      var m = /^#view-([a-z]+)$/.exec(location.hash || "");
      switchView(m ? m[1] : "accounts", false);
    }
    window.addEventListener("hashchange", syncFromHash);
    syncFromHash();
  }

  // ---- 管理密钥的获取（支持记住密钥、同源复用 CPA 面板密钥与退出锁屏，防 IP 封禁闸门） ----
  var PANEL_STORE_KEY = "cli-proxy-auth";
  var PANEL_KEY_FIELD = "managementKey";
  var MANUAL_STORE_KEY = "cpa-management-key";
  var REMEMBER_STORE_KEY = "cpa-tierbridge-management-key";
  var LOGGED_OUT_STORE_KEY = "cpa-tierbridge-logged-out";
  var LEGACY_REMEMBER_STORE_KEY = "cpa-freetier-management-key";
  var LEGACY_LOGGED_OUT_STORE_KEY = "cpa-freetier-logged-out";
  var OBF_PREFIX_RE = /^enc::v(\d+)::/;
  var OBF_SEED = "cli-proxy-api-webui::secure-storage";
  var manualKey = "";
  var keyBusy = false;
  var keyRetryAfter = 0;

  function migrateStoredValue(storage, key, legacyKey) {
    var current = storage.getItem(key);
    if (current !== null) return current;
    var legacy = storage.getItem(legacyKey);
    if (legacy !== null) {
      try {
        storage.setItem(key, legacy);
        storage.removeItem(legacyKey);
      } catch (e) { /* 存储只读时继续使用旧值 */ }
    }
    return legacy;
  }

  function obfuscationKeys(version) {
    var official = OBF_SEED + "|" + location.host;
    if (version === "1") return [official + "|" + navigator.userAgent];
    return [official, OBF_SEED + "|v" + version + "|" + location.host];
  }

  function xorEncode(plainText, keyText) {
    var key = new TextEncoder().encode(keyText);
    var bytes = new TextEncoder().encode(plainText);
    var bin = "";
    for (var i = 0; i < bytes.length; i++) {
      bin += String.fromCharCode(bytes[i] ^ key[i % key.length]);
    }
    return btoa(bin);
  }

  function xorDecode(payload, keyText) {
    var key = new TextEncoder().encode(keyText);
    var binary = atob(payload);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    for (var j = 0; j < bytes.length; j++) bytes[j] ^= key[j % key.length];
    return new TextDecoder().decode(bytes);
  }

  function isObfuscated(raw) { return OBF_PREFIX_RE.test(raw); }

  function deobfuscateAll(raw) {
    var match = OBF_PREFIX_RE.exec(raw || "");
    if (!match) return [];
    var version = match[1];
    if (version !== "1" && version !== "2") {
      try { console.warn("面板存储格式版本不受支持，请升级本插件：enc::v" + version + "::"); } catch (e) { /* 忽略 */ }
      return [];
    }
    var payload = raw.slice(match[0].length);
    var texts = [];
    obfuscationKeys(version).forEach(function (keyText) {
      try { texts.push(xorDecode(payload, keyText)); } catch (e) { /* 试下一个 */ }
    });
    return texts;
  }

  function encodeRememberedKey(key) {
    var secret = OBF_SEED + "|" + location.host;
    return "enc::v2::" + xorEncode(JSON.stringify({ key: key }), secret);
  }

  function rememberedLocalKey() {
    var raw, legacy;
    try {
      raw = localStorage.getItem(REMEMBER_STORE_KEY);
      legacy = raw === null;
      if (legacy) raw = localStorage.getItem(LEGACY_REMEMBER_STORE_KEY);
    } catch (e) { return ""; }
    if (!raw) return "";
    var texts = isObfuscated(raw) ? deobfuscateAll(raw) : [raw];
    for (var i = 0; i < texts.length; i++) {
      var key = "";
      try {
        var parsed = JSON.parse(texts[i]);
        if (parsed && typeof parsed === "object") {
          key = normalizeKeyValue(parsed.key);
        }
      } catch (e) {
        key = normalizeKeyValue(texts[i]);
      }
      if (!key) continue;
      if (legacy) {
        try {
          localStorage.setItem(REMEMBER_STORE_KEY, encodeRememberedKey(key));
          localStorage.removeItem(LEGACY_REMEMBER_STORE_KEY);
        } catch (e) { /* 保留旧值供下次读取 */ }
      }
      return key;
    }
    return "";
  }

  function isExplicitlyLoggedOut() {
    try { return migrateStoredValue(sessionStorage, LOGGED_OUT_STORE_KEY, LEGACY_LOGGED_OUT_STORE_KEY) === "1"; } catch (e) { return false; }
  }

  function saveRememberedKey(key, remember) {
    try { sessionStorage.removeItem(LOGGED_OUT_STORE_KEY); } catch (e) { /* 忽略 */ }
    try { sessionStorage.removeItem(LEGACY_LOGGED_OUT_STORE_KEY); } catch (e) { /* 忽略 */ }
    try { sessionStorage.setItem(MANUAL_STORE_KEY, key); } catch (e) { /* 忽略 */ }
    try {
      if (remember) localStorage.setItem(REMEMBER_STORE_KEY, encodeRememberedKey(key));
      else localStorage.removeItem(REMEMBER_STORE_KEY);
      localStorage.removeItem(LEGACY_REMEMBER_STORE_KEY);
    } catch (e) { /* 忽略 */ }
  }

  function clearSavedKeys(markLoggedOut) {
    manualKey = "";
    try { sessionStorage.removeItem(MANUAL_STORE_KEY); } catch (e) { /* 忽略 */ }
    try { localStorage.removeItem(REMEMBER_STORE_KEY); localStorage.removeItem(LEGACY_REMEMBER_STORE_KEY); } catch (e) { /* 忽略 */ }
    try {
      sessionStorage.removeItem(LEGACY_LOGGED_OUT_STORE_KEY);
      if (markLoggedOut) sessionStorage.setItem(LOGGED_OUT_STORE_KEY, "1");
      else sessionStorage.removeItem(LOGGED_OUT_STORE_KEY);
    } catch (e) { /* 忽略 */ }
  }

  var KEY_RE = /^[\x21-\x7E]+$/;

  function normalizeKeyValue(raw) {
    if (!raw) return "";
    var text = String(raw).trim();
    if (isObfuscated(text)) return "";
    if (text === "null" || text === "undefined") return "";
    if (text.length > 1 && text.charAt(0) === '"' && text.charAt(text.length - 1) === '"') {
      try { text = JSON.parse(text); } catch (e) { /* 保留 */ }
    }
    if (typeof text !== "string") return "";
    text = text.trim();
    if (text === "" || text === "null" || text === "undefined") return "";
    if (!KEY_RE.test(text)) return "";
    return text;
  }

  function snapshotKey(text) {
    var snapshot = null;
    try { snapshot = JSON.parse(text); } catch (e) { return ""; }
    if (!snapshot || typeof snapshot !== "object") return "";
    var state = (snapshot.state && typeof snapshot.state === "object") ? snapshot.state : snapshot;
    return normalizeKeyValue(state[PANEL_KEY_FIELD]);
  }

  function panelAuthKey() {
    var raw = "";
    try { raw = localStorage.getItem(PANEL_STORE_KEY) || ""; } catch (e) { return ""; }
    if (!raw) return "";
    var texts = isObfuscated(raw) ? deobfuscateAll(raw) : [raw];
    for (var i = 0; i < texts.length; i++) {
      var key = snapshotKey(texts[i]);
      if (key) return key;
    }
    return "";
  }

  function managementKey() {
    if (manualKey) return manualKey;
    if (isExplicitlyLoggedOut()) return "";
    try {
      var sessionKey = normalizeKeyValue(sessionStorage.getItem(MANUAL_STORE_KEY));
      if (sessionKey) return sessionKey;
    } catch (e) { /* 忽略 */ }
    var localKey = rememberedLocalKey();
    if (localKey) return localKey;
    return panelAuthKey();
  }

  var bannerTimer = null;

  function banner(kind, text, duration) {
    if (bannerTimer) { clearTimeout(bannerTimer); bannerTimer = null; }
    var node = document.getElementById("banner");
    if (!node) return;
    node.className = "banner show " + kind;
    node.textContent = text;
    var timeout = duration !== undefined ? duration : (kind === "ok" ? 5000 : (kind === "warn" ? 6000 : 8000));
    if (timeout > 0) {
      bannerTimer = setTimeout(function () { clearBanner(); }, timeout);
    }
  }

  function clearBanner() {
    if (bannerTimer) { clearTimeout(bannerTimer); bannerTimer = null; }
    var node = document.getElementById("banner");
    if (node) node.className = "banner";
  }

  function haltOnAuthFailure(status) {
    if (status !== 401 && status !== 403) return false;
    stopped = true;
    authReady = false;
    clearSavedKeys(false);
    if (logTimer) { clearInterval(logTimer); logTimer = null; }
    if (queueTimer) { clearInterval(queueTimer); queueTimer = null; }
    stopLoginPolling();
    revealKeyInput();
    setKeyStatus("管理密钥无效或缺失（HTTP " + status + "），请重新输入", "err");
    banner("err", "管理密钥无效或缺失（HTTP " + status + "）。已停止全部自动请求，避免触发 CPA 的 IP 封禁。");
    return true;
  }

  function revealKeyInput() {
    var box = document.getElementById("keyBox");
    if (box) box.hidden = false;
    var logoutBtn = document.getElementById("btnLogout");
    if (logoutBtn) logoutBtn.hidden = true;
    var reuseBtn = document.getElementById("btnReusePanelKey");
    if (reuseBtn) reuseBtn.hidden = !panelAuthKey();
    var hdrVer = document.getElementById("headerVersion");
    var modalVer = document.getElementById("keyModalVer");
    if (hdrVer && modalVer && hdrVer.textContent) modalVer.textContent = hdrVer.textContent;
    var input = document.getElementById("keyInput");
    if (input) {
      input.type = "password";
      var eye = document.getElementById("btnToggleKeyVis");
      if (eye) eye.setAttribute("aria-pressed", "false");
      try { input.focus(); } catch (e) { /* 忽略 */ }
    }
  }

  function hideKeyInput() {
    var box = document.getElementById("keyBox");
    if (box) box.hidden = true;
    var logoutBtn = document.getElementById("btnLogout");
    if (logoutBtn) logoutBtn.hidden = false;
  }

  function setKeyStatus(text, tone) {
    var node = document.getElementById("keyStatus");
    if (node) node.textContent = text;
    var bar = document.getElementById("keyStatusBar");
    if (bar) bar.className = "auth-status-bar" + (tone ? " " + tone : "");
  }

  var HOST_PREFIX = "@host";
  function hostPath(path) { return HOST_PREFIX + path; }

  function api(method, path, body) {
    if (stopped) return Promise.resolve(null);
    var key = managementKey();
    if (!key) return Promise.resolve(null);
    var headers = { "Content-Type": "application/json", "Authorization": "Bearer " + key };
    var url = path.indexOf(HOST_PREFIX) === 0
      ? HOST_MGMT + path.slice(HOST_PREFIX.length)
      : MGMT + path;
    return fetch(url, {
      method: method,
      headers: headers,
      body: body ? JSON.stringify(body) : undefined
    }).then(function (resp) {
      var fromPlugin = resp.headers.get("X-TierBridge-Response") === "management";
      if (!fromPlugin && haltOnAuthFailure(resp.status)) return null;
      return resp.json().then(function (data) {
        if (!resp.ok) {
          var msg = (data && (data.message || data.error)) || ("HTTP " + resp.status);
          var failure = new Error(msg);
          failure.status = resp.status;
          throw failure;
        }
        return data;
      }, function () {
        var failure = new Error("CPA 返回了无法读取的响应（HTTP " + resp.status + "）");
        failure.status = resp.status;
        throw failure;
      });
    });
  }

  // ---- 通用 DOM / 格式化 / 分页辅助函数 ----
  function identity(value) { return value; }

  function el(tag, text, className) {
    var node = document.createElement(tag);
    if (text !== undefined && text !== null) node.textContent = String(text);
    if (className) node.className = className;
    return node;
  }

  function pill(text, kind) {
    return el("span", text, "pill" + (kind ? " " + kind : ""));
  }

  function svgEl(pathD, className) {
    var ns = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 20 20");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1.8");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    if (className) svg.setAttribute("class", className);
    var paths = Array.isArray(pathD) ? pathD : [pathD];
    paths.forEach(function (d) {
      var p = document.createElementNS(ns, "path");
      p.setAttribute("d", d);
      svg.appendChild(p);
    });
    return svg;
  }

  function actionIcon(name) {
    var ns = "http://www.w3.org/2000/svg";
    var icon = document.createElementNS(ns, "svg");
    icon.setAttribute("class", "btn-ico action-icon");
    icon.setAttribute("viewBox", "0 0 24 24");
    icon.setAttribute("aria-hidden", "true");
    icon.setAttribute("focusable", "false");
    var use = document.createElementNS(ns, "use");
    use.setAttribute("href", "#action-icon-" + name);
    icon.appendChild(use);
    return icon;
  }

  function shortReason(text) {
    var flat = String(text || "").replace(/\s+/g, " ").trim();
    return flat.length > 36 ? flat.slice(0, 36) + "…" : flat;
  }

  function vendorChipClass(vendorID, label) {
    var key = String(vendorID || label || "");
    var h = 0;
    for (var i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
    return "v" + (h % 6);
  }

  function cellWith(node) {
    var td = el("td");
    td.appendChild(node);
    return td;
  }

  function setText(id, text) {
    var node = document.getElementById(id);
    if (node) node.textContent = text === undefined || text === null ? "" : String(text);
  }

  function formatRelativeTime(iso) {
    if (!iso) return "-";
    var ts = Date.parse(iso);
    if (isNaN(ts)) return String(iso);
    var diff = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (diff < 60) return "刚刚";
    if (diff < 3600) return Math.floor(diff / 60) + " 分钟前";
    if (diff < 86400) return Math.floor(diff / 3600) + " 小时前";
    if (diff < 86400 * 30) return Math.floor(diff / 86400) + " 天前";
    return new Date(ts).toLocaleDateString();
  }

  function renderEmptyState(host, title, desc, actionText, actionFn) {
    var box = el("div", null, "empty-state");
    box.appendChild(el("div", title, "empty-state-title"));
    if (desc) box.appendChild(el("div", desc, "empty-state-desc"));
    if (actionText && actionFn) {
      var btn = el("button", actionText, "act primary");
      btn.type = "button";
      btn.addEventListener("click", actionFn);
      box.appendChild(btn);
    }
    host.appendChild(box);
  }

  // ---- 表格固定首尾列动态滚动阴影（仅在发生横向溢出/滚动时显现分界阴影） ----
  function syncTableScrollShadows(wrap) {
    if (!wrap) return;
    var maxScroll = Math.max(0, wrap.scrollWidth - wrap.clientWidth);
    wrap.classList.toggle("has-scroll-left", maxScroll > 1 && wrap.scrollLeft > 1);
    wrap.classList.toggle("has-scroll-right", maxScroll > 1 && (maxScroll - wrap.scrollLeft) > 1);
  }

  function syncAllTableScrollShadows() {
    Array.prototype.forEach.call(document.querySelectorAll(".table-wrap"), syncTableScrollShadows);
  }

  function bindTableScrollShadows(wrap) {
    if (!wrap) return;
    wrap.addEventListener("scroll", function () { syncTableScrollShadows(wrap); }, { passive: true });
    requestAnimationFrame(function () { syncTableScrollShadows(wrap); });
  }

  window.addEventListener("resize", syncAllTableScrollShadows);

  // ---- 统一悬浮气泡 / 点击弹出异常详情卡片（body 级固定定位，永不撑高或破坏列表对齐） ----
  var popoverState = { trigger: null, pinned: false, hideTimer: null, spec: null };

  function closeInfoPopover() {
    if (popoverState.hideTimer) { clearTimeout(popoverState.hideTimer); popoverState.hideTimer = null; }
    var pop = document.getElementById("infoPopover");
    if (pop) {
      pop.hidden = true;
      pop.className = "info-popover";
      pop.textContent = "";
    }
    if (popoverState.trigger) {
      popoverState.trigger.setAttribute("aria-expanded", "false");
    }
    popoverState.trigger = null;
    popoverState.pinned = false;
    popoverState.spec = null;
  }

  function scheduleCloseInfoPopover() {
    if (popoverState.pinned) return;
    if (popoverState.hideTimer) clearTimeout(popoverState.hideTimer);
    popoverState.hideTimer = setTimeout(function () {
      if (!popoverState.pinned) closeInfoPopover();
    }, 140);
  }

  function positionInfoPopover(trigger) {
    var pop = document.getElementById("infoPopover");
    if (!pop || !trigger || !trigger.getBoundingClientRect) return;
    var rect = trigger.getBoundingClientRect();
    var vw = window.innerWidth || 1280;
    var vh = window.innerHeight || 800;
    var margin = 10;
    var popRect = pop.getBoundingClientRect();
    var left = rect.left;
    if (left + popRect.width > vw - margin) left = Math.max(margin, vw - popRect.width - margin);
    if (left < margin) left = margin;
    var spaceBelow = vh - rect.bottom - margin;
    var top = (spaceBelow >= popRect.height + 8 || rect.top < popRect.height + 16)
      ? (rect.bottom + 8)
      : (rect.top - popRect.height - 8);
    if (top < margin) top = margin;
    if (top + popRect.height > vh - margin) top = Math.max(margin, vh - popRect.height - margin);
    pop.style.left = Math.round(left) + "px";
    pop.style.top = Math.round(top) + "px";
  }

  function openInfoPopover(trigger, spec, pinned) {
    var pop = document.getElementById("infoPopover");
    if (!pop || !trigger || !spec) return;
    if (popoverState.hideTimer) { clearTimeout(popoverState.hideTimer); popoverState.hideTimer = null; }
    if (popoverState.trigger && popoverState.trigger !== trigger) {
      popoverState.trigger.setAttribute("aria-expanded", "false");
    }
    popoverState.trigger = trigger;
    popoverState.pinned = !!pinned;
    popoverState.spec = spec;
    trigger.setAttribute("aria-expanded", pinned ? "true" : "false");

    var tone = spec.tone || "err";
    pop.className = "info-popover tone-" + tone + (pinned ? " pinned" : "");
    pop.textContent = "";

    var head = el("div", null, "pop-head");
    var titleWrap = el("div", null, "pop-title-wrap");
    titleWrap.appendChild(el("span", null, "kpi-dot " + (tone === "warn" ? "warn" : (tone === "ok" ? "ok" : "err"))));
    titleWrap.appendChild(el("span", spec.title || "提示详情", "pop-title"));
    if (spec.subtitle) titleWrap.appendChild(el("span", spec.subtitle, "pop-sub"));
    head.appendChild(titleWrap);
    if (pinned) {
      var closeBtn = el("button", "✕", "pop-close");
      closeBtn.type = "button";
      closeBtn.setAttribute("aria-label", "关闭详情");
      closeBtn.addEventListener("click", function (ev) { ev.stopPropagation(); closeInfoPopover(); });
      head.appendChild(closeBtn);
    }
    pop.appendChild(head);

    var bodyText = String(spec.detail || spec.message || "").trim() || "暂无详细信息";
    pop.appendChild(el("div", bodyText, "pop-body"));
    if (spec.meta) pop.appendChild(el("div", spec.meta, "pop-meta"));

    if (!pinned) {
      pop.appendChild(el("div", "点击标签查看完整详情或复制", "pop-cue"));
    } else {
      var foot = el("div", null, "pop-foot");
      var copyBtn = el("button", "复制信息", "act xs subtle");
      copyBtn.type = "button";
      copyBtn.addEventListener("click", function (ev) {
        ev.stopPropagation();
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(bodyText).then(function () {
            copyBtn.textContent = "已复制";
            setTimeout(function () { copyBtn.textContent = "复制信息"; }, 1600);
          }).catch(function () { banner("warn", "复制失败，可直接选中上方文本框内容复制"); });
        }
      });
      foot.appendChild(copyBtn);
      (spec.actions || []).forEach(function (act) {
        var b = el("button", act.label, "act xs" + (act.primary ? " primary" : ""));
        b.type = "button";
        b.addEventListener("click", function (ev) {
          ev.stopPropagation();
          closeInfoPopover();
          if (act.onClick) act.onClick();
        });
        foot.appendChild(b);
      });
      pop.appendChild(foot);
    }

    pop.hidden = false;
    positionInfoPopover(trigger);
  }

  function makeInteractivePill(label, tone, spec) {
    var btn = el("button", null, "pill " + tone + " pill-interactive");
    btn.type = "button";
    btn.setAttribute("aria-haspopup", "dialog");
    btn.setAttribute("aria-expanded", "false");
    btn.appendChild(el("span", label));
    btn.appendChild(svgEl(["M10 14v-3.5", "M10 7.2h.01", "M10 17.5a7.5 7.5 0 1 0 0-15 7.5 7.5 0 0 0 0 15z"], "pill-info-ico"));
    btn.addEventListener("mouseenter", function () {
      if (popoverState.pinned) return;
      openInfoPopover(btn, spec, false);
    });
    btn.addEventListener("mouseleave", function () {
      if (!popoverState.pinned) scheduleCloseInfoPopover();
    });
    btn.addEventListener("focus", function () {
      if (!popoverState.pinned) openInfoPopover(btn, spec, false);
    });
    btn.addEventListener("blur", function () {
      if (!popoverState.pinned) scheduleCloseInfoPopover();
    });
    btn.addEventListener("click", function (ev) {
      ev.stopPropagation();
      if (popoverState.pinned && popoverState.trigger === btn) {
        closeInfoPopover();
      } else {
        closeAllCustomSelects();
        closeVendorMenu();
        closeModelColumnsMenu();
        openInfoPopover(btn, spec, true);
      }
    });
    return btn;
  }

  (function bindInfoPopoverEvents() {
    var pop = document.getElementById("infoPopover");
    if (!pop) return;
    pop.addEventListener("mouseenter", function () {
      if (popoverState.hideTimer) { clearTimeout(popoverState.hideTimer); popoverState.hideTimer = null; }
    });
    pop.addEventListener("mouseleave", function () {
      if (!popoverState.pinned) scheduleCloseInfoPopover();
    });
    pop.addEventListener("click", function (ev) { ev.stopPropagation(); });
    window.addEventListener("scroll", function () {
      if (!pop.hidden) {
        if (popoverState.pinned && popoverState.trigger && document.body.contains(popoverState.trigger)) {
          positionInfoPopover(popoverState.trigger);
        } else {
          closeInfoPopover();
        }
      }
    }, true);
    window.addEventListener("resize", function () {
      if (!pop.hidden && popoverState.trigger) positionInfoPopover(popoverState.trigger);
    });
  })();

  // ---- 美化自定义下拉选择框（渐进增强原生 <select>，保留原 DOM ID、value 与 change 事件） ----
  var customSelectRegistry = [];

  function closeAllCustomSelects(exceptWrap) {
    customSelectRegistry.forEach(function (entry) {
      if (entry.wrap !== exceptWrap) entry.close();
    });
  }

  function syncCustomSelect(sel) {
    if (!sel || !sel._cselectSync) return;
    sel._cselectSync();
  }

  function enhanceSelect(sel, opts) {
    if (!sel || sel._cselectEnhanced || !sel.parentNode) return;
    opts = opts || {};
    sel._cselectEnhanced = true;

    var wrap = el("div", null, "cselect" + (opts.compact ? " cselect-sm" : "") + (opts.wide ? " cselect-wide" : "") + (opts.alignRight ? " align-right" : ""));
    sel.parentNode.insertBefore(wrap, sel);
    sel.classList.add("cselect-native");
    sel.setAttribute("tabindex", "-1");
    sel.setAttribute("aria-hidden", "true");
    wrap.appendChild(sel);

    var trigger = el("button", null, "cselect-trigger");
    trigger.type = "button";
    trigger.setAttribute("aria-haspopup", "listbox");
    trigger.setAttribute("aria-expanded", "false");
    var ariaLbl = sel.getAttribute("aria-label");
    if (ariaLbl) trigger.setAttribute("aria-label", ariaLbl);
    var labelSpan = el("span", "", "cselect-label");
    var chev = svgEl("M6 8l4 4 4-4", "cselect-chev");
    trigger.appendChild(labelSpan);
    trigger.appendChild(chev);
    wrap.appendChild(trigger);

    var menu = el("div", null, "cselect-menu");
    menu.setAttribute("role", "listbox");
    menu.hidden = true;
    wrap.appendChild(menu);

    function parseOptionLabel(raw) {
      var text = String(raw || "");
      if (opts.richHints) {
        var m = /^([^（(]+)[（(]([^）)]+)[）)]$/.exec(text.trim());
        if (m) return { main: m[1].trim(), sub: m[2].trim(), full: text };
      }
      return { main: text, sub: "", full: text };
    }

    function rebuildOptions() {
      menu.textContent = "";
      var selectedOpt = sel.options[sel.selectedIndex] || sel.options[0];
      labelSpan.textContent = selectedOpt ? selectedOpt.textContent : "";
      Array.prototype.forEach.call(sel.options, function (opt) {
        var info = parseOptionLabel(opt.textContent);
        var btn = el("button", null, "cselect-opt" + (opt.value === sel.value ? " selected" : ""));
        btn.type = "button";
        btn.setAttribute("role", "option");
        btn.setAttribute("aria-selected", opt.value === sel.value ? "true" : "false");
        btn.dataset.value = opt.value;
        var textCol = el("span", null, "cselect-opt-text");
        textCol.appendChild(el("span", info.main));
        if (info.sub) textCol.appendChild(el("span", info.sub, "cselect-opt-sub"));
        btn.appendChild(textCol);
        btn.appendChild(svgEl("M5 10.5l3 3 7-7", "cselect-check"));
        btn.addEventListener("click", function (ev) {
          ev.stopPropagation();
          var changed = sel.value !== opt.value;
          sel.value = opt.value;
          sync();
          close();
          trigger.focus();
          if (changed) sel.dispatchEvent(new Event("change", { bubbles: true }));
        });
        menu.appendChild(btn);
      });
    }

    function sync() {
      var selectedOpt = sel.options[sel.selectedIndex] || sel.options[0];
      labelSpan.textContent = selectedOpt ? selectedOpt.textContent : "";
      Array.prototype.forEach.call(menu.querySelectorAll(".cselect-opt"), function (b) {
        var isSel = b.dataset.value === sel.value;
        b.classList.toggle("selected", isSel);
        b.setAttribute("aria-selected", isSel ? "true" : "false");
      });
    }

    function close() {
      menu.hidden = true;
      wrap.classList.remove("open", "drop-up");
      trigger.setAttribute("aria-expanded", "false");
    }

    function open() {
      closeAllCustomSelects(wrap);
      closeVendorMenu();
      closeModelColumnsMenu();
      closeInfoPopover();
      rebuildOptions();
      var rect = trigger.getBoundingClientRect();
      var vh = window.innerHeight || 800;
      var estHeight = Math.min(260, sel.options.length * (opts.richHints ? 48 : 36) + 16);
      wrap.classList.toggle("drop-up", (vh - rect.bottom) < estHeight && rect.top > estHeight);
      menu.hidden = false;
      wrap.classList.add("open");
      trigger.setAttribute("aria-expanded", "true");
    }

    trigger.addEventListener("click", function (ev) {
      ev.stopPropagation();
      if (menu.hidden) open(); else close();
    });
    trigger.addEventListener("keydown", function (ev) {
      if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
        ev.preventDefault();
        if (menu.hidden) { open(); return; }
        var idx = sel.selectedIndex + (ev.key === "ArrowDown" ? 1 : -1);
        if (idx >= 0 && idx < sel.options.length) {
          sel.selectedIndex = idx;
          sync();
          sel.dispatchEvent(new Event("change", { bubbles: true }));
        }
      } else if (ev.key === "Escape" && !menu.hidden) {
        ev.preventDefault();
        close();
      }
    });
    sel.addEventListener("change", sync);
    sel._cselectSync = sync;
    rebuildOptions();

    // 清理已从 DOM 移除的旧分页实例，防止内存堆积
    customSelectRegistry = customSelectRegistry.filter(function (item) {
      return item.wrap && document.body.contains(item.wrap);
    });
    customSelectRegistry.push({ wrap: wrap, close: close, sync: sync });
  }

  // renderPager 渲染紧凑分页控件（支持切换每页条数与页码跳转）。
  function renderPager(hostId, state, totalItems, sizes, onChange) {
    var host = document.getElementById(hostId);
    if (!host) return { start: 0, end: totalItems };
    host.textContent = "";
    if (!totalItems) return { start: 0, end: 0 };
    var size = state.pageSize;
    var pages = size > 0 ? Math.max(1, Math.ceil(totalItems / size)) : 1;
    if (state.page > pages) state.page = pages;
    if (state.page < 1) state.page = 1;
    var start = size > 0 ? (state.page - 1) * size : 0;
    var end = size > 0 ? Math.min(totalItems, start + size) : totalItems;

    var left = el("div", null, "pager-left");
    left.appendChild(el("span", "显示 " + (start + 1) + "–" + end + " / 共 " + totalItems + " 项", "tnum"));
    var sel = document.createElement("select");
    sel.setAttribute("aria-label", "每页显示条数");
    sizes.forEach(function (n) {
      var opt = document.createElement("option");
      opt.value = String(n);
      opt.textContent = n > 0 ? (n + " 条/页") : "显示全部";
      if (n === size) opt.selected = true;
      sel.appendChild(opt);
    });
    sel.addEventListener("change", function () {
      state.pageSize = parseInt(sel.value, 10) || 0;
      state.page = 1;
      onChange();
    });
    left.appendChild(sel);
    host.appendChild(left);
    enhanceSelect(sel, { compact: true });

    if (pages > 1) {
      var right = el("div", null, "pager-right");
      var prev = el("button", "上一页", "pager-btn");
      prev.type = "button";
      prev.disabled = state.page <= 1;
      prev.addEventListener("click", function () { state.page--; onChange(); });
      right.appendChild(prev);

      var nums = [];
      for (var p = 1; p <= pages; p++) {
        if (p === 1 || p === pages || Math.abs(p - state.page) <= 1) nums.push(p);
        else if (nums[nums.length - 1] !== "...") nums.push("...");
      }
      nums.forEach(function (item) {
        if (item === "...") {
          right.appendChild(el("span", "…", "muted"));
          return;
        }
        var b = el("button", String(item), "pager-btn" + (item === state.page ? " active" : ""));
        b.type = "button";
        b.addEventListener("click", function () { state.page = item; onChange(); });
        right.appendChild(b);
      });

      var next = el("button", "下一页", "pager-btn");
      next.type = "button";
      next.disabled = state.page >= pages;
      next.addEventListener("click", function () { state.page++; onChange(); });
      right.appendChild(next);
      host.appendChild(right);
    }
    return { start: start, end: end };
  }

  // editableCell 行内编辑单元格（账号别名、模型 ID、模型上下文共用）。
  function editableCell(opts) {
    var cell = el("td");
    var saved = opts.saved || "";
    var normalize = opts.normalize || identity;
    var wrap = el("span", null, "editable");
    wrap.setAttribute("role", "button");
    wrap.setAttribute("tabindex", "0");
    var nameSpan = el("span", null, opts.mono ? "editablename mono" : "editablename");
    var pencil = el("span", "✎", "editableedit");
    pencil.setAttribute("aria-hidden", "true");
    wrap.appendChild(nameSpan);
    wrap.appendChild(pencil);
    cell.appendChild(wrap);
    syncName();

    function syncName() {
      nameSpan.textContent = saved ? (opts.display ? opts.display(saved) : saved) : opts.fallback();
      wrap.setAttribute("title", opts.title(saved));
    }

    function restore(focusBack) {
      cell.textContent = "";
      syncName();
      cell.appendChild(wrap);
      if (focusBack) wrap.focus();
    }

    function beginEdit() {
      var initial = saved || opts.prefill();
      var input = document.createElement("input");
      input.type = "text";
      input.className = "aliasinput";
      input.value = initial;
      input.placeholder = opts.placeholder || "";
      var done = false;

      function finish(commit, focusBack) {
        if (done) return;
        done = true;
        var next = normalize(commit ? (input.value || "").trim() : saved);
        if (!commit || next === saved || next === normalize(initial)) { restore(focusBack); return; }
        input.disabled = true;
        Promise.resolve().then(function () { return opts.save(next); }).then(function (ok) {
          if (ok === false) { restore(focusBack); return; }
          saved = ok && typeof ok.value === "string" ? ok.value : next;
          restore(focusBack);
        }).catch(function (err) {
          banner("err", err.message);
          restore(focusBack);
        });
      }

      input.addEventListener("keydown", function (ev) {
        if (ev.key === "Enter") { ev.preventDefault(); finish(true, true); }
        else if (ev.key === "Escape") { ev.preventDefault(); finish(false, true); }
      });
      input.addEventListener("blur", function () { finish(true, false); });

      cell.textContent = "";
      cell.appendChild(input);
      input.focus();
      input.setSelectionRange(0, opts.selectAll ? input.value.length : 0);
    }

    wrap.addEventListener("click", beginEdit);
    wrap.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); beginEdit(); }
    });
    return cell;
  }

  // ---- 供应商表与双列可搜索选择器 ----
  var vendorsById = {};
  var vendorsList = [];
  var vendorsLoaded = false;
  var vendorPickerRegion = "all";
  var vendorPickerQuery = "";

  function vendorAuthBadge(vendor) {
    if (!vendor) return "授权";
    if (vendor.sms_login) return "短信";
    if (vendor.login_captcha) return "网页/滑块";
    if (vendor.auth_mode === "apikey") return "API Key";
    if (vendor.supports_login === false && vendor.credential_import) return "凭证 JSON";
    return "OAuth";
  }

  function vendorCountMap() {
    var counts = {};
    ((lastStatus && lastStatus.accounts) || []).forEach(function (a) {
      if (a.vendor_id) counts[a.vendor_id] = (counts[a.vendor_id] || 0) + 1;
    });
    return counts;
  }

  function renderVendorPickerGrid() {
    var grid = document.getElementById("vpGrid");
    if (!grid) return;
    grid.textContent = "";
    var q = (vendorPickerQuery || "").trim().toLowerCase();
    var counts = vendorCountMap();
    var matched = vendorsList.filter(function (v) {
      if (vendorPickerRegion !== "all") {
        var r = String(v.region || "").toLowerCase();
        var isGlobal = r === "global" || r === "intl" || /国际|global|overseas/i.test(r + " " + (v.id || "") + " " + (v.name || ""));
        if (vendorPickerRegion === "global" && !isGlobal) return false;
        if (vendorPickerRegion === "cn" && isGlobal) return false;
      }
      if (!q) return true;
      return ((v.name || "") + " " + (v.id || "") + " " + vendorAuthBadge(v)).toLowerCase().indexOf(q) >= 0;
    });
    var menu = document.getElementById("addVendorMenu");
    var footCnt = menu && menu.querySelector(".vp-foot-cnt");
    if (footCnt) footCnt.textContent = "匹配 " + matched.length + " / " + vendorsList.length + " 家供应商";
    if (!matched.length) {
      grid.appendChild(el("div", "没有匹配的供应商", "vp-empty"));
      return;
    }
    matched.forEach(function (vendor) {
      var cnt = counts[vendor.id] || 0;
      var item = document.createElement("button");
      item.type = "button";
      item.className = "vp-item";
      item.title = "添加 " + vendor.name + " 账号";
      var top = el("div", null, "vp-item-top");
      var left = el("span", null, "acct-main");
      left.appendChild(el("span", null, "rail-dot " + vendorChipClass(vendor.id, vendor.name)));
      left.appendChild(el("span", vendor.name, "vp-item-name"));
      top.appendChild(left);
      top.appendChild(el("span", cnt + " 个账号", "vp-item-cnt"));
      var meta = el("div", null, "vp-item-meta");
      meta.appendChild(el("span", vendorAuthBadge(vendor), "vp-tag"));
      if (vendor.supports_checkin) meta.appendChild(el("span", "签到", "vp-tag"));
      if (vendor.credential_import) meta.appendChild(el("span", "支持粘贴", "vp-tag"));
      item.appendChild(top);
      item.appendChild(meta);
      item.addEventListener("click", function () {
        closeVendorMenu();
        startVendorAdd(vendor);
      });
      grid.appendChild(item);
    });
  }

  function buildVendorPicker() {
    var menu = document.getElementById("addVendorMenu");
    if (!menu) return;
    menu.textContent = "";
    menu.addEventListener("click", function (ev) { ev.stopPropagation(); });
    var head = el("div", null, "vp-head");
    var searchWrap = el("div", null, "vp-search-wrap");
    searchWrap.appendChild(svgEl(["M9 14.5a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11z", "M13.5 13.5L17 17"]));
    var input = document.createElement("input");
    input.type = "text";
    input.id = "vpSearchInput";
    input.placeholder = "搜索供应商…";
    input.value = vendorPickerQuery;
    input.addEventListener("input", function () {
      vendorPickerQuery = input.value;
      renderVendorPickerGrid();
    });
    searchWrap.appendChild(input);
    head.appendChild(searchWrap);

    var tabs = el("div", null, "vp-tabs");
    [["all", "全部"], ["cn", "国内"], ["global", "国际"]].forEach(function (pair) {
      var btn = el("button", pair[1], vendorPickerRegion === pair[0] ? "active" : "");
      btn.type = "button";
      btn.addEventListener("click", function () {
        vendorPickerRegion = pair[0];
        Array.prototype.forEach.call(tabs.querySelectorAll("button"), function (b) { b.classList.remove("active"); });
        btn.classList.add("active");
        renderVendorPickerGrid();
      });
      tabs.appendChild(btn);
    });
    head.appendChild(tabs);
    menu.appendChild(head);

    var grid = el("div", null, "vp-grid");
    grid.id = "vpGrid";
    menu.appendChild(grid);

    var foot = el("div", null, "vp-foot");
    foot.appendChild(el("span", "", "vp-foot-cnt tnum"));
    foot.appendChild(el("span", "点击卡片发起认证"));
    menu.appendChild(foot);
    renderVendorPickerGrid();
  }

  function loadVendors() {
    return api("GET", "/vendors").then(function (data) {
      if (!data) return [];
      var list = (data && data.vendors) || [];
      vendorsById = {};
      vendorsList = list;
      list.forEach(function (vendor) { vendorsById[vendor.id] = vendor; });
      buildVendorPicker();
      vendorsLoaded = true;
      var sub = document.getElementById("headerSub");
      if (sub && list.length) {
        sub.textContent = list.length + " 家供应商 · 账号、额度、模型与任务管理";
        sub.title = list.map(function (vendor) { return vendor.name || vendor.id; }).join(" / ");
      }
      return list;
    }).catch(function () { return []; });
  }

  function closeVendorMenu() {
    var menu = document.getElementById("addVendorMenu");
    if (menu) menu.hidden = true;
  }

  function toggleVendorMenu() {
    var menu = document.getElementById("addVendorMenu");
    if (!menu) return;
    if (menu.hidden && !vendorsList.length) {
      banner("warn", "没有可用的供应商，请检查插件配置的 enabled_realms。");
      return;
    }
    var willOpen = menu.hidden;
    if (willOpen) {
      closeAllCustomSelects();
      closeModelColumnsMenu();
      closeInfoPopover();
    }
    menu.hidden = !willOpen;
    if (!menu.hidden) {
      renderVendorPickerGrid();
      var input = document.getElementById("vpSearchInput");
      if (input) setTimeout(function () { input.focus(); }, 20);
    }
  }

  function vendorLabel(vendorID, realm) {
    if (vendorID && vendorsById[vendorID]) return vendorsById[vendorID].name;
    if (vendorID) return vendorID;
    return realm === "global" ? "global" : "cn";
  }
