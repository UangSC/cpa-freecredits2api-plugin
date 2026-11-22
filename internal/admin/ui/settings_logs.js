  document.getElementById("btnClaimCancel").addEventListener("click", closeClaimModal);
  document.getElementById("btnClaimConfirm").addEventListener("click", submitClaim);
  document.getElementById("claimModal").addEventListener("click", function (event) {
    if (event.target === this) closeClaimModal();
  });
  document.getElementById("claimVerifyParam").addEventListener("input", function () {
    if (this.value.trim()) document.getElementById("btnClaimConfirm").disabled = false;
  });

  // 账号详情抽屉事件
  document.getElementById("btnCloseDrawer").addEventListener("click", closeAccountDrawer);
  document.getElementById("accountDrawer").addEventListener("click", function (event) {
    if (event.target === this) closeAccountDrawer();
  });

  // 账号操作与筛选控件绑定
  document.getElementById("btnRefresh").addEventListener("click", function () {
    keepaliveAccounts(selectedAccountIDs(), this);
  });
  document.getElementById("btnLoadQuotas").addEventListener("click", function () {
    loadQuotas(false, selectedAccountIDs()).catch(function () { });
  });
  document.getElementById("btnDisableAccounts").addEventListener("click", function () { toggleSelectedAccounts(true); });
  document.getElementById("btnEnableAccounts").addEventListener("click", function () { toggleSelectedAccounts(false); });
  document.getElementById("btnSelectAllAccounts").addEventListener("click", function () { setAllAccountsSelected(true); });
  document.getElementById("btnSelectFilteredAccounts").addEventListener("click", selectFilteredAccounts);
  document.getElementById("btnSelectNoneAccounts").addEventListener("click", clearAllAccountSelections);
  document.getElementById("btnDeleteAccounts").addEventListener("click", function () { deleteSelectedAccounts(this); });
  document.getElementById("btnResetAccountScope").addEventListener("click", function () { setAccountVendorFilter(""); });
  document.getElementById("btnRailAddVendor").addEventListener("click", function () {
    if (accountVendorFilter && vendorsById[accountVendorFilter]) startVendorAdd(vendorsById[accountVendorFilter]);
  });

  Array.prototype.forEach.call(document.querySelectorAll("#accountKpiStrip .kpi-chip"), function (btn) {
    btn.addEventListener("click", function () { setAccountStatusFilter(btn.getAttribute("data-kpi")); });
  });
  document.getElementById("accountSort").addEventListener("change", function () {
    accountSortMode = this.value || "default";
    accountPagerState.page = 1;
    if (lastStatus) renderAccounts(lastStatus);
  });
  document.getElementById("accountFilter").addEventListener("input", function () {
    accountPagerState.page = 1;
    if (lastStatus) renderAccounts(lastStatus);
  });
  document.getElementById("btnClearAccountFilter").addEventListener("click", function () {
    var input = document.getElementById("accountFilter");
    input.value = "";
    accountPagerState.page = 1;
    if (lastStatus) renderAccounts(lastStatus);
    input.focus();
  });

  // 模型工具栏与列展示绑定
  document.getElementById("btnLoadModels").addEventListener("click", function () { refreshModels(false); });
  document.getElementById("btnModelViewVendor").addEventListener("click", function () { setModelViewMode("vendor"); });
  document.getElementById("btnModelViewAgg").addEventListener("click", function () { setModelViewMode("aggregate"); });
  document.getElementById("btnResetModelScope").addEventListener("click", function () {
    modelVendorFilter = "";
    modelPagerState.page = 1;
    renderModels();
  });
  Array.prototype.forEach.call(document.querySelectorAll("#modelKpiStrip .kpi-chip"), function (btn) {
    btn.addEventListener("click", function () { setModelQuickFilter(btn.getAttribute("data-mkpi")); });
  });

  function buildModelColumnsMenu() {
    var menu = document.getElementById("modelColsMenu");
    if (!menu) return;
    menu.textContent = "";
    var head = el("div", null, "col-menu-head");
    head.appendChild(el("span", "展示表格列"));
    head.appendChild(el("span", "自动保存"));
    menu.appendChild(head);
    MODEL_COLUMNS.filter(function (col) { return !!col.header; }).forEach(function (col) {
      var label = el("label", null, "col-menu-row" + (col.optional ? "" : " disabled"));
      label.appendChild(el("span", col.header));
      if (col.optional) {
        var box = document.createElement("input");
        box.type = "checkbox";
        box.className = "switch sm";
        box.checked = columnVisible(col);
        box.addEventListener("change", function () { toggleOptionalColumn(col.key, box.checked); });
        label.appendChild(box);
      } else {
        label.title = "必显列，不可隐藏";
        label.appendChild(el("span", "必显", "col-req-tag"));
      }
      menu.appendChild(label);
    });
    menu.addEventListener("click", function (event) { event.stopPropagation(); });
  }

  function closeModelColumnsMenu() {
    var menu = document.getElementById("modelColsMenu");
    var btn = document.getElementById("btnModelCols");
    if (menu) menu.hidden = true;
    if (btn) btn.setAttribute("aria-expanded", "false");
  }

  function toggleModelColumnsMenu() {
    var menu = document.getElementById("modelColsMenu");
    var btn = document.getElementById("btnModelCols");
    if (!menu) return;
    var willOpen = menu.hidden;
    if (willOpen) {
      closeAllCustomSelects();
      closeVendorMenu();
      closeInfoPopover();
    }
    menu.hidden = !willOpen;
    if (btn) btn.setAttribute("aria-expanded", menu.hidden ? "false" : "true");
  }

  buildModelColumnsMenu();
  document.getElementById("btnModelCols").addEventListener("click", function (event) {
    event.stopPropagation();
    toggleModelColumnsMenu();
  });
  document.addEventListener("click", function () {
    closeModelColumnsMenu();
    closeAllCustomSelects();
    closeInfoPopover();
  });

  document.getElementById("modelFilter").addEventListener("input", function () {
    modelPagerState.page = 1;
    renderModels();
  });
  document.getElementById("btnClearModelFilter").addEventListener("click", function () {
    var input = document.getElementById("modelFilter");
    input.value = "";
    modelPagerState.page = 1;
    renderModels();
    input.focus();
  });
  document.getElementById("btnDisableModels").addEventListener("click", function () { toggleModels(true); });
  document.getElementById("btnEnableModels").addEventListener("click", function () { toggleModels(false); });
  document.getElementById("btnSelectAllModels").addEventListener("click", function () {
    Array.prototype.forEach.call(document.querySelectorAll("#models input[type=checkbox][data-model-id]"), function (box) {
      box.checked = true;
      selectedModels[box.getAttribute("data-model-id")] = true;
      var tr = box.closest && box.closest("tr");
      if (tr) tr.classList.add("is-selected");
    });
    syncModelSelection();
  });
  document.getElementById("btnSelectNoneModels").addEventListener("click", function () {
    selectedModels = {};
    Array.prototype.forEach.call(document.querySelectorAll("#models input[type=checkbox][data-model-id]"), function (box) {
      box.checked = false;
      var tr = box.closest && box.closest("tr");
      if (tr) tr.classList.remove("is-selected");
    });
    syncModelSelection();
  });

  // 签到（账号页）与任务中心操作绑定
  function runCheckin(accountIDs, btn) {
    if (btn) btn.disabled = true;
    banner("ok", "签到 / 福利领取已在后台开始，请稍候…", 0);
    return api("POST", "/checkin", { account_ids: accountIDs }).then(function (result) {
      if (!result) return;
      var results = (result && result.results) || [];
      if (!results.length) { banner("ok", "当前没有需要签到的账号", 5000); return; }
      var doneCount = results.filter(function (r) { return r.ok && !r.skipped; }).length;
      var skippedCount = results.filter(function (r) { return r.ok && r.skipped; }).length;
      var failedCount = results.filter(function (r) { return !r.ok; }).length;
      var total = results.length;
      var detailed = results.filter(function (r) { return total === 1 || !r.ok || r.skipped; });
      var details = detailed.slice(0, 3).map(function (r) {
        return (r.label || r.auth_id) + "：" + (r.message || (r.ok ? "已完成" : "失败"));
      });
      if (detailed.length > 3) details.push("另 " + (detailed.length - 3) + " 条结果请查看签到历史");
      banner(doneCount === total ? "ok" : "warn", "签到 / 福利领取完成：" + doneCount + " / " + total + " 成功" +
        (skippedCount ? "，" + skippedCount + " 个未完成" : "") +
        (failedCount ? "，" + failedCount + " 个失败" : "") + (details.length ? "；" + details.join("；") : ""), 12000);
      return loadQuotas(true, accountIDs).catch(function () { });
    }).catch(function (err) {
      banner("err", "签到失败：" + err.message, 8000);
    }).then(function () {
      if (btn) btn.disabled = false;
      syncAccountSelection();
    });
  }

  document.getElementById("btnCheckin").addEventListener("click", function () {
    runCheckin(selectedAccountIDs(), this);
  });

  // 任务中心绑定（一键做任务已完全隔离至任务中心，按渠道/模块元数据驱动）
  Array.prototype.forEach.call(document.querySelectorAll("#taskKpiStrip .kpi-chip"), function (btn) {
    btn.addEventListener("click", function () { setTaskModuleFilter(btn.getAttribute("data-tkpi")); });
  });
  document.getElementById("btnResetTaskScope").addEventListener("click", function () {
    setTaskVendorFilter("");
  });
  document.getElementById("btnAutoAll").addEventListener("click", function () {
    runAutoAll(taskVendorFilter ? { vendor_ids: [taskVendorFilter] } : {}, this);
  });
  Array.prototype.forEach.call(document.querySelectorAll("#taskFilterPills .fpill"), function (btn) {
    btn.addEventListener("click", function () { setTaskFilter(btn.getAttribute("data-tfilter")); });
  });
  document.getElementById("btnScan").addEventListener("click", function () {
    var button = this;
    button.disabled = true;
    banner("ok", "正在扫描支持待办探测的渠道账号…", 0);
    api("POST", "/tasks/scan", taskScopeRequest()).then(function (payload) {
      if (!payload) return;
      if (Array.isArray(payload.modules)) applyTaskModules(payload.modules);
      if (queueTimer === null) queueByUID = {};
      renderScans(payload);
      var errors = (payload.accounts || []).filter(function (account) { return !!account.error; }).length;
      banner(errors ? "warn" : "ok", "扫描完成：共 " + (payload.pending_count || 0) + " 个待办" +
        (errors ? "，" + errors + " 个账号扫描失败" : ""), 5000);
    }).catch(function (err) { banner("err", err.message, 8000); }).then(renderTaskCenter);
  });
  document.getElementById("btnRunQueue").addEventListener("click", function () {
    if (queueStarting || queueTimer !== null) return;
    var mayUseChat = taskModules.some(function (m) {
      return m.supports_scan && m.uses_chat && accountsForModules([m], taskVendorFilter).length > 0;
    });
    if (mayUseChat && !window.confirm("队列中的部分任务可能发起真实模型对话并消耗账号额度，是否继续？")) return;
    var conc = parseInt(document.getElementById("queueConc").value, 10) || 1;
    var reqBody = taskScopeRequest();
    reqBody.concurrency = conc;
    queueStarting = true;
    renderTaskCenter();
    api("POST", "/tasks/run", reqBody).then(function (result) {
      if (!result) return;
      if (!result.started) { banner("ok", result.message || "没有待办"); return; }
      lastQueueSeq = result.seq;
      banner("ok", "队列已启动：" + result.total + " 项，并发 " + result.concurrency);
      if (queueTimer) clearInterval(queueTimer);
      queueTimer = setInterval(pollQueue, 3000);
      pollQueue();
    }).catch(function (err) {
      if (err.status === 409) pollQueue();
      banner(err.status === 409 ? "warn" : "err", err.message);
    }).then(function () {
      queueStarting = false;
      renderTaskCenter();
    });
  });

  // 运行期设置绑定
  ["setAutoCheckin", "setCheckinAt", "setAutoTasks", "setPromptMode", "setModelNameTag"].forEach(function (id) {
    var elNode = document.getElementById(id);
    if (!elNode) return;
    elNode.addEventListener("change", function () { setSettingsDirty(true); });
    if (elNode.tagName === "INPUT" && elNode.type === "text") {
      elNode.addEventListener("input", function () { setSettingsDirty(true); });
    }
  });
  var saveSettingsButton = document.getElementById("btnSaveSettings");
  saveSettingsButton.disabled = true;

  function collectTaskSchedules() {
    var schedules = {};
    document.querySelectorAll("#taskSchedule input[data-task-kind]").forEach(function (input) {
      var raw = (input.value || "").trim();
      var hours = raw ? raw.split(",").map(function (value) {
        var text = value.trim();
        if (!/^\d{1,2}$/.test(text) || Number(text) > 23) {
          throw new Error("排程仅接受逗号分隔的 0–23 整点小时");
        }
        return Number(text);
      }) : [];
      schedules[input.dataset.taskKind] = hours;
    });
    return schedules;
  }

  saveSettingsButton.addEventListener("click", function () {
    if (!settingsLoaded || !authReady) return;
    var promptSel = document.getElementById("setPromptMode");
    var schedules;
    try { schedules = collectTaskSchedules(); }
    catch (error) { banner("err", error.message); return; }
    var payload = {
      auto_checkin: document.getElementById("setAutoCheckin").checked,
      auto_checkin_at: document.getElementById("setCheckinAt").value,
      auto_tasks: document.getElementById("setAutoTasks").checked,
      prompt_mode: promptSel ? promptSel.value : "passthrough",
      model_name_tag: (document.getElementById("setModelNameTag") || {}).value || "off",
      task_schedules: schedules
    };
    var submittedRevision = settingsRevision;
    saveSettingsButton.disabled = true;
    api("POST", "/settings", payload).then(function (data) {
      if (!data) return;
      if (!data.ok) throw new Error(data.error || "设置保存失败");
      if (settingsRevision === submittedRevision) {
        if (data.settings) renderRuntimeSettings(data.settings);
        setSettingsDirty(false);
      }
      if (data.model_registry_dirty) {
        banner("ok", "设置已保存，正在同步 CPA 模型注册表");
        syncModelConfig();
      } else {
        banner("ok", "设置已保存并生效");
      }
      return loadStatus(true).catch(function () { });
    }).catch(function (err) { banner("err", err.message); }).then(function () {
      saveSettingsButton.disabled = false;
    });
  });

  // ---- 日志视图（级别筛选 + 关键字过滤 + 复制/清空） ----
  var logBuffer = [];
  var logLevelFilter = "ALL";
  var logRequestID = 0;
  var logRequestBusy = false;

  function renderLogs() {
    var host = document.getElementById("logs");
    if (!host) return;
    var nearBottom = (host.scrollHeight - host.scrollTop - host.clientHeight) < 40;
    var kw = (document.getElementById("logFilter").value || "").trim().toLowerCase();
    host.textContent = "";
    var shown = 0;
    logBuffer.forEach(function (entry) {
      var lvl = String(entry.level || "INFO").toUpperCase();
      if (logLevelFilter !== "ALL" && lvl !== logLevelFilter) return;
      var text = entry.time + " [" + entry.level + "] " + entry.message;
      if (kw && text.toLowerCase().indexOf(kw) < 0) return;
      host.appendChild(el("div", text, "log-line " + lvl));
      shown++;
    });
    setText("logCount", logBuffer.length
      ? ("(" + (shown === logBuffer.length ? logBuffer.length : (shown + " / " + logBuffer.length)) + " 条)")
      : "");
    if (nearBottom) host.scrollTop = host.scrollHeight;
  }

  function appendLogs(entries) {
    (entries || []).forEach(function (entry) { logBuffer.push(entry); });
    if (logBuffer.length > 800) logBuffer = logBuffer.slice(logBuffer.length - 800);
    renderLogs();
  }

  function loadLogs(reset) {
    if (!reset && logRequestBusy) return;
    var requestID = ++logRequestID;
    logRequestBusy = true;
    var since = reset ? 0 : logSeq;
    return api("GET", "/logs?since=" + since + "&limit=200").then(function (payload) {
      if (!payload || requestID !== logRequestID) return;
      if (reset || payload.reset) logBuffer = [];
      appendLogs(payload.entries);
      logSeq = payload.next || 0;
    }).catch(function (err) {
      if (requestID === logRequestID) banner("err", err.message);
    }).then(function () {
      if (requestID === logRequestID) logRequestBusy = false;
    });
  }

  // 日志控件绑定
  document.getElementById("btnLogs").addEventListener("click", function () { loadLogs(true); });
  document.getElementById("autoLogs").addEventListener("change", function (event) {
    if (event.target.checked && authReady) loadLogs(true);
    syncLogPolling();
  });
  Array.prototype.forEach.call(document.querySelectorAll("#logLevelPills .fpill"), function (btn) {
    btn.addEventListener("click", function () {
      logLevelFilter = btn.getAttribute("data-level") || "ALL";
      Array.prototype.forEach.call(document.querySelectorAll("#logLevelPills .fpill"), function (b) {
        b.classList.toggle("active", b === btn);
      });
      renderLogs();
    });
  });
  document.getElementById("logFilter").addEventListener("input", renderLogs);
  document.getElementById("btnClearLogFilter").addEventListener("click", function () {
    var input = document.getElementById("logFilter");
    input.value = "";
    renderLogs();
    input.focus();
  });
  document.getElementById("btnClearLogs").addEventListener("click", function () {
    logRequestID++;
    logRequestBusy = false;
    logBuffer = [];
    renderLogs();
  });
  document.getElementById("btnCopyLogs").addEventListener("click", function () {
    var lines = Array.prototype.map.call(document.querySelectorAll("#logs .log-line"), function (n) { return n.textContent; });
    if (!lines.length) { banner("warn", "当前没有可复制的日志"); return; }
    Promise.resolve().then(function () { return navigator.clipboard.writeText(lines.join("\n")); }).then(function () {
      banner("ok", "已复制 " + lines.length + " 条日志到剪贴板");
    }).catch(function () { banner("warn", "复制失败，请手动选中日志内容"); });
  });

  // 全局快捷键：Esc 关闭抽屉/弹窗/菜单，/ 聚焦当前视图搜索框，1-5 切视图
  document.addEventListener("keydown", function (event) {
    var keyModal = document.getElementById("keyBox");
    if (keyModal && !keyModal.hidden) return;
    if (event.key === "Escape") {
      closeAccountDrawer();
      closeClaimModal();
      closeModelColumnsMenu();
      closeVendorMenu();
      closeAllCustomSelects();
      closeInfoPopover();
      return;
    }
    var tag = event.target && event.target.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (event.target && event.target.isContentEditable)) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === "/") {
      var targetId = activeView === "models" ? "modelFilter" : (activeView === "logs" ? "logFilter" : "accountFilter");
      var inp = document.getElementById(targetId);
      if (inp) { event.preventDefault(); inp.focus(); }
      return;
    }
    var idx = ["1", "2", "3", "4", "5"].indexOf(event.key);
    if (idx >= 0) {
      event.preventDefault();
      switchView(VALID_VIEWS[idx], true);
    }
  });

  function syncLogPolling() {
    if (logTimer) { clearInterval(logTimer); logTimer = null; }
    var box = document.getElementById("autoLogs");
    if (authReady && box && box.checked) {
      logTimer = setInterval(function () { loadLogs(false); }, 5000);
    }
  }

  function probeManagementAuth() {
    return api("GET", "/vendors").then(function (data) {
      if (!data) return false;
      if (!Array.isArray(data.vendors)) throw new Error("CPA 插件管理接口未返回供应商清单");
      return true;
    });
  }

  function startConsole() {
    loadVendors().then(function () {
      return Promise.all([
        loadTaskModules().catch(function () { return null; }),
        loadStatus().catch(function () { return null; })
      ]);
    }).then(function () {
      loadModels(true);
      loadLogs(true);
      syncLogPolling();
      loadQuotas(true).catch(function () { });
    });
  }

  function logoutConsole() {
    clearSavedKeys(true);
    authReady = false;
    stopped = true;
    if (logTimer) { clearInterval(logTimer); logTimer = null; }
    if (queueTimer) { clearInterval(queueTimer); queueTimer = null; }
    stopLoginPolling();
    closeAccountDrawer();
    closeClaimModal();
    closeModelColumnsMenu();
    closeVendorMenu();
    closeAllCustomSelects();
    closeInfoPopover();
    var input = document.getElementById("keyInput");
    if (input) input.value = "";
    revealKeyInput();
    setKeyStatus("已退出管理面板，请输入管理密钥重新登录", "idle");
    banner("ok", "已退出面板，本页记住的密钥已清除", 3500);
  }

  document.getElementById("btnLogout").addEventListener("click", logoutConsole);

  function authSourceLabel() {
    if (manualKey) return "正在验证手动填入的密钥…";
    if (rememberedLocalKey()) return "已读取本机记住的管理密钥，正在验证…";
    if (panelAuthKey()) return "已自动复用 CPA 主面板已登录密钥，正在验证…";
    return "未检测到已保存的管理密钥，请在此输入";
  }

  function ensureAuth() {
    if (isExplicitlyLoggedOut()) {
      stopped = true;
      authReady = false;
      revealKeyInput();
      setKeyStatus("已退出管理面板，请输入管理密钥重新登录", "idle");
      return;
    }
    if (!managementKey()) {
      revealKeyInput();
      setKeyStatus("未检测到已保存的管理密钥，请输入后进入面板（支持记住密钥）", "idle");
      return;
    }
    setKeyStatus(authSourceLabel(), "checking");
    probeManagementAuth().then(function (ok) {
      if (!ok) {
        clearSavedKeys(false);
        revealKeyInput();
        if (!stopped) setKeyStatus("已保存的管理密钥未能通过校验，请重新输入", "warn");
        return;
      }
      authReady = true;
      stopped = false;
      hideKeyInput();
      clearBanner();
      startConsole();
    }).catch(function (err) {
      revealKeyInput();
      setKeyStatus("无法连接插件管理接口：" + (err && err.message ? err.message : "请求异常"), "err");
      banner("err", err.message);
    });
  }

  (function boot() {
    initTheme();
    initNotice();
    initTabs();
    enhanceSelect(document.getElementById("accountSort"), { alignRight: true });
    enhanceSelect(document.getElementById("setPromptMode"), { wide: true, alignRight: true, richHints: true });
    enhanceSelect(document.getElementById("setModelNameTag"), { wide: true, alignRight: true, richHints: true });
    ensureAuth();
  })();
})();
