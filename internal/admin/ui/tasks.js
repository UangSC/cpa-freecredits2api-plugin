  // ---- 任务视图（协议驱动模块中心 + 渠道隔离 + 折叠待办卡片） ----
  var taskModules = [];
  var taskModulesReady = false;
  var taskVendorFilter = "";
  var taskModuleFilter = "all"; // "all" | "scan" | "chat"
  var lastScans = null;
  var taskFilterMode = "all"; // "all" | "pending" | "none" | "error"
  var queueByUID = {};
  var autoAllRunning = false;
  var queueStarting = false;
  var queuePollBusy = false;

  function taskCategoryLabel(category) {
    switch (String(category || "").toLowerCase()) {
      case "daily": return "日常任务";
      case "activity": return "活动任务";
      case "benefit": return "活动福利";
      case "campaign": return "限时活动";
      default: return category || "扩展模块";
    }
  }

  function scanItems(scan) {
    if (!scan) return [];
    if (Array.isArray(scan.tasks)) return scan.tasks;
    return (scan.growth || []).concat(scan.school || []);
  }

  function taskKindDisplay(item) {
    if (!item) return "-";
    if (item.kind_label) return item.kind_label;
    if (item.kind === "school") return "开学季";
    if (item.kind === "growth") return "成长任务";
    return item.kind || "任务";
  }

  function moduleSupportsVendor(mod, vendorID) {
    if (!vendorID) return true;
    var ids = (mod && mod.vendor_ids) || [];
    return ids.indexOf(vendorID) >= 0;
  }

  function taskCapableVendorIDs() {
    var set = {};
    taskModules.forEach(function (mod) {
      (mod.vendor_ids || []).forEach(function (vid) { set[vid] = true; });
    });
    var ordered = [];
    (vendorsList || []).forEach(function (v) {
      if (set[v.id]) {
        ordered.push(v.id);
        delete set[v.id];
      }
    });
    Object.keys(set).sort().forEach(function (vid) { ordered.push(vid); });
    return ordered;
  }

  function enabledTaskAccounts() {
    var accounts = (lastStatus && lastStatus.accounts) || [];
    return accounts.filter(function (a) { return !a.disabled; });
  }

  function accountMatchesModule(account, mod) {
    if (!account || !mod) return false;
    if (Array.isArray(account.task_modules)) {
      return account.task_modules.indexOf(mod.id) >= 0;
    }
    if (account.supports_tasks === false) return false;
    return moduleSupportsVendor(mod, account.vendor_id);
  }

  function accountsForModules(mods, vendorID) {
    var list = enabledTaskAccounts();
    return list.filter(function (account) {
      if (vendorID && account.vendor_id !== vendorID) return false;
      return mods.some(function (mod) { return accountMatchesModule(account, mod); });
    });
  }

  function loadTaskModules() {
    return api("GET", "/tasks/modules").then(function (data) {
      if (!data) return;
      applyTaskModules(data.modules);
      if (taskModules.length) restoreTaskJobs();
    }).catch(function () {
      // 兜底：若 /tasks/modules 不可用则从 /vendors 元数据推导
      var derived = [];
      var seen = {};
      (vendorsList || []).forEach(function (v) {
        (v.task_modules || []).forEach(function (m) {
          if (m && m.id && !seen[m.id]) {
            seen[m.id] = true;
            derived.push(m);
          }
        });
      });
      if (vendorsLoaded) applyTaskModules(derived);
    });
  }

  function applyTaskModules(modules) {
    var enabledVendors = new Set((vendorsList || []).map(function (v) { return v.id; }));
    taskModules = (Array.isArray(modules) ? modules : []).map(function (mod) {
      var ids = mod.vendor_ids || [];
      if (vendorsLoaded) ids = ids.filter(function (id) { return enabledVendors.has(id); });
      return Object.assign({}, mod, { vendor_ids: ids });
    }).filter(function (mod) { return mod.vendor_ids.length > 0; });
    taskModulesReady = true;
    if (taskVendorFilter && taskCapableVendorIDs().indexOf(taskVendorFilter) < 0) taskVendorFilter = "";
    var tab = document.querySelector('#mainTabs [data-view="tasks"]');
    if (tab) tab.hidden = taskModules.length === 0;
    if (!taskModules.length && activeView === "tasks") switchView("accounts", true);
    renderTaskCenter();
  }

  function taskScopeRequest() {
    return taskVendorFilter ? { vendor_ids: [taskVendorFilter] } : {};
  }

  function restoreTaskJobs() {
    pollQueue();
    api("GET", "/tasks/auto_all/status").then(function (data) {
      if (data && data.running && !autoAllRunning) {
        autoAllRunning = true;
        renderTaskCenter();
        pollAutoAll(null);
      }
    }).catch(function () {});
  }

  function setTaskVendorFilter(vendorID) {
    taskVendorFilter = vendorID || "";
    renderTaskCenter();
  }

  function setTaskModuleFilter(mode) {
    if (mode === "pending") {
      taskModuleFilter = "all";
      if (lastScans) setTaskFilter("pending");
      renderTaskCenter();
      var scansEl = document.getElementById("scans");
      if (scansEl && scansEl.scrollIntoView) scansEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
      return;
    }
    taskModuleFilter = mode || "all";
    renderTaskCenter();
  }

  function setTaskFilter(mode) {
    taskFilterMode = mode || "all";
    Array.prototype.forEach.call(document.querySelectorAll("#taskFilterPills .fpill"), function (btn) {
      btn.classList.toggle("active", btn.getAttribute("data-tfilter") === taskFilterMode);
    });
    if (lastScans) renderScans(lastScans);
  }

  function buildAutoAllConfirmText(scopeLabel, mods, accountCount) {
    var chatMods = (mods || []).filter(function (m) { return !!m.uses_chat; });
    var lines = ["将对「" + scopeLabel + "」（预计 " + accountCount + " 个启用账号）依次执行一键任务。"];
    if (chatMods.length) {
      var names = chatMods.map(function (m) { return m.name || m.id; }).join("、");
      lines.push("");
      lines.push("注意：包含「" + names + "」，其中部分子任务会发起真实对话并消耗账号额度；每个账号约需 1-2 分钟，请耐心等待。");
    } else {
      lines.push("");
      lines.push("本次涉及的任务模块均为纯福利/活动上报，不消耗对话额度。");
    }
    lines.push("");
    lines.push("确认继续？");
    return lines.join("\n");
  }

  function renderTaskCenter() {
    var vendorIDs = taskCapableVendorIDs();
    var scopedModules = taskModules.filter(function (m) { return moduleSupportsVendor(m, taskVendorFilter); });
    var scannableCount = scopedModules.filter(function (m) { return !!m.supports_scan; }).length;
    var chatCount = scopedModules.filter(function (m) { return !!m.uses_chat; }).length;
    var eligibleAccounts = accountsForModules(scopedModules, taskVendorFilter);

    // 1. 顶部 KPI 分类卡片
    setText("tKpiValModules", String(scopedModules.length));
    setText("tKpiValScan", String(scannableCount));
    setText("tKpiValChat", String(chatCount));
    Array.prototype.forEach.call(document.querySelectorAll("#taskKpiStrip .kpi-chip"), function (chip) {
      var key = chip.getAttribute("data-tkpi");
      chip.classList.toggle("active", key === taskModuleFilter);
    });

    // 2. 左侧任务渠道栏（仅展示挂载了任务模块的渠道，无任务渠道彻底隔离）
    var allTaskAccounts = accountsForModules(taskModules, "");
    setText("taskRailTotal", String(vendorIDs.length) + " 渠道");
    var railList = document.getElementById("taskRailList");
    if (railList) {
      railList.textContent = "";
      var allBtn = document.createElement("button");
      allBtn.type = "button";
      allBtn.className = "rail-item" + (taskVendorFilter === "" ? " active" : "");
      allBtn.appendChild(el("span", "全部任务渠道", "rail-name"));
      allBtn.appendChild(el("span", String(allTaskAccounts.length), "rail-count"));
      allBtn.addEventListener("click", function () { setTaskVendorFilter(""); });
      railList.appendChild(allBtn);

      if (vendorIDs.length) {
        vendorIDs.forEach(function (vid) {
          var vMods = taskModules.filter(function (m) { return moduleSupportsVendor(m, vid); });
          var vAccts = accountsForModules(vMods, vid);
          var btn = document.createElement("button");
          btn.type = "button";
          btn.className = "rail-item" + (taskVendorFilter === vid ? " active" : "");
          btn.appendChild(el("span", vendorLabel(vid, ""), "rail-name"));
          btn.appendChild(el("span", String(vAccts.length), "rail-count"));
          btn.title = vendorLabel(vid, "") + " · " + vMods.length + " 个模块 · " + vAccts.length + " 个启用账号";
          btn.addEventListener("click", function () { setTaskVendorFilter(vid); });
          railList.appendChild(btn);
        });
      } else {
        var emptyRail = el("div", null, "rail-empty");
        emptyRail.appendChild(svgEl("M4 7.5h12M4 12.5h8", ""));
        emptyRail.appendChild(el("div", "暂无任务渠道"));
        railList.appendChild(emptyRail);
      }
    }

    // 3. 右侧标题与一键按钮文案同步
    var scopeTitle = taskVendorFilter ? vendorLabel(taskVendorFilter, "") : "全部任务渠道";
    setText("taskWorkspaceTitle", taskVendorFilter ? ("任务中心 · " + scopeTitle) : "任务中心");
    var resetBtn = document.getElementById("btnResetTaskScope");
    if (resetBtn) resetBtn.hidden = !taskVendorFilter;

    var autoBtn = document.getElementById("btnAutoAll");
    if (autoBtn) {
      var lbl = autoBtn.querySelector(".btn-label") || autoBtn;
      lbl.textContent = taskVendorFilter ? ("一键做任务 · " + scopeTitle) : "一键做任务";
      var autoModules = scopedModules.filter(function (m) { return !!m.auto_eligible; });
      autoBtn.disabled = autoAllRunning || accountsForModules(autoModules, taskVendorFilter).length === 0;
    }
    var scannable = scopedModules.filter(function (m) { return !!m.supports_scan; });
    var canScan = accountsForModules(scannable, taskVendorFilter).length > 0;
    var scanBtn = document.getElementById("btnScan");
    var queueBtn = document.getElementById("btnRunQueue");
    if (scanBtn) scanBtn.disabled = !canScan;
    if (queueBtn) queueBtn.disabled = !canScan || queueStarting || queueTimer !== null;

    // 4. 已挂载任务模块网格
    var grid = document.getElementById("taskModulesGrid");
    var filteredMods = scopedModules.filter(function (mod) {
      if (taskModuleFilter === "scan") return !!mod.supports_scan;
      if (taskModuleFilter === "chat") return !!mod.uses_chat;
      return true;
    });
    setText("taskModulesMeta", scopedModules.length
      ? ("共 " + scopedModules.length + " 个模块 · 覆盖 " + eligibleAccounts.length + " 个启用账号"
        + (filteredMods.length !== scopedModules.length ? ("（当前筛选 " + filteredMods.length + " 个）") : ""))
      : "当前范围未挂载任何任务模块");

    if (grid) {
      grid.textContent = "";
      if (!filteredMods.length) {
        renderEmptyState(grid,
          scopedModules.length ? "当前筛选下没有匹配的任务模块" : "暂无已挂载的任务模块",
          scopedModules.length ? "点击顶部「已挂载模块」重置筛选条件。" : "新活动可按 TaskModule 协议在 internal/taskmods/ 独立接入。",
          scopedModules.length ? "显示全部模块" : "",
          scopedModules.length ? function () { setTaskModuleFilter("all"); } : null);
      } else {
        filteredMods.forEach(function (mod) {
          var card = el("div", null, "task-mod-card");
          var head = el("div", null, "task-mod-head");
          head.appendChild(el("div", mod.name || mod.id, "task-mod-title"));
          var vendorsWrap = el("div", null, "task-mod-vendors");
          (mod.vendor_ids || []).forEach(function (vid) {
            var vName = vendorLabel(vid, "");
            vendorsWrap.appendChild(pill(vName, vendorChipClass(vid, vName)));
          });
          head.appendChild(vendorsWrap);
          card.appendChild(head);

          if (mod.description) {
            var desc = el("div", mod.description, "task-mod-desc");
            desc.title = mod.description;
            card.appendChild(desc);
          }

          var badges = el("div", null, "task-mod-badges");
          badges.appendChild(pill(taskCategoryLabel(mod.category)));
          badges.appendChild(mod.supports_scan ? pill("支持扫描", "accent") : pill("一键直跑"));
          badges.appendChild(mod.uses_chat ? pill("含真实对话", "warn") : pill("不消耗额度", "ok"));
          if ((mod.default_hours && mod.default_hours.length) || mod.after_checkin) {
            badges.appendChild(pill("定时排程"));
          }
          card.appendChild(badges);

          var modAccounts = accountsForModules([mod], taskVendorFilter);
          var foot = el("div", null, "task-mod-foot");
          var meta = el("div", null, "task-mod-meta");
          var idTag = el("span", mod.id, "task-mod-id");
          idTag.title = mod.id;
          meta.appendChild(idTag);
          meta.appendChild(el("span", modAccounts.length + " 账号", "tnum"));
          foot.appendChild(meta);

          var runBtn = el("button", "执行此模块", "act xs" + (modAccounts.length ? "" : " subtle"));
          runBtn.type = "button";
          runBtn.disabled = autoAllRunning || modAccounts.length === 0;
          runBtn.title = modAccounts.length
            ? ("仅对适用的 " + modAccounts.length + " 个启用账号执行「" + (mod.name || mod.id) + "」")
            : "当前没有适用于该模块的启用账号";
          runBtn.addEventListener("click", function () {
            runAutoAll({
              module_ids: [mod.id],
              vendor_ids: taskVendorFilter ? [taskVendorFilter] : []
            }, runBtn, mod.name || mod.id, [mod]);
          });
          foot.appendChild(runBtn);
          card.appendChild(foot);
          grid.appendChild(card);
        });
      }
    }

    if (lastScans) {
      renderScans(lastScans);
    } else {
      setText("taskSummaryText", eligibleAccounts.length
        ? (scopeTitle + " · " + scopedModules.length + " 个模块 · " + eligibleAccounts.length + " 个启用账号")
        : "模块化活动任务 · 按渠道与能力自动隔离");
    }
  }

  function runAutoAll(opts, btn, customScopeLabel, customModules) {
    if (autoAllRunning) return;
    opts = opts || {};
    var vendorIDs = (opts.vendor_ids || []).filter(Boolean);
    var moduleIDs = (opts.module_ids || []).filter(Boolean);
    var targetModules = customModules || taskModules.filter(function (m) {
      if (moduleIDs.length) return moduleIDs.indexOf(m.id) >= 0;
      if (!m.auto_eligible) return false;
      if (vendorIDs.length) return vendorIDs.some(function (vid) { return moduleSupportsVendor(m, vid); });
      return true;
    });
    if (!targetModules.length) {
      banner("warn", "当前范围没有可自动执行的任务模块", 5000);
      return;
    }
    var targetAccounts = accountsForModules(targetModules, vendorIDs.length === 1 ? vendorIDs[0] : "");
    if (targetAccounts.length === 0) {
      banner("warn", "当前范围没有适用的启用账号", 5000);
      return;
    }
    var scopeLabel = customScopeLabel || (vendorIDs.length === 1 ? vendorLabel(vendorIDs[0], "") : "全部任务渠道");
    if (!window.confirm(buildAutoAllConfirmText(scopeLabel, targetModules, targetAccounts.length))) {
      return;
    }
    var payload = {};
    if (vendorIDs.length) payload.vendor_ids = vendorIDs;
    if (moduleIDs.length) payload.module_ids = moduleIDs;
    if (opts.account_ids && opts.account_ids.length) payload.account_ids = opts.account_ids;

    autoAllRunning = true;
    if (btn) btn.disabled = true;
    renderTaskCenter();
    banner("ok", "已在后台开始执行「" + scopeLabel + "」一键任务…", 0);
    api("POST", "/tasks/auto_all", payload).then(function () {
      pollAutoAll(btn, scopeLabel);
    }).catch(function (err) {
      if (err && err.status === 409) { pollAutoAll(btn, scopeLabel); return; }
      autoAllRunning = false;
      if (btn) btn.disabled = false;
      renderTaskCenter();
      banner("err", "执行失败：" + err.message, 8000);
    });
  }

  function pollAutoAll(btn, scopeLabel) {
    var label = scopeLabel || "一键任务";
    var timer = setInterval(function () {
      api("GET", "/tasks/auto_all/status").then(function (data) {
        if (!data) {
          if (stopped) {
            clearInterval(timer);
            autoAllRunning = false;
            if (btn) btn.disabled = false;
            renderTaskCenter();
          }
          return;
        }
        if (data.running) {
          var progress = data.total ? "（" + data.progress + "/" + data.total + "）" : "";
          banner("ok", "正在逐账号执行「" + label + "」" + progress + "，关闭页面不影响执行…", 0);
          return;
        }
        clearInterval(timer);
        autoAllRunning = false;
        if (btn) btn.disabled = false;
        var result = data.result || {};
        var lines = [];
        ((result && result.results) || []).forEach(function (entry) {
          if (entry.skipped) { lines.push((entry.label || "") + "：" + entry.skipped); return; }
          var results = entry.results || [];
          var done = results.filter(function (r) { return r.status === "done"; }).length;
          var errs = results.filter(function (r) { return r.status === "error"; }).length;
          lines.push((entry.label || "") + "：完成 " + done + (errs ? "，失败 " + errs : ""));
        });
        var tone = result.ok === false ? "err" : (result.cancelled ? "warn" : "ok");
        banner(tone, "「" + label + "」执行结束：" + (result.message || lines.join("；") || "无结果"), 7000);
        renderTaskCenter();
        loadStatus(true);
      }).catch(function (err) {
        clearInterval(timer);
        autoAllRunning = false;
        if (btn) btn.disabled = false;
        renderTaskCenter();
        banner("err", "读取执行进度失败：" + err.message, 8000);
      });
    }, 3000);
  }

  function runSingleTaskItem(uid, code, moduleID, title, btn) {
    if (!uid || !code) return;
    if (btn) { btn.disabled = true; btn.textContent = "执行中…"; }
    api("POST", "/tasks/auto", { uid: uid, task_code: code, module_id: moduleID || "" }).then(function (res) {
      if (!res) return;
      if (!queueByUID[uid]) queueByUID[uid] = {};
      var status = res.status || (res.ok ? "done" : "error");
      var message = res.message || res.error || taskStatusLabel(status);
      queueByUID[uid][taskStateKey(moduleID, code)] = { status: status, message: message };
      if (res.ok) {
        banner(status === "skipped" ? "warn" : "ok", (title || code) + "：" + message, 5000);
      } else {
        banner("err", (title || code) + "：" + message, 7000);
      }
      if (lastScans) renderScans(lastScans);
    }).catch(function (err) {
      banner("err", "执行失败：" + err.message, 7000);
      if (btn) { btn.disabled = false; btn.textContent = "执行"; }
    });
  }

  function taskStateKey(moduleID, code) {
    return JSON.stringify([moduleID || "", code]);
  }

  function taskStatusLabel(status) {
    return { pending: "排队中", running: "执行中", done: "已完成", skipped: "已跳过", error: "执行失败" }[status] || "未知状态";
  }

  function renderScans(payload) {
    lastScans = payload;
    var host = document.getElementById("scans");
    var filterBar = document.getElementById("taskFilterPills");
    if (!host) return;
    host.textContent = "";
    var allAccounts = (payload && payload.accounts) || [];
    var accounts = allAccounts.filter(function (scan) {
      if (!taskVendorFilter) return true;
      return scan.vendor_id === taskVendorFilter;
    });
    if (filterBar) filterBar.hidden = !accounts.length;

    var globalPending = 0;
    allAccounts.forEach(function (scan) {
      globalPending += scanItems(scan).length;
    });
    var scopedPending = 0;
    accounts.forEach(function (scan) {
      scopedPending += scanItems(scan).length;
    });
    setText("tabBadgeTasks", globalPending > 0 ? String(globalPending) : "");
    setText("tKpiValPending", String(scopedPending));
    setText("taskScanMeta", accounts.length
      ? ("已扫描 " + accounts.length + " 个账号 · " + scopedPending + " 项待办")
      : (allAccounts.length ? "当前筛选渠道暂无扫描记录" : "点击「扫描待办」实时探测可扫描渠道"));
    setText("taskSummaryText", accounts.length
      ? ("共扫描 " + accounts.length + " 个账号 · " + scopedPending + " 项待办")
      : "模块化活动任务 · 按渠道与能力自动隔离");

    if (!accounts.length) return;

    var filtered = accounts.filter(function (scan) {
      var items = scanItems(scan);
      var hasPending = items.length > 0;
      if (taskFilterMode === "pending") return hasPending;
      if (taskFilterMode === "none") return !hasPending && !scan.error;
      if (taskFilterMode === "error") return !!scan.error;
      return true;
    });

    if (!filtered.length) {
      renderEmptyState(host, "当前筛选下没有匹配账号", "切换筛选胶囊查看全部扫描结果。", "显示全部", function () { setTaskFilter("all"); });
      return;
    }

    var listWrap = el("div", null, "task-list");
    filtered.forEach(function (scan) {
      var pending = scanItems(scan);
      var todoCount = pending.length;
      var card = document.createElement("details");
      card.className = "task-card";
      if (todoCount > 0 || scan.error) card.open = true;

      var summary = document.createElement("summary");
      summary.className = "task-summary";
      var left = el("div", null, "task-summary-left");
      left.appendChild(svgEl("M7 5l5 5-5 5", "agg-chev"));
      var vName = vendorLabel(scan.vendor_id, scan.realm);
      left.appendChild(pill(vName, vendorChipClass(scan.vendor_id, vName)));
      left.appendChild(el("span", scan.label || scan.uid));
      summary.appendChild(left);

      var right = el("div", null, "acct-main");
      if (scan.error) right.appendChild(pill("扫描报错", "err"));
      else if (todoCount > 0) right.appendChild(pill(todoCount + " 项待办", "warn"));
      else right.appendChild(pill("无待办", "ok"));
      summary.appendChild(right);
      card.appendChild(summary);

      var body = el("div", null, "task-body");
      if (scan.error) {
        var errDiv = el("div", scan.error, "task-body-pad");
        errDiv.style.color = "var(--err)";
        body.appendChild(errDiv);
      }
      if (!pending.length) {
        if (!scan.error) body.appendChild(el("div", "该账号当前没有待办任务。", "task-body-pad muted"));
      } else {
        var table = el("table");
        var head = el("tr");
        ["任务", "类别", "进度", "额度消耗", "执行状态"].forEach(function (name) { head.appendChild(el("th", name)); });
        table.appendChild(head);
        var progress = queueByUID[scan.uid] || {};
        pending.forEach(function (item) {
          var row = el("tr");
          row.appendChild(el("td", item.title || item.code));
          row.appendChild(el("td", taskKindDisplay(item), "muted"));
          row.appendChild(el("td", (item.current || 0) + " / " + (item.target || 0), "tnum"));
          row.appendChild(cellWith(item.uses_chat ? pill("真实对话", "warn") : pill("纯上报")));

          var execCode = item.run_code || item.code;
          var state = progress[taskStateKey(item.module_id, execCode)] || progress[taskStateKey(item.module_id, item.code)];
          var cell = el("td");
          var opsWrap = el("div", null, "task-row-ops");
          if (state) {
            if (state.status === "error" && state.message) {
              opsWrap.appendChild(makeInteractivePill("执行失败", "err", {
                tone: "err",
                title: "任务执行失败",
                subtitle: item.title || item.code,
                detail: state.message
              }));
            } else {
              var kind = state.status === "done" ? "ok"
                : (state.status === "error" ? "err" : (state.status === "running" ? "warn" : ""));
              opsWrap.appendChild(pill(taskStatusLabel(state.status), kind));
              if (state.message) opsWrap.appendChild(el("span", " " + shortReason(state.message), "muted"));
            }
          } else {
            var claimable = item.target > 0 && item.current >= item.target;
            opsWrap.appendChild(el("span", claimable ? "已达标" : "待执行", "muted"));
            var quickBtn = el("button", claimable ? "领奖" : "执行", "act xs subtle");
            quickBtn.type = "button";
            quickBtn.addEventListener("click", function () {
              if (!claimable && item.uses_chat && !window.confirm("该任务会发起真实模型对话并消耗账号额度，是否继续？")) return;
              runSingleTaskItem(scan.uid, execCode, item.module_id || "", item.title || item.code, quickBtn);
            });
            opsWrap.appendChild(quickBtn);
          }
          cell.appendChild(opsWrap);
          row.appendChild(cell);
          table.appendChild(row);
        });
        body.appendChild(table);
      }
      card.appendChild(body);
      listWrap.appendChild(card);
    });
    host.appendChild(listWrap);
  }

  function renderQueue(snapshot) {
    if (!snapshot || !snapshot.items || !snapshot.items.length) return;
    if (snapshot.seq !== lastQueueSeq) return;
    queueByUID = {};
    snapshot.items.forEach(function (item) {
      if (!queueByUID[item.uid]) queueByUID[item.uid] = {};
      queueByUID[item.uid][taskStateKey(item.module_id, item.code)] = item;
    });
    if (lastScans) renderScans(lastScans);
    var p = document.getElementById("queueProgress");
    if (p) {
      p.hidden = false;
      p.textContent = "队列 " + (snapshot.done || 0) + " / " + (snapshot.total || 0) + (snapshot.running ? "（执行中）" : "（已结束）");
    }
  }

  function pollQueue() {
    if (queuePollBusy) return;
    queuePollBusy = true;
    api("GET", "/tasks/queue").then(function (snapshot) {
      if (!snapshot) return;
      if (snapshot.seq < lastQueueSeq) return;
      lastQueueSeq = snapshot.seq;
      renderQueue(snapshot);
      if ((snapshot.running || snapshot.preparing) && queueTimer === null) {
        queueTimer = setInterval(pollQueue, 3000);
        renderTaskCenter();
      } else if (!snapshot.running && !snapshot.preparing && queueTimer !== null) {
        clearInterval(queueTimer); queueTimer = null;
        var errors = (snapshot.items || []).filter(function (item) { return item.status === "error"; }).length;
        banner(errors ? "warn" : "ok", "队列执行结束" + (errors ? "，" + errors + " 项失败" : ""));
        renderTaskCenter();
        loadStatus(true);
      }
    }).catch(function (err) {
      if (queueTimer === null) return;
      clearInterval(queueTimer);
      queueTimer = null;
      renderTaskCenter();
      banner("err", "读取队列进度失败：" + err.message, 8000);
    }).then(function () { queuePollBusy = false; });
  }
