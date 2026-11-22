  // ---- 账号视图 ----
  var lastStatus = null;
  var accountVendorFilter = "";
  var accountStatusFilter = "all";
  var accountSortMode = "default";
  var accountPagerState = { page: 1, pageSize: 20 };
  var lastFilteredAccounts = [];
  var activeDrawerAccountKey = "";

  function maskAccount(value) {
    var text = String(value === undefined || value === null ? "" : value);
    if (text.length <= 8) return text ? "***" : "";
    return text.slice(0, 4) + "***" + text.slice(-4);
  }

  function quotaRemainingText(quota) {
    var metric = (quota.metrics || []).find(function (m) { return m.key === "credit_remain" && m.unit === "墨点"; });
    if (metric && Number.isFinite(Number(metric.value))) {
      return Math.trunc(Number(metric.value)) + " 墨点";
    }
    return quota.remain + " / " + (quota.has_total ? quota.total : "—");
  }

  function quotaCredentialExpired(quota) {
    if (!quota) return false;
    var reason = quota.ok ? (quota.stale ? quota.stale_reason : "") : quota.message;
    return /凭证.*(?:失效|过期|无效)|授权.*(?:失效|过期)|(?:token|session).*expired|unauthorized|\b401\b/i.test(String(reason || ""));
  }
  // accountOriginalName 是账号在上游的原始名称（未设别名时展示的文本）。
  function accountOriginalName(account) {
    var native = account.native_label || "";
    var vendor = vendorsById[account.vendor_id];
    if (vendor && vendor.auth_mode === "apikey") {
      if (vendor.id === "tokenplan" && native && !/^sk-/i.test(native)) return native;
      return maskAccount(native || account.auth_id || "");
    }
    return native || account.auth_id || "";
  }

  function accountDisplay(account) {
    return account.alias || accountOriginalName(account) || "-";
  }

  function accountKey(account) {
    return String(account.auth_id || account.auth_index || account.file_id || "");
  }

  function accountSupportsCheckin(account) {
    if (account.supports_checkin !== undefined) return !!account.supports_checkin;
    var v = vendorsById[account.vendor_id];
    return v ? !!v.supports_checkin : (account.realm !== "global");
  }

  function accountQuotaScore(account) {
    var q = account.quota;
    if (!q || !q.ok) return -1;
    if (q.unlimited) return Number.MAX_SAFE_INTEGER;
    if (q.has_total && q.total > 0) return q.remain / q.total;
    var metric = (q.metrics || []).find(function (m) { return m.key === "credit_remain"; });
    if (metric && Number.isFinite(Number(metric.value))) return Number(metric.value);
    return Number.isFinite(Number(q.remain)) ? Number(q.remain) : -1;
  }

  function accountNeedsAttention(account) {
    if (account.disabled) return false;
    if (account.quota_credential_hint && !account.quota_credential_bound) return true;
    var q = account.quota;
    if (quotaCredentialExpired(q)) return true;
    if (q && (!q.ok || q.stale)) return true;
    if (q && q.ok && !q.unlimited && q.has_total && q.total > 0 && (q.remain / q.total) < 0.2) return true;
    if (account.checkin_pending) return true;
    if (String(account.status || "").toLowerCase() === "error") return true;
    return false;
  }

  function accountNameCell(account) {
    var td = account.file_id ? editableCell({
      saved: account.alias || "",
      fallback: function () { return accountDisplay(account); },
      prefill: function () { return accountOriginalName(account); },
      placeholder: "留空使用上游名称",
      normalize: function (next) { return next === accountOriginalName(account) ? "" : next; },
      title: function (saved) {
        return saved
          ? "点击编辑账号别名（留空或与原名称相同则清除）"
          : "点击设置账号别名（留空或与原名称相同则不设置）";
      },
      save: function (next) {
        return api("POST", "/accounts/alias", { file_id: account.file_id, alias: next }).then(function (data) {
          if (!data || !data.ok) return false;
          account.alias = data.alias || "";
          return { value: account.alias };
        });
      }
    }) : el("td", accountDisplay(account));

    var wrap = el("div", null, "acct-main");
    var hasErr = !account.disabled && (quotaCredentialExpired(account.quota) || (account.quota && !account.quota.ok) || String(account.status || "").toLowerCase() === "error");
    var dot = el("span", null, "status-dot" + (account.disabled ? " off" : (hasErr ? " err" : "")));
    dot.title = account.disabled ? "已停用" : (hasErr ? "账号状态异常或额度查询出错" : "已启用");
    wrap.appendChild(dot);

    var nameBox = el("span", null, "acct-name-wrap");
    while (td.firstChild) nameBox.appendChild(td.firstChild);
    wrap.appendChild(nameBox);

    if (account.disabled) wrap.appendChild(el("span", "停用", "acct-sub-tag"));
    if (account.quota_credential_hint) {
      var qBtn = el("button", account.quota_credential_bound ? "重绑墨点" : "绑定墨点", "act xs" + (account.quota_credential_bound ? " subtle" : " primary"));
      qBtn.type = "button";
      qBtn.title = "更新仅用于查询余额的网页登录凭证";
      qBtn.addEventListener("click", function (ev) {
        ev.stopPropagation();
        openQuotaCredential(account);
      });
      wrap.appendChild(qBtn);
    }
    td.appendChild(wrap);
    td.classList.add("col-acct");
    return td;
  }

  var selectedAccounts = {};

  function selectedAccountIDs() {
    return Object.keys(selectedAccounts);
  }

  function syncAccountSelection() {
    var ids = selectedAccountIDs();
    var count = ids.length;
    var delBtn = document.getElementById("btnDeleteAccounts");
    if (delBtn) {
      delBtn.disabled = count === 0;
      delBtn.classList.toggle("armed", deleteArmed && count > 0);
      if (count === 0) { delBtn.textContent = "删除"; deleteArmed = false; }
      else if (!deleteArmed) delBtn.textContent = "删除 (" + count + ")";
    }
    var bar = document.getElementById("accountBatchBar");
    if (bar) bar.classList.toggle("has-selection", count > 0);
    var filteredSet = {};
    lastFilteredAccounts.forEach(function (a) { filteredSet[accountKey(a)] = true; });
    var outside = ids.filter(function (id) { return !filteredSet[id]; }).length;
    setText("accountBatchInfo", count > 0
      ? ("已选中 " + count + " 个账号")
      : "未选中账号（上方查额、签到和凭证更新作用于全部账号）");
    var warn = document.getElementById("accountBatchWarn");
    if (warn) {
      warn.hidden = outside === 0;
      warn.textContent = outside > 0 ? ("含 " + outside + " 个位于当前筛选外") : "";
    }
    var labelMap = [
      ["btnLoadQuotas", "查询额度"],
      ["btnCheckin", "一键签到"],
      ["btnRefresh", "凭证更新"]
    ];
    labelMap.forEach(function (pair) {
      var btn = document.getElementById(pair[0]);
      if (btn && !btn.disabled) {
        var lbl = btn.querySelector(".btn-label") || btn;
        lbl.textContent = count > 0 ? (pair[1] + " (" + count + ")") : pair[1];
      }
    });
    var headBox = document.getElementById("chkAccountsPage");
    if (headBox) {
      var pageBoxes = document.querySelectorAll("#accounts input[type=checkbox][data-account-id]");
      var checkedInPage = 0;
      Array.prototype.forEach.call(pageBoxes, function (b) { if (b.checked) checkedInPage++; });
      headBox.checked = pageBoxes.length > 0 && checkedInPage === pageBoxes.length;
      headBox.indeterminate = checkedInPage > 0 && checkedInPage < pageBoxes.length;
    }
  }

  function setAllAccountsSelected(selected) {
    Array.prototype.forEach.call(
      document.querySelectorAll("#accounts input[type=checkbox][data-account-id]"),
      function (box) {
        box.checked = selected;
        var key = box.getAttribute("data-account-id");
        if (selected) selectedAccounts[key] = true;
        else delete selectedAccounts[key];
        var tr = box.closest && box.closest("tr");
        if (tr) tr.classList.toggle("is-selected", selected);
      });
    syncAccountSelection();
  }

  function clearAllAccountSelections() {
    selectedAccounts = {};
    setAllAccountsSelected(false);
  }

  function selectFilteredAccounts() {
    lastFilteredAccounts.forEach(function (a) { selectedAccounts[accountKey(a)] = true; });
    Array.prototype.forEach.call(
      document.querySelectorAll("#accounts input[type=checkbox][data-account-id]"),
      function (box) {
        box.checked = true;
        var tr = box.closest && box.closest("tr");
        if (tr) tr.classList.add("is-selected");
      });
    syncAccountSelection();
  }

  function checkinStatusPill(status) {
    if (status === "success") return pill("成功", "ok");
    if (status === "already") return pill("已签到");
    return pill("失败", "err");
  }

  function accountMatchesFilter(account, filter) {
    if (!filter) return true;
    var vendor = vendorLabel(account.vendor_id, account.realm);
    var text = [
      String(account.auth_id || ""),
      String(account.file_id || ""),
      String(account.alias || ""),
      String(account.native_label || ""),
      vendor
    ].join(" ").toLowerCase();
    return text.indexOf(filter) >= 0;
  }

  function setAccountStatusFilter(mode) {
    accountStatusFilter = mode || "all";
    accountPagerState.page = 1;
    Array.prototype.forEach.call(document.querySelectorAll("#accountKpiStrip .kpi-chip"), function (btn) {
      btn.classList.toggle("active", btn.getAttribute("data-kpi") === accountStatusFilter);
    });
    if (lastStatus) renderAccounts(lastStatus);
  }

  function setAccountVendorFilter(vendorID) {
    accountVendorFilter = vendorID || "";
    accountPagerState.page = 1;
    if (lastStatus) renderAccounts(lastStatus);
  }

  function renderAccountVendorRail(accounts) {
    var listHost = document.getElementById("accountRailList");
    if (!listHost) return;
    listHost.textContent = "";

    var byVendor = {};
    accounts.forEach(function (a) {
      var vid = a.vendor_id || "_unknown";
      if (!byVendor[vid]) byVendor[vid] = { id: vid, name: vendorLabel(a.vendor_id, a.realm), count: 0, attention: 0, err: 0 };
      byVendor[vid].count++;
      if (accountNeedsAttention(a)) {
        byVendor[vid].attention++;
        if (quotaCredentialExpired(a.quota) || (a.quota && !a.quota.ok)) byVendor[vid].err++;
      }
    });
    if (accountVendorFilter && !byVendor[accountVendorFilter]) accountVendorFilter = "";

    setText("accountRailTotal", Object.keys(byVendor).length ? (Object.keys(byVendor).length + " 家") : "");

    var allBtn = document.createElement("button");
    allBtn.type = "button";
    allBtn.className = "rail-item" + (!accountVendorFilter ? " active" : "");
    allBtn.appendChild(el("span", null, "rail-dot all"));
    allBtn.appendChild(el("span", "全部供应商", "rail-name"));
    allBtn.appendChild(el("span", String(accounts.length), "rail-count"));
    allBtn.addEventListener("click", function () { setAccountVendorFilter(""); });
    listHost.appendChild(allBtn);

    var groups = Object.keys(byVendor).map(function (k) { return byVendor[k]; });
    groups.sort(function (a, b) {
      if (b.count !== a.count) return b.count - a.count;
      return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0);
    });

    if (groups.length) {
      listHost.appendChild(el("div", null, "rail-sep"));
      groups.forEach(function (g) {
        var btn = document.createElement("button");
        btn.type = "button";
        btn.className = "rail-item" + (accountVendorFilter === g.id ? " active" : "");
        btn.appendChild(el("span", null, "rail-dot " + vendorChipClass(g.id, g.name)));
        btn.appendChild(el("span", g.name, "rail-name"));
        if (g.attention > 0) {
          var alertDot = el("span", null, "rail-alert" + (g.err > 0 ? " err" : ""));
          alertDot.title = g.attention + " 个账号待关注";
          btn.appendChild(alertDot);
        }
        btn.appendChild(el("span", String(g.count), "rail-count"));
        btn.addEventListener("click", function () { setAccountVendorFilter(g.id); });
        listHost.appendChild(btn);
      });
    } else {
      var emptyRail = el("div", null, "rail-empty");
      emptyRail.appendChild(svgEl("M4 7.5h12M4 12.5h8", ""));
      emptyRail.appendChild(el("div", "暂无已接入供应商"));
      emptyRail.appendChild(el("span", "点击「添加账号」后自动归类"));
      listHost.appendChild(emptyRail);
    }

    var foot = document.getElementById("accountRailFoot");
    var addBtn = document.getElementById("btnRailAddVendor");
    var currentVendor = accountVendorFilter && vendorsById[accountVendorFilter];
    if (foot && addBtn) {
      foot.hidden = !currentVendor;
      if (currentVendor) addBtn.textContent = "+ 添加 " + currentVendor.name;
    }
  }

  function renderAccountQuotaCell(account) {
    var td = el("td", null, "col-quota");
    var quota = account.quota;
    var acctName = accountDisplay(account);
    var key = accountKey(account);
    if (account.quota_credential_hint && !account.quota_credential_bound) {
      td.appendChild(makeInteractivePill("未绑定墨点", "warn", {
        tone: "warn",
        title: "未绑定墨点凭证",
        subtitle: acctName,
        detail: "该账号尚未绑定仅用于查询余额的网页登录凭证，绑定后即可实时查看墨点余量。",
        actions: [
          { label: "立即绑定", primary: true, onClick: function () { openQuotaCredential(account); } }
        ]
      }));
      return td;
    }
    if (quotaCredentialExpired(quota)) {
      var expReason = (quota.stale ? quota.stale_reason : quota.message) || "登录凭证或网页授权已失效，请重新授权。";
      var expActions = [];
      if (account.quota_credential_hint) {
        expActions.push({ label: "重绑墨点", primary: true, onClick: function () { openQuotaCredential(account); } });
      }
      expActions.push({ label: "账号详情", onClick: function () { openAccountDrawer(account); } });
      td.appendChild(makeInteractivePill("凭证失效", "err", {
        tone: "err",
        title: "凭证已失效",
        subtitle: acctName,
        detail: expReason,
        meta: quota.fetched_at ? ("检测时刻：" + new Date(quota.fetched_at).toLocaleString()) : "",
        actions: expActions
      }));
      return td;
    }
    if (!quota) {
      td.appendChild(el("span", account.supports_quota ? "查询中…" : "不支持额度", "muted"));
      return td;
    }
    if (!quota.ok) {
      var reason = quota.message || "额度查询失败（上游未返回具体原因）";
      var errActions = [];
      if (account.supports_quota && !account.disabled) {
        errActions.push({ label: "重试查额", primary: true, onClick: function () { loadQuotas(false, [key]); } });
      }
      errActions.push({ label: "账号详情", onClick: function () { openAccountDrawer(account); } });
      td.appendChild(makeInteractivePill("查询失败", "err", {
        tone: "err",
        title: "额度查询失败",
        subtitle: acctName,
        detail: reason,
        meta: quota.fetched_at ? ("查询时刻：" + new Date(quota.fetched_at).toLocaleString()) : "",
        actions: errActions
      }));
      return td;
    }
    if (quota.unlimited) {
      td.appendChild(pill("无限额度", "ok"));
      return td;
    }
    var hasTotal = !!quota.has_total;
    var ratioKnown = hasTotal && quota.total > 0;
    var ratio = ratioKnown ? Math.max(0, Math.min(1, quota.remain / quota.total)) : 0;
    var pct = Math.round(ratio * 100);
    var box = el("div", null, "quota-cell");
    var top = el("div", null, "quota-top");
    var valSpan = el("span", quotaRemainingText(quota), "quota-val tnum");
    top.appendChild(valSpan);
    if (quota.stale) {
      var staleMeta = quota.fetched_at ? ("上次读数：" + new Date(quota.fetched_at).toLocaleString()) : "";
      top.appendChild(makeInteractivePill("非实时", "warn", {
        tone: "warn",
        title: "非实时缓存读数",
        subtitle: acctName,
        detail: quota.stale_reason || "本次刷新失败，当前展示上次成功读取的缓存余额。",
        meta: staleMeta,
        actions: account.supports_quota && !account.disabled
          ? [{ label: "重新查询", primary: true, onClick: function () { loadQuotas(false, [key]); } }]
          : []
      }));
    } else if (ratioKnown) {
      top.appendChild(el("span", pct + "%", "quota-pct tnum"));
    }
    box.appendChild(top);
    if (ratioKnown) {
      var bar = el("span", null, ratio >= 0.5 ? "bar" : (ratio >= 0.2 ? "bar warn" : "bar err"));
      var fill = el("i");
      fill.style.width = pct + "%";
      bar.appendChild(fill);
      box.appendChild(bar);
    } else if (!hasTotal) {
      box.title = "上游只提供可用余额，没有总额 / 已用概念";
    } else {
      box.title = "上游报了总额但它是 0，算不出剩余比例";
    }
    td.appendChild(box);
    return td;
  }

  function renderAccountCheckinCell(account) {
    var claimSpec = claimButtonSpec(account);
    if (claimSpec) {
      var claimCell = el("td", null, "col-checkin");
      var claimBtn = el("button", claimSpec.text, "act xs" + (claimSpec.disabled ? " subtle" : " primary"));
      claimBtn.type = "button";
      claimBtn.disabled = claimSpec.disabled;
      claimBtn.title = claimSpec.title || "";
      claimBtn.addEventListener("click", function () { openClaimModal(account); });
      claimCell.appendChild(claimBtn);
      return claimCell;
    }
    if (!accountSupportsCheckin(account)) return el("td", "—", "col-checkin muted");
    var td = el("td", null, "col-checkin");
    var checkin = account.checkin || {};
    var pendingToday = !!account.checkin_pending;
    var confirmedToday = !!account.checkin_today;
    var rowWrap = el("div", null, "acct-main");
    if (pendingToday) {
      rowWrap.appendChild(makeInteractivePill("待复核", "warn", {
        tone: "warn",
        title: "今日签到待复核",
        subtitle: accountDisplay(account),
        detail: "上游称今日已签到，但北京时间 12 点前上游可能误报，后续定时排程会自动再确认。",
        meta: checkin.last_date ? ("上次确认签到：" + checkin.last_date) : "",
        actions: [{ label: "查看签到历史", onClick: function () { openAccountDrawer(account); } }]
      }));
    } else if (confirmedToday) {
      rowWrap.appendChild(pill("今日已签" + (checkin.streak ? " · " + checkin.streak + "天" : ""), "ok"));
    } else if (checkin.last_date) {
      var d = el("span", checkin.last_date + (checkin.streak ? " · " + checkin.streak + "天" : ""), "muted");
      d.title = "上次签到日期：" + checkin.last_date;
      rowWrap.appendChild(d);
    } else {
      rowWrap.appendChild(el("span", "未签到", "muted"));
    }
    var history = account.checkin_history || [];
    if (history.length) {
      var histBtn = el("button", null, "hist-chip");
      histBtn.type = "button";
      histBtn.title = "查看该账号最近 " + history.length + " 次签到记录与详情";
      histBtn.appendChild(svgEl(["M10 17a7 7 0 1 0 0-14 7 7 0 0 0 0 14z", "M10 6.5V10l2.4 1.4"]));
      histBtn.appendChild(el("span", String(history.length)));
      histBtn.addEventListener("click", function () { openAccountDrawer(account); });
      rowWrap.appendChild(histBtn);
    }
    td.appendChild(rowWrap);
    return td;
  }

  function renderAccountActionCell(account) {
    var td = el("td", null, "col-end");
    var wrap = el("div", null, "row-end");
    var timeSpan = el("span", formatRelativeTime(account.refreshed_at), "row-time tnum");
    if (account.refreshed_at) timeSpan.title = "刷新时间：" + new Date(account.refreshed_at).toLocaleString();
    wrap.appendChild(timeSpan);
    wrap.appendChild(el("span", null, "row-sep"));

    var acts = el("div", null, "row-actions");
    var key = accountKey(account);

    if (account.supports_quota && !account.disabled) {
      var qBtn = el("button", null, "row-act");
      qBtn.type = "button";
      qBtn.title = "单独查询此账号额度";
      qBtn.setAttribute("aria-label", "查询额度");
      qBtn.appendChild(actionIcon("quota"));
      qBtn.addEventListener("click", function () { loadQuotas(false, [key]); });
      acts.appendChild(qBtn);
    } else {
      acts.appendChild(el("span", null, "row-act-slot"));
    }

    if (accountSupportsCheckin(account) && !account.disabled && !claimButtonSpec(account)) {
      var cBtn = el("button", null, "row-act act-ok");
      cBtn.type = "button";
      cBtn.title = "单独为此账号执行签到";
      cBtn.setAttribute("aria-label", "执行签到");
      cBtn.appendChild(actionIcon("checkin"));
      cBtn.addEventListener("click", function () { runCheckin([key], cBtn); });
      acts.appendChild(cBtn);
    } else {
      acts.appendChild(el("span", null, "row-act-slot"));
    }

    var tBtn = el("button", null, "row-act" + (account.disabled ? " act-ok" : " act-warn"));
    tBtn.type = "button";
    tBtn.title = account.disabled ? "启用此账号" : "停用此账号";
    tBtn.setAttribute("aria-label", account.disabled ? "启用账号" : "停用账号");
    tBtn.appendChild(svgEl(account.disabled
      ? ["M7 5l9 5-9 5V5z"]
      : ["M7 5v10", "M13 5v10"]));
    tBtn.addEventListener("click", function () { toggleAccountIDs([key], !account.disabled); });
    acts.appendChild(tBtn);

    var dBtn = el("button", null, "row-act");
    dBtn.type = "button";
    dBtn.title = "打开账号详情与签到历史抽屉";
    dBtn.setAttribute("aria-label", "账号详情");
    dBtn.appendChild(svgEl(["M4 5h12v10H4z", "M11 5v10"]));
    dBtn.addEventListener("click", function () { openAccountDrawer(account); });
    acts.appendChild(dBtn);

    wrap.appendChild(acts);
    td.appendChild(wrap);
    return td;
  }

  function renderAccounts(status) {
    var host = document.getElementById("accounts");
    var pagerHost = document.getElementById("accountPager");
    host.textContent = "";
    if (pagerHost) pagerHost.textContent = "";
    var accounts = (status && status.accounts) || [];

    var present = {};
    accounts.forEach(function (a) { present[accountKey(a)] = true; });
    Object.keys(selectedAccounts).forEach(function (k) { if (!present[k]) delete selectedAccounts[k]; });

    // 更新顶栏版本、Tab 徽标与 KPI 统计
    if (status && status.version) setText("headerVersion", String(status.version));
    setText("tabBadgeAccounts", accounts.length ? String(accounts.length) : "");

    var enabledCount = 0, disabledCount = 0, attentionCount = 0;
    accounts.forEach(function (a) {
      if (a.disabled) disabledCount++; else enabledCount++;
      if (accountNeedsAttention(a)) attentionCount++;
    });
    setText("kpiValAll", String(accounts.length));
    setText("kpiValEnabled", String(enabledCount));
    setText("kpiValDisabled", String(disabledCount));
    setText("kpiValAttention", String(attentionCount));

    renderAccountVendorRail(accounts);

    var filter = (document.getElementById("accountFilter").value || "").trim().toLowerCase();
    var visible = accounts.filter(function (a) {
      if (accountVendorFilter && (a.vendor_id || "_unknown") !== accountVendorFilter) return false;
      if (accountStatusFilter === "enabled" && a.disabled) return false;
      if (accountStatusFilter === "disabled" && !a.disabled) return false;
      if (accountStatusFilter === "attention" && !accountNeedsAttention(a)) return false;
      return accountMatchesFilter(a, filter);
    });

    // 排序
    visible.sort(function (a, b) {
      if (accountSortMode === "quota_desc" || accountSortMode === "quota_asc") {
        var sa = accountQuotaScore(a), sb = accountQuotaScore(b);
        if (sa !== sb) {
          if (sa < 0) return 1;
          if (sb < 0) return -1;
          return accountSortMode === "quota_desc" ? (sb - sa) : (sa - sb);
        }
      } else if (accountSortMode === "refreshed") {
        var ta = Date.parse(a.refreshed_at || "") || 0;
        var tb = Date.parse(b.refreshed_at || "") || 0;
        if (ta !== tb) return tb - ta;
      }
      var statusA = a.disabled ? 1 : 0, statusB = b.disabled ? 1 : 0;
      if (statusA !== statusB) return statusA - statusB;
      var vendorA = vendorLabel(a.vendor_id, a.realm), vendorB = vendorLabel(b.vendor_id, b.realm);
      if (vendorA !== vendorB) return vendorA < vendorB ? -1 : 1;
      var idA = String(a.auth_id || a.label || "").toLowerCase();
      var idB = String(b.auth_id || b.label || "").toLowerCase();
      return idA < idB ? -1 : (idA > idB ? 1 : 0);
    });

    lastFilteredAccounts = visible;

    var wsTitle = accountVendorFilter ? vendorLabel(accountVendorFilter, "") : "全部账号";
    setText("accountWorkspaceTitle", wsTitle);
    var resetBtn = document.getElementById("btnResetAccountScope");
    if (resetBtn) resetBtn.hidden = !accountVendorFilter;

    setText("accountCount", accounts.length
      ? ("(" + (visible.length === accounts.length ? accounts.length : (visible.length + " / " + accounts.length)) + ")")
      : "");
    var hintEl = document.getElementById("accountFilterHint");
    var promptMode = status && status.settings && status.settings.prompt_mode;
    if (hintEl) {
      hintEl.hidden = !promptMode;
      hintEl.textContent = promptMode ? ("提示词 · " + promptMode) : "";
    }

    if (!accounts.length) {
      syncAccountSelection();
      renderEmptyState(host, "还没有添加账号", "点击上方「+ 添加账号」选择任意供应商完成登录或填入 API Key，也可在 CPA 面板的「添加认证」中导入。", "+ 添加账号", function () { toggleVendorMenu(); });
      return;
    }
    if (!visible.length) {
      syncAccountSelection();
      renderEmptyState(host, "当前筛选条件下没有账号", "可以切换左侧供应商、调整状态筛选或清空搜索关键词。", "重置筛选", function () {
        document.getElementById("accountFilter").value = "";
        accountVendorFilter = "";
        setAccountStatusFilter("all");
      });
      return;
    }

    var pageSlice = renderPager("accountPager", accountPagerState, visible.length, [20, 50, 0], function () {
      if (lastStatus) renderAccounts(lastStatus);
    });
    var pageItems = visible.slice(pageSlice.start, pageSlice.end);
    var showVendorCol = !accountVendorFilter;

    var wrap = el("div", null, "table-wrap");
    var table = el("table");
    var head = el("tr");

    var thCheck = el("th", null, "col-check");
    var headChk = document.createElement("input");
    headChk.type = "checkbox";
    headChk.id = "chkAccountsPage";
    headChk.title = "全选 / 取消本页账号";
    headChk.addEventListener("change", function () { setAllAccountsSelected(headChk.checked); });
    thCheck.appendChild(headChk);
    head.appendChild(thCheck);
    head.appendChild(el("th", "账号", "col-acct"));
    if (showVendorCol) head.appendChild(el("th", "供应商", "col-vendor"));
    head.appendChild(el("th", "额度与余量", "col-quota"));
    head.appendChild(el("th", "签到 / 套餐", "col-checkin"));
    head.appendChild(el("th", "刷新与操作", "col-end"));
    table.appendChild(head);

    pageItems.forEach(function (account) {
      var key = accountKey(account);
      var row = el("tr");
      if (selectedAccounts[key]) row.classList.add("is-selected");
      if (account.disabled) row.classList.add("is-disabled");

      var chkTd = el("td", null, "col-check");
      var checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = !!selectedAccounts[key];
      checkbox.setAttribute("data-account-id", key);
      checkbox.addEventListener("change", function () {
        if (checkbox.checked) selectedAccounts[key] = true;
        else delete selectedAccounts[key];
        row.classList.toggle("is-selected", checkbox.checked);
        syncAccountSelection();
      });
      chkTd.appendChild(checkbox);
      row.appendChild(chkTd);

      row.appendChild(accountNameCell(account));
      if (showVendorCol) {
        var vendor = vendorLabel(account.vendor_id, account.realm);
        var vBtn = pill(vendor, vendorChipClass(account.vendor_id, vendor));
        vBtn.style.cursor = "pointer";
        vBtn.title = "点击仅查看「" + vendor + "」的账号";
        vBtn.addEventListener("click", function () { setAccountVendorFilter(account.vendor_id); });
        var vTd = cellWith(vBtn);
        vTd.className = "col-vendor";
        row.appendChild(vTd);
      }
      row.appendChild(renderAccountQuotaCell(account));
      row.appendChild(renderAccountCheckinCell(account));
      row.appendChild(renderAccountActionCell(account));
      table.appendChild(row);
    });

    wrap.appendChild(table);
    host.appendChild(wrap);
    bindTableScrollShadows(wrap);
    syncAccountSelection();

    // 若右侧详情抽屉正打开着，刷新后同步更新其内容
    if (activeDrawerAccountKey) {
      var fresh = accounts.find(function (a) { return accountKey(a) === activeDrawerAccountKey; });
      if (fresh) renderAccountDrawerBody(fresh);
      else closeAccountDrawer();
    }
  }

  // ---- 右侧滑出账号详情与签到历史抽屉 ----
  function closeAccountDrawer() {
    activeDrawerAccountKey = "";
    var drawer = document.getElementById("accountDrawer");
    if (drawer) drawer.hidden = true;
  }

  function openAccountDrawer(account) {
    if (!account) return;
    activeDrawerAccountKey = accountKey(account);
    renderAccountDrawerBody(account);
    var drawer = document.getElementById("accountDrawer");
    if (drawer) drawer.hidden = false;
  }

  function renderAccountDrawerBody(account) {
    var key = accountKey(account);
    var vendor = vendorLabel(account.vendor_id, account.realm);
    setText("drawerTitle", accountDisplay(account));
    var sub = document.getElementById("drawerSub");
    if (sub) {
      sub.textContent = "";
      sub.appendChild(pill(vendor, vendorChipClass(account.vendor_id, vendor)));
      sub.appendChild(account.disabled ? pill("已停用", "err") : pill("已启用", "ok"));
      if (account.checkin_pending) sub.appendChild(pill("待复核", "warn"));
    }

    var body = document.getElementById("drawerBody");
    if (!body) return;
    body.textContent = "";

    // 单账号快捷操作区
    var actSec = el("div", null, "drawer-section");
    actSec.appendChild(el("h3", "快捷操作"));
    var actRow = el("div", null, "drawer-actions");
    if (account.supports_quota && !account.disabled) {
      var bQ = el("button", "查询额度", "act xs primary");
      bQ.type = "button";
      bQ.prepend(actionIcon("quota"));
      bQ.addEventListener("click", function () { loadQuotas(false, [key]); });
      actRow.appendChild(bQ);
    }
    var claimSpec = claimButtonSpec(account);
    if (claimSpec) {
      var bClaim = el("button", claimSpec.text, "act xs" + (claimSpec.disabled ? "" : " primary"));
      bClaim.type = "button";
      bClaim.disabled = claimSpec.disabled;
      bClaim.addEventListener("click", function () { closeAccountDrawer(); openClaimModal(account); });
      actRow.appendChild(bClaim);
    } else if (accountSupportsCheckin(account) && !account.disabled) {
      var bC = el("button", "立即签到", "act xs");
      bC.type = "button";
      bC.prepend(actionIcon("checkin"));
      bC.addEventListener("click", function () { runCheckin([key], bC); });
      actRow.appendChild(bC);
    }
    var bKeep = el("button", "凭证更新", "act xs");
    bKeep.type = "button";
    bKeep.prepend(actionIcon("credential"));
    bKeep.addEventListener("click", function () { keepaliveAccounts([key], bKeep); });
    actRow.appendChild(bKeep);

    var bToggle = el("button", account.disabled ? "启用账号" : "停用账号", "act xs");
    bToggle.type = "button";
    bToggle.addEventListener("click", function () { toggleAccountIDs([key], !account.disabled); });
    actRow.appendChild(bToggle);

    if (account.quota_credential_hint) {
      var bBind = el("button", account.quota_credential_bound ? "重绑墨点" : "绑定墨点", "act xs");
      bBind.type = "button";
      bBind.addEventListener("click", function () { closeAccountDrawer(); openQuotaCredential(account); });
      actRow.appendChild(bBind);
    }
    actSec.appendChild(actRow);
    body.appendChild(actSec);

    // 基本信息
    var infoSec = el("div", null, "drawer-section");
    infoSec.appendChild(el("h3", "账号标识"));
    var kv = el("dl", null, "drawer-kv");
    [
      ["上游原名", accountOriginalName(account) || "—"],
      ["当前别名", account.alias || "未设置"],
      ["账号 ID", account.auth_id || account.auth_index || "—"],
      ["凭证文件", account.file_id || "—"],
      ["刷新时间", account.refreshed_at ? new Date(account.refreshed_at).toLocaleString() : "—"]
    ].forEach(function (pair) {
      kv.appendChild(el("dt", pair[0]));
      var dd = el("dd", pair[1], (pair[0] === "账号 ID" || pair[0] === "凭证文件") ? "mono" : "");
      kv.appendChild(dd);
    });
    infoSec.appendChild(kv);
    body.appendChild(infoSec);

    // 额度明细（完整展示原因与各子指标）
    var qSec = el("div", null, "drawer-section");
    qSec.appendChild(el("h3", "额度明细"));
    var q = account.quota;
    if (account.quota_credential_hint && !account.quota_credential_bound) {
      qSec.appendChild(el("div", "尚未绑定墨点网页凭证，绑定后即可在此查看墨点余额。", "muted"));
    } else if (!q) {
      qSec.appendChild(el("div", account.supports_quota ? "暂无额度缓存，可点击上方「查询额度」刷新。" : "该供应商暂不提供额度查询接口。", "muted"));
    } else {
      var qInfo = el("dl", null, "drawer-kv");
      qInfo.appendChild(el("dt", "状态"));
      var statusCell = el("dd");
      if (quotaCredentialExpired(q)) statusCell.appendChild(pill("凭证失效", "err"));
      else if (!q.ok) statusCell.appendChild(pill("查询失败", "err"));
      else if (q.stale) statusCell.appendChild(pill("非实时缓存", "warn"));
      else if (q.unlimited) statusCell.appendChild(pill("无限额度", "ok"));
      else statusCell.appendChild(pill("正常", "ok"));
      qInfo.appendChild(statusCell);

      if (q.ok && !q.unlimited) {
        qInfo.appendChild(el("dt", "余量"));
        var ratioStr = (q.has_total && q.total > 0) ? (" (" + Math.round((q.remain / q.total) * 100) + "%)") : "";
        qInfo.appendChild(el("dd", quotaRemainingText(q) + ratioStr, "tnum"));
      }
      if (q.fetched_at) {
        qInfo.appendChild(el("dt", "查询时刻"));
        qInfo.appendChild(el("dd", new Date(q.fetched_at).toLocaleString(), "tnum"));
      }
      if (!q.ok && q.message) {
        qInfo.appendChild(el("dt", "失败原因"));
        qInfo.appendChild(el("dd", q.message));
      }
      if (q.stale && q.stale_reason) {
        qInfo.appendChild(el("dt", "缓存说明"));
        qInfo.appendChild(el("dd", q.stale_reason));
      }
      qSec.appendChild(qInfo);

      var metrics = q.metrics || [];
      if (metrics.length) {
        var mList = el("div", null, "timeline");
        mList.style.marginTop = "10px";
        metrics.forEach(function (m) {
          var item = el("div", null, "tl-item");
          var top = el("div", null, "tl-top");
          top.appendChild(el("span", m.label || m.key, "muted"));
          top.appendChild(el("span", String(m.value !== undefined ? m.value : "") + (m.unit ? " " + m.unit : ""), "mono"));
          item.appendChild(top);
          mList.appendChild(item);
        });
        qSec.appendChild(mList);
      }
    }
    body.appendChild(qSec);

    // 签到历史时间线
    var history = account.checkin_history || [];
    var hSec = el("div", null, "drawer-section");
    hSec.appendChild(el("h3", "签到历史 (" + history.length + ")"));
    if (!history.length) {
      hSec.appendChild(el("div", "暂无签到记录。", "muted"));
    } else {
      var tl = el("div", null, "timeline");
      history.forEach(function (entry) {
        var item = el("div", null, "tl-item");
        var top = el("div", null, "tl-top");
        top.appendChild(checkinStatusPill(entry.status));
        top.appendChild(el("span", entry.trigger === "schedule" ? "定时" : "手动", "acct-sub-tag"));
        if (entry.credit) top.appendChild(pill("+" + entry.credit, "ok"));
        top.appendChild(el("span", entry.run_at ? new Date(entry.run_at).toLocaleString() : "-", "muted tnum"));
        item.appendChild(top);
        if (entry.message) item.appendChild(el("div", entry.message, "tl-msg"));
        tl.appendChild(item);
      });
      hSec.appendChild(tl);
    }
    body.appendChild(hSec);
  }

  // ---- 状态加载、设置回填与账号批量操作 ----
  var settingsDirty = false;
  var settingsLoaded = false;
  var settingsRevision = 0;
  var statusRequestID = 0;
  function setSettingsDirty(dirty) {
    settingsDirty = !!dirty;
    if (dirty) settingsRevision++;
    var badge = document.getElementById("unsavedBadge");
    if (badge) badge.hidden = !settingsDirty;
  }

  function renderRuntimeSettings(settings) {
    document.getElementById("setAutoCheckin").checked = !!settings.auto_checkin;
    document.getElementById("setCheckinAt").value = settings.auto_checkin_at || "10:00";
    document.getElementById("setAutoTasks").checked = !!settings.auto_tasks;
    var promptSel = document.getElementById("setPromptMode");
    if (promptSel) { promptSel.value = settings.prompt_mode || "passthrough"; syncCustomSelect(promptSel); }
    var tagSel = document.getElementById("setModelNameTag");
    if (tagSel) { tagSel.value = settings.model_name_tag || "off"; syncCustomSelect(tagSel); }
    renderTaskSchedules(settings);
  }

  function loadStatus(skipClearBanner) {
    if (!skipClearBanner) clearBanner();
    var requestID = ++statusRequestID;
    return api("GET", "/status").then(function (status) {
      if (!status || requestID !== statusRequestID) return;
      lastStatus = status;
      renderAccounts(status);
      renderVendorPickerGrid();
      if (typeof renderTaskCenter === "function") renderTaskCenter();
      var settings = status.settings || {};
      if (!settingsDirty) renderRuntimeSettings(settings);
      if (!settingsLoaded && status.settings) {
        settingsLoaded = true;
        document.getElementById("btnSaveSettings").disabled = false;
      }
      var scheduler = status.scheduler || {};
      var labels = {};
      (settings.task_specs || []).forEach(function (spec) { labels[spec.kind] = spec.label || spec.kind; });
      var nextTasks = (scheduler.next_tasks || []).map(function (kind) { return labels[kind] || kind; });
      setText("scheduleInfo",
        "下次自动执行：" + (scheduler.next_hhmm || scheduler.next_at || "-") +
        " · 任务：" + (nextTasks.join("、") || "无"));
      if (status.restart_pending && !modelSyncSelfHealed) {
        modelSyncSelfHealed = true;
        syncModelConfig();
      }
    }).catch(function (err) {
      if (requestID === statusRequestID) banner("err", err.message);
      throw err;
    });
  }

  function renderTaskSchedules(settings) {
    var host = document.getElementById("taskSchedule");
    if (!host) return;
    host.textContent = "";
    var specs = settings.task_specs || [];
    var schedule = settings.task_schedule_overrides || settings.schedule || {};
    if (!specs.length) {
      host.appendChild(el("div", "当前没有可自定义排程的任务类型。", "hint"));
      return;
    }
    host.appendChild(el("div", "填写逗号分隔的整点小时（0–23），留空则使用括号中的默认值。", "hint"));
    var grid = el("div", null, "schedule-grid");
    specs.forEach(function (spec) {
      var item = el("div", null, "schedule-item");
      var defStr = (spec.default_hours || []).join(",");
      var label = el("label", (spec.label || spec.kind) + (defStr ? "（默认 " + defStr + "）" : ""));
      var input = document.createElement("input");
      input.type = "text";
      input.className = "mono";
      input.dataset.taskKind = spec.kind;
      input.placeholder = defStr || "例如 10,18";
      input.value = (schedule[spec.kind] || []).join(",");
      input.addEventListener("input", function () { setSettingsDirty(true); });
      item.appendChild(label);
      item.appendChild(input);
      grid.appendChild(item);
    });
    host.appendChild(grid);
  }

  var deleteArmed = false;

  function deleteSelectedAccounts(btn) {
    var ids = selectedAccountIDs();
    if (!ids.length) return;
    if (!deleteArmed) {
      deleteArmed = true;
      banner("warn", "再次点击「确认删除」以永久删除选中的 " + ids.length + " 个账号（不可恢复）");
      btn.textContent = "确认删除 (" + ids.length + ")";
      btn.classList.add("armed");
      setTimeout(function () {
        deleteArmed = false;
        syncAccountSelection();
      }, 5000);
      return;
    }
    deleteArmed = false;
    btn.classList.remove("armed");
    btn.disabled = true;
    api("POST", "/accounts/delete", { account_ids: ids })
      .then(function (data) {
        if (!data) return;
        if (!data.ok) throw new Error(data.error || "删除请求失败");
        var results = data.results || [];
        var failed = results.filter(function (r) { return !r.ok; });
        banner(failed.length ? "warn" : "ok",
          failed.length
            ? "已删除 " + (results.length - failed.length) + " 个账号，" + failed.length + " 个失败：" + failed[0].message
            : (data.error || ("已删除 " + (data.deleted || ids.length) + " 个账号")), 8000);
        results.forEach(function (r) { if (r.ok) delete selectedAccounts[r.auth_id]; });
        loadStatus(true).catch(function () { });
      })
      .catch(function (err) { banner("err", err.message); })
      .then(function () { syncAccountSelection(); });
  }

  function toggleAccountIDs(ids, disabled) {
    if (!ids || !ids.length) { banner("err", "请先勾选账号"); return; }
    var verb = disabled ? "停用" : "启用";
    api("POST", "/accounts/enabled", { account_ids: ids, enabled: !disabled }).then(function (data) {
      if (!data) return;
      if (!data.ok) throw new Error(data.error || (verb + "请求失败"));
      var failed = (data.results || []).filter(function (r) { return !r.ok; });
      banner(failed.length ? "warn" : "ok",
        failed.length ? verb + "失败：" + failed[0].message : "已" + verb + " " + (data.changed || 0) + " 个账号", 6000);
      loadStatus(true).catch(function () { });
    }).catch(function (err) { banner("err", err.message); });
  }

  function toggleSelectedAccounts(disabled) {
    toggleAccountIDs(selectedAccountIDs(), disabled);
  }

  function keepaliveAccounts(ids, btn) {
    if (btn) btn.disabled = true;
    banner("ok", "正在更新" + (ids.length ? " " + ids.length + " 个账号" : "全部账号") + "的凭证，请稍候…", 0);
    api("POST", "/keepalive", { account_ids: ids }).then(function (res) {
      if (!res) return;
      if (res.failed > 0 && res.succeeded === 0) {
        banner("err", res.message || "凭证更新失败");
      } else if (res.failed > 0) {
        banner("warn", res.message || ("凭证更新部分成功，" + res.succeeded + " 个成功，" + res.failed + " 个失败"));
      } else {
        banner("ok", res.message || "凭证更新成功");
      }
      return loadStatus(true);
    }).catch(function (err) {
      banner("err", "凭证更新请求失败（" + err.message + "）");
    }).then(function () {
      if (btn) btn.disabled = false;
      syncAccountSelection();
    });
  }

  function loadQuotas(quiet, targets) {
    if (!quiet) banner("ok", "正在查询账号额度…", 0);
    return api("POST", "/quotas", { account_ids: targets || [] }).then(function (data) {
      if (!data) return;
      var results = (data && data.results) || [];
      var failures = results.filter(function (r) { return !r.ok || r.stale; });
      if (!quiet) {
        if (!failures.length) {
          banner("ok", "额度查询完成：" + results.length + " 个账号", 5000);
        } else {
          var detail = failures.slice(0, 5).map(function (r) {
            var who = r.label || r.name || r.auth_id || "未知账号";
            var vendor = r.vendor_name || r.vendor_id || "未知供应商";
            return vendor + " / " + who + "：" + (r.stale ? "沿用上次读数，" + r.stale_reason : (r.message || "未知错误"));
          });
          if (failures.length > detail.length) detail.push("…等 " + failures.length + " 个账号失败");
          banner("warn", "额度查询完成：" + results.length + " 个账号，" +
            failures.length + " 个失败\n" + detail.join("\n"), 12000);
        }
      }
      return loadStatus(true);
    }).catch(function (err) {
      if (!quiet) banner("err", err.message, 8000);
      throw err;
    });
  }

  // ---- 套餐领取弹窗 ----
  var claimContext = null;

  function claimButtonSpec(account) {
    if (!account.supports_claim) return null;
    var claim = account.claim || {};
    if (claim.error) return { text: "套餐领取", disabled: false, title: claim.error };
    if (!claim.checked_at || claim.claimable > 0) {
      return { text: "套餐领取", disabled: false, title: claim.claimable ? (claim.claimable + " 个套餐可领") : (claim.note || "点击查询可领套餐") };
    }
    return { text: "已领取", disabled: true, title: claim.note || "已领取当前全部套餐" };
  }

  function openClaimModal(account) {
    var modal = document.getElementById("claimModal");
    var plans = document.getElementById("claimPlans");
    var captchaBox = document.getElementById("claimCaptcha");
    var hint = document.getElementById("claimHint");
    var pasteBox = document.getElementById("claimPasteBox");
    document.getElementById("claimTitle").textContent = "套餐领取 · " + accountDisplay(account);
    plans.textContent = "正在查询可领套餐…";
    captchaBox.textContent = "";
    hint.textContent = "";
    pasteBox.hidden = true;
    document.getElementById("claimVerifyParam").value = "";
    document.getElementById("btnClaimConfirm").disabled = true;
    modal.removeAttribute("hidden");
    modal.hidden = false;
    modal.style.display = "flex";

    claimContext = { account: account, planId: "", verifyParam: "", captcha: null };
    api("POST", "/plans/preview", { account_id: account.auth_id || account.auth_index })
      .then(function (data) {
        if (!claimContext || claimContext.account !== account) return;
        if (!data) return;
        if (!data.ok) { plans.textContent = data.message || "查询失败"; return; }
        if (!data.plans || !data.plans.length) {
          plans.textContent = "已领取当前全部套餐，暂无新的可领活动。";
          return;
        }
        renderClaimPlans(data.plans);
        if (data.captcha) setupClaimCaptcha(data.captcha);
        else document.getElementById("btnClaimConfirm").disabled = false;
      })
      .catch(function (err) {
        if (!claimContext || claimContext.account !== account) return;
        plans.textContent = err.message || "查询套餐失败";
      });
  }

  function closeClaimModal() {
    var modal = document.getElementById("claimModal");
    if (!modal) return;
    modal.setAttribute("hidden", "");
    modal.hidden = true;
    modal.style.display = "none";
    document.getElementById("claimCaptcha").textContent = "";
    claimContext = null;
  }

  function renderClaimPlans(plans) {
    var host = document.getElementById("claimPlans");
    host.textContent = "";
    plans.forEach(function (plan, index) {
      var card = el("div", null, "plan" + (index === 0 ? " selected" : ""));
      card.appendChild(el("div", plan.name || plan.plan_id, "plan-title"));
      if (plan.description) card.appendChild(el("div", plan.description, "muted"));
      if (plan.grants && plan.grants.length) {
        card.appendChild(el("div", plan.grants.map(function (g) {
          return g.model + " " + formatGrantUnits(g.units) + (g.period ? "（" + g.period + "）" : "");
        }).join(" · "), "plan-grants"));
      }
      card.addEventListener("click", function () {
        Array.prototype.forEach.call(host.querySelectorAll(".plan"), function (p) { p.classList.remove("selected"); });
        card.classList.add("selected");
        claimContext.planId = plan.plan_id;
      });
      host.appendChild(card);
      if (index === 0) claimContext.planId = plan.plan_id;
    });
  }

  function formatGrantUnits(units) {
    if (!units || units <= 0) return "0";
    if (units >= 1e8) return trimZero((units / 1e8).toFixed(2)) + "亿 tokens";
    if (units >= 1e4) return trimZero((units / 1e4).toFixed(1)) + "万 tokens";
    return Math.round(units) + " tokens";
  }

  function trimZero(text) {
    return text.indexOf(".") >= 0 ? text.replace(/0+$/, "").replace(/\.$/, "") : text;
  }

  function setupClaimCaptcha(config) {
    var hint = document.getElementById("claimHint");
    if (!config.scene_id) { hint.textContent = "上游未下发人机验证参数，无法在页面内完成领取"; return; }
    loadAliyunSdk().then(function () {
      window.AliyunCaptchaConfig = { region: config.region, prefix: config.prefix };
      window.initAliyunCaptcha({
        SceneId: config.scene_id,
        mode: "popup",
        language: "zh-CN",
        showErrorTip: false,
        element: "#claimCaptcha",
        button: "#claimCaptchaBtn",
        getInstance: function (inst) {
          try { if (inst.startTracelessVerification) inst.startTracelessVerification(); } catch (e) { /* 忽略 */ }
        },
        success: function (param) {
          if (!claimContext) return;
          claimContext.verifyParam = (typeof param === "string" ? param : (param && param.captchaVerifyParam) || "");
          claimContext.captcha = config;
          hint.textContent = "✓ 人机验证已通过，请点击确认领取。";
          document.getElementById("btnClaimConfirm").disabled = false;
        },
        fail: function () { hint.textContent = "未通过无感验证，请按提示完成滑块。"; },
        onError: function () { hint.textContent = "人机验证出错，请重试。"; }
      });
      hint.textContent = "请完成人机验证（多数情况下无感通过）。";
    }).catch(function (err) {
      hint.textContent = err.message + "，可展开下方粘贴验证码参数。";
      document.getElementById("claimPasteBox").hidden = false;
    });
  }

  var aliyunSdkPromise = null;
  function loadAliyunSdk() {
    if (typeof window.initAliyunCaptcha === "function") return Promise.resolve();
    if (aliyunSdkPromise) return aliyunSdkPromise;
    aliyunSdkPromise = new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = "https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js";
      s.onload = function () {
        if (typeof window.initAliyunCaptcha === "function") { resolve(); return; }
        aliyunSdkPromise = null;
        reject(new Error("验证码组件加载异常，请重试"));
      };
      s.onerror = function () {
        aliyunSdkPromise = null;
        reject(new Error("验证码脚本加载失败"));
      };
      document.head.appendChild(s);
    });
    return aliyunSdkPromise;
  }

  function submitClaim() {
    if (!claimContext) return;
    var pasted = (document.getElementById("claimVerifyParam").value || "").trim();
    var param = claimContext.verifyParam || pasted;
    if (!param) { banner("warn", "请先完成人机验证"); return; }
    var btn = document.getElementById("btnClaimConfirm");
    btn.disabled = true;
    btn.textContent = "领取中…";
    api("POST", "/plans/claim", {
      account_id: claimContext.account.auth_id || claimContext.account.auth_index,
      plan_id: claimContext.planId,
      verify_param: param,
      verify_region: (claimContext.captcha && claimContext.captcha.region) || ""
    }).then(function (data) {
      btn.textContent = "确认领取";
      btn.disabled = false;
      if (!data) return;
      banner(data.ok ? "ok" : "err", data.message || (data.ok ? "领取成功" : "领取失败"));
      if (!data.ok) return;
      closeClaimModal();
      loadStatus(true).catch(function () { });
    }).catch(function (err) {
      btn.textContent = "确认领取";
      btn.disabled = false;
      banner("err", err.message);
    });
  }
