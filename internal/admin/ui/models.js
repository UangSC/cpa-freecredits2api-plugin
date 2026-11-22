  // ---- 模型视图（按供应商分栏 + 按对外 ID 聚合双视图） ----
  var allModels = [];
  var modelViewMode = "vendor"; // "vendor" | "aggregate"
  var modelVendorFilter = "";
  var modelQuickFilter = "all"; // "all" | "enabled" | "disabled" | "aliased" | "images" | "tools"
  var modelPagerState = { page: 1, pageSize: 25 };
  var selectedModels = {};
  var expandedAggGroups = {};

  var MODEL_COLUMNS = [
    { key: "check", header: "", cell: modelCheckCell },
    { key: "status", header: "启停", cell: modelStatusCell },
    { key: "vendor", header: "供应商", cell: modelVendorCell },
    { key: "model", header: "模型 ID", cell: modelIDCell },
    { key: "name", header: "名称", cell: function (m) {
      var td = el("td");
      var span = el("span", m.name || "—", "name-text");
      if (m.name) span.title = m.name;
      td.appendChild(span);
      return td;
    } },
    { key: "credits", header: "费用倍率", cell: modelCreditsCell },
    { key: "context", header: "上下文", cell: modelContextCell },
    { key: "output", header: "输出上限", optional: true, defaultShow: false, cell: function (m) {
      return el("td", m.max_output_tokens ? formatTokens(m.max_output_tokens) : "—", "tnum");
    } },
    { key: "efforts", header: "推理档位", optional: true, defaultShow: false, cell: function (m) {
      var levels = (m.efforts || []).join(" / ");
      return el("td", levels || "—", levels ? "" : "muted");
    } },
    { key: "caps", header: "能力", optional: true, defaultShow: true, cell: function (m) {
      var td = el("td");
      var hasAny = false;
      if (m.supports_images) { td.appendChild(pill("图片")); hasAny = true; }
      if (m.supports_tools) {
        if (hasAny) td.appendChild(document.createTextNode(" "));
        td.appendChild(pill("工具"));
        hasAny = true;
      }
      if (!hasAny) td.appendChild(el("span", "—", "muted"));
      return td;
    } }
  ];

  var MODEL_COLUMNS_STORE_KEY = "freecredits2api-model-optional-columns";
  var columnPrefs = readColumnPrefs();
  var creditsSortOrder = null;

  function readColumnPrefs() {
    try {
      var raw = migrateStoredValue(localStorage, MODEL_COLUMNS_STORE_KEY, "tierbridge-model-optional-columns", "freetier-model-optional-columns");
      if (!raw) return {};
      var parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        var legacy = {};
        parsed.forEach(function (k) { legacy[k] = true; });
        return legacy;
      }
      return (parsed && typeof parsed === "object") ? parsed : {};
    } catch (e) { return {}; }
  }

  function columnVisible(col) {
    if (!col.optional) return true;
    if (Object.prototype.hasOwnProperty.call(columnPrefs, col.key)) return !!columnPrefs[col.key];
    return !!col.defaultShow;
  }

  function visibleColumns(hideVendor) {
    return MODEL_COLUMNS.filter(function (col) {
      if (hideVendor && col.key === "vendor") return false;
      return columnVisible(col);
    });
  }

  function modelKey(model) {
    return String(model.scope_id || model.id);
  }

  function effectiveModelID(model) {
    if (model.alias) return String(model.alias);
    var bare = String(model.id || "");
    var tag = (lastStatus && lastStatus.settings && lastStatus.settings.model_name_tag) || "off";
    if (tag === "prefix" || tag === "suffix") {
      var tagged = tag === "prefix" ? (model.vendor_id + "-" + bare) : (bare + "-" + model.vendor_id);
      var collision = allModels.some(function (item) {
        return item.vendor_id === model.vendor_id && String(item.id).toLowerCase() === tagged.toLowerCase();
      });
      if (!collision) return tagged;
    }
    return bare;
  }

  function modelCreditValue(model) {
    var raw = String(model.credits || "").trim();
    if (!raw) return null;
    if (raw === "免费") return 0;
    var cleaned = raw.replace(/\bcredits?\b/ig, "").replace(/^[xX]/, "").replace(/[xX]$/, "").trim();
    var num = parseFloat(cleaned);
    if (!isNaN(num) && isFinite(num) && num >= 0) return num;
    return null;
  }

  function toggleOptionalColumn(key, show) {
    columnPrefs[key] = !!show;
    try { localStorage.setItem(MODEL_COLUMNS_STORE_KEY, JSON.stringify(columnPrefs)); } catch (e) { /* 忽略 */ }
    renderModels();
  }

  function setModelViewMode(mode) {
    modelViewMode = mode === "aggregate" ? "aggregate" : "vendor";
    modelPagerState.page = 1;
    var bV = document.getElementById("btnModelViewVendor");
    var bA = document.getElementById("btnModelViewAgg");
    if (bV) bV.classList.toggle("active", modelViewMode === "vendor");
    if (bA) bA.classList.toggle("active", modelViewMode === "aggregate");
    renderModels();
  }

  function setModelQuickFilter(mode) {
    modelQuickFilter = mode || "all";
    modelPagerState.page = 1;
    Array.prototype.forEach.call(document.querySelectorAll("#modelKpiStrip .kpi-chip"), function (btn) {
      btn.classList.toggle("active", btn.getAttribute("data-mkpi") === modelQuickFilter);
    });
    renderModels();
  }

  function syncModelSelection() {
    var count = Object.keys(selectedModels).length;
    var bar = document.getElementById("modelBatchBar");
    if (bar) bar.classList.toggle("has-selection", count > 0);
    setText("modelBatchInfo", count > 0
      ? ("已选中 " + count + " 个模型")
      : "行内开关可即时启停 · 点击「模型 ID」改别名（同名自动负载均衡）");
    var headChk = document.getElementById("chkModelsPage");
    if (headChk) {
      var boxes = document.querySelectorAll("#models input[type=checkbox][data-model-id]");
      var checked = 0;
      Array.prototype.forEach.call(boxes, function (b) { if (b.checked) checked++; });
      headChk.checked = boxes.length > 0 && checked === boxes.length;
      headChk.indeterminate = checked > 0 && checked < boxes.length;
    }
  }

  function renderModelVendorRail() {
    var rail = document.getElementById("modelVendorRail");
    var split = document.getElementById("modelsSplitLayout");
    var listHost = document.getElementById("modelRailList");
    if (rail && split) {
      var hideRail = modelViewMode === "aggregate";
      rail.hidden = hideRail;
      split.style.gridTemplateColumns = hideRail ? "minmax(0, 1fr)" : "";
    }
    if (!listHost || modelViewMode === "aggregate") return;
    listHost.textContent = "";

    var byVendor = {};
    var enabledTotal = 0;
    allModels.forEach(function (m) {
      var vid = m.vendor_id || "_unknown";
      if (!byVendor[vid]) byVendor[vid] = { id: vid, name: vendorLabel(m.vendor_id, m.realm), total: 0, enabled: 0 };
      byVendor[vid].total++;
      if (!m.disabled) { byVendor[vid].enabled++; enabledTotal++; }
    });
    if (modelVendorFilter && !byVendor[modelVendorFilter]) modelVendorFilter = "";
    setText("modelRailTotal", Object.keys(byVendor).length ? (Object.keys(byVendor).length + " 家") : "");

    var allBtn = document.createElement("button");
    allBtn.type = "button";
    allBtn.className = "rail-item" + (!modelVendorFilter ? " active" : "");
    allBtn.appendChild(el("span", null, "rail-dot all"));
    allBtn.appendChild(el("span", "全部供应商", "rail-name"));
    allBtn.appendChild(el("span", enabledTotal + "/" + allModels.length, "rail-count"));
    allBtn.addEventListener("click", function () { modelVendorFilter = ""; modelPagerState.page = 1; renderModels(); });
    listHost.appendChild(allBtn);

    var groups = Object.keys(byVendor).map(function (k) { return byVendor[k]; });
    groups.sort(function (a, b) {
      if (b.enabled !== a.enabled) return b.enabled - a.enabled;
      if (b.total !== a.total) return b.total - a.total;
      return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0);
    });
    if (groups.length) {
      listHost.appendChild(el("div", null, "rail-sep"));
      groups.forEach(function (g) {
        var btn = document.createElement("button");
        btn.type = "button";
        btn.className = "rail-item" + (modelVendorFilter === g.id ? " active" : "");
        btn.appendChild(el("span", null, "rail-dot " + vendorChipClass(g.id, g.name)));
        btn.appendChild(el("span", g.name, "rail-name"));
        btn.appendChild(el("span", g.enabled + "/" + g.total, "rail-count"));
        btn.addEventListener("click", function () { modelVendorFilter = g.id; modelPagerState.page = 1; renderModels(); });
        listHost.appendChild(btn);
      });
    } else {
      var emptyRail = el("div", null, "rail-empty");
      emptyRail.appendChild(svgEl("M4 7.5h12M4 12.5h8", ""));
      emptyRail.appendChild(el("div", "暂无供应商模型"));
      emptyRail.appendChild(el("span", "读取模型清单后展示渠道"));
      listHost.appendChild(emptyRail);
    }
  }

  function renderModelVendorQuickBar(vendorModels) {
    var bar = document.getElementById("modelVendorQuickBar");
    if (!bar) return;
    bar.textContent = "";
    if (modelViewMode !== "vendor" || !modelVendorFilter || !vendorModels.length) {
      bar.hidden = true;
      return;
    }
    bar.hidden = false;
    var enabledCnt = vendorModels.filter(function (m) { return !m.disabled; }).length;
    var left = el("div", null, "acct-main");
    left.appendChild(pill(vendorLabel(modelVendorFilter, ""), vendorChipClass(modelVendorFilter, "")));
    left.appendChild(el("span", "已启用 " + enabledCnt + " / " + vendorModels.length + " 个模型", "muted tnum"));
    bar.appendChild(left);

    var right = el("div", null, "toolbar-group");
    var ids = vendorModels.map(modelKey);
    var bOn = el("button", "本渠道全启", "act xs");
    bOn.type = "button";
    bOn.disabled = enabledCnt === vendorModels.length;
    bOn.addEventListener("click", function () { toggleModelIDs(ids, false); });
    var bOff = el("button", "本渠道全停", "act xs");
    bOff.type = "button";
    bOff.disabled = enabledCnt === 0;
    bOff.addEventListener("click", function () { toggleModelIDs(ids, true); });
    right.appendChild(bOn);
    right.appendChild(bOff);
    bar.appendChild(right);
  }

  function buildModelsTable(items, hideVendor, includeHeaderCheck) {
    var columns = visibleColumns(hideVendor);
    var table = el("table");
    var head = el("tr");
    columns.forEach(function (col) {
      var th = el("th", null, "col-" + col.key);
      if (col.key === "check" && includeHeaderCheck) {
        var headChk = document.createElement("input");
        headChk.type = "checkbox";
        headChk.id = "chkModelsPage";
        headChk.title = "全选 / 取消当前列表模型";
        headChk.addEventListener("change", function () {
          Array.prototype.forEach.call(document.querySelectorAll("#models input[type=checkbox][data-model-id]"), function (b) {
            b.checked = headChk.checked;
            var id = b.getAttribute("data-model-id");
            if (headChk.checked) selectedModels[id] = true;
            else delete selectedModels[id];
            var tr = b.closest && b.closest("tr");
            if (tr) tr.classList.toggle("is-selected", headChk.checked);
          });
          syncModelSelection();
        });
        th.appendChild(headChk);
      } else if (col.key === "credits") {
        th.className += " sortable";
        th.title = "点击按费用倍率排序（从低到高 / 从高到低 / 恢复默认）";
        var wrap = el("span", null, "th-sort-wrap");
        wrap.appendChild(el("span", col.header));
        var arrows = el("span", null, "sort-arrows" + (creditsSortOrder ? " order-" + creditsSortOrder : ""));
        arrows.appendChild(el("span", null, "sort-arrow asc"));
        arrows.appendChild(el("span", null, "sort-arrow desc"));
        wrap.appendChild(arrows);
        th.appendChild(wrap);
        th.addEventListener("click", function () {
          if (!creditsSortOrder) creditsSortOrder = "asc";
          else if (creditsSortOrder === "asc") creditsSortOrder = "desc";
          else creditsSortOrder = null;
          renderModels();
        });
      } else {
        th.textContent = col.header;
      }
      head.appendChild(th);
    });
    table.appendChild(head);

    items.forEach(function (model) {
      var row = el("tr");
      if (selectedModels[modelKey(model)]) row.classList.add("is-selected");
      if (model.disabled) row.classList.add("is-disabled");
      columns.forEach(function (col) {
        var cell = col.cell(model);
        cell.className = (cell.className ? cell.className + " " : "") + "col-" + col.key;
        if (col.key === "model" && model.alias) cell.className += " is-aliased";
        row.appendChild(cell);
      });
      table.appendChild(row);
    });
    return table;
  }

  function renderAggregatedModels(host, list) {
    var groupsMap = {};
    list.forEach(function (m) {
      var eff = effectiveModelID(m);
      if (!groupsMap[eff]) groupsMap[eff] = { id: eff, items: [], enabled: 0 };
      groupsMap[eff].items.push(m);
      if (!m.disabled) groupsMap[eff].enabled++;
    });
    var groups = Object.keys(groupsMap).map(function (k) { return groupsMap[k]; });
    groups.sort(function (a, b) {
      if ((b.enabled > 1 ? 1 : 0) !== (a.enabled > 1 ? 1 : 0)) return (b.enabled > 1 ? 1 : 0) - (a.enabled > 1 ? 1 : 0);
      if ((b.enabled > 0 ? 1 : 0) !== (a.enabled > 0 ? 1 : 0)) return (b.enabled > 0 ? 1 : 0) - (a.enabled > 0 ? 1 : 0);
      return a.id.toLowerCase() < b.id.toLowerCase() ? -1 : 1;
    });

    var pageSlice = renderPager("modelPager", modelPagerState, groups.length, [25, 50, 0], renderModels);
    var pageGroups = groups.slice(pageSlice.start, pageSlice.end);

    var container = el("div", null, "agg-list");
    pageGroups.forEach(function (g) {
      var card = document.createElement("details");
      card.className = "agg-card";
      if (expandedAggGroups[g.id]) card.open = true;
      card.addEventListener("toggle", function () {
        if (card.open) expandedAggGroups[g.id] = true;
        else delete expandedAggGroups[g.id];
      });

      var summary = document.createElement("summary");
      summary.className = "agg-summary";
      summary.appendChild(svgEl("M7 5l5 5-5 5", "agg-chev"));
      summary.appendChild(el("span", g.id, "agg-id"));

      if (g.enabled >= 2) summary.appendChild(pill("负载均衡 ×" + g.enabled, "accent"));
      else if (g.enabled === 0) summary.appendChild(pill("已全停", "err"));
      else summary.appendChild(pill("单渠道", "ok"));

      var vendorsWrap = el("div", null, "agg-vendors");
      g.items.forEach(function (m) {
        var vName = vendorLabel(m.vendor_id, m.realm);
        var p = pill(vName, vendorChipClass(m.vendor_id, vName) + (m.disabled ? " agg-vendor-off" : ""));
        vendorsWrap.appendChild(p);
      });
      summary.appendChild(vendorsWrap);

      var maxCtx = 0;
      g.items.forEach(function (m) { if ((m.context_length || 0) > maxCtx) maxCtx = m.context_length; });
      summary.appendChild(el("span", (maxCtx ? formatTokens(maxCtx) + " · " : "") + g.items.length + " 条配置", "agg-meta"));
      card.appendChild(summary);

      var body = el("div", null, "agg-body");
      body.appendChild(buildModelsTable(g.items, false, false));
      card.appendChild(body);
      container.appendChild(card);
    });
    host.appendChild(container);
  }

  function renderModels() {
    var host = document.getElementById("models");
    var pagerHost = document.getElementById("modelPager");
    host.textContent = "";
    if (pagerHost) pagerHost.textContent = "";

    var present = {};
    allModels.forEach(function (m) { present[modelKey(m)] = true; });
    Object.keys(selectedModels).forEach(function (k) { if (!present[k]) delete selectedModels[k]; });

    setText("tabBadgeModels", allModels.length ? String(allModels.length) : "");

    var mEnabled = 0, mDisabled = 0, mAliased = 0, mImages = 0, mTools = 0;
    allModels.forEach(function (m) {
      if (m.disabled) mDisabled++; else mEnabled++;
      if (m.alias) mAliased++;
      if (m.supports_images) mImages++;
      if (m.supports_tools) mTools++;
    });
    setText("mKpiValAll", String(allModels.length));
    setText("mKpiValEnabled", String(mEnabled));
    setText("mKpiValDisabled", String(mDisabled));
    setText("mKpiValAliased", String(mAliased));
    setText("mKpiValImages", String(mImages));
    setText("mKpiValTools", String(mTools));

    renderModelVendorRail();

    var vendorScoped = (modelViewMode === "vendor" && modelVendorFilter)
      ? allModels.filter(function (m) { return (m.vendor_id || "_unknown") === modelVendorFilter; })
      : allModels;
    renderModelVendorQuickBar(vendorScoped);

    var filter = (document.getElementById("modelFilter").value || "").trim().toLowerCase();
    var list = vendorScoped.filter(function (m) {
      if (modelQuickFilter === "enabled" && m.disabled) return false;
      if (modelQuickFilter === "disabled" && !m.disabled) return false;
      if (modelQuickFilter === "aliased" && !m.alias) return false;
      if (modelQuickFilter === "images" && !m.supports_images) return false;
      if (modelQuickFilter === "tools" && !m.supports_tools) return false;
      if (!filter) return true;
      var vendor = vendorLabel(m.vendor_id, m.realm);
      var text = (String(m.id || "") + " " + String(m.name || "") + " " + String(m.alias || "") + " " + vendor).toLowerCase();
      return text.indexOf(filter) >= 0;
    });

    function compareDefault(a, b) {
      var statusA = a.disabled ? 1 : 0, statusB = b.disabled ? 1 : 0;
      if (statusA !== statusB) return statusA - statusB;
      var vendorA = vendorLabel(a.vendor_id, a.realm), vendorB = vendorLabel(b.vendor_id, b.realm);
      if (vendorA !== vendorB) return vendorA < vendorB ? -1 : 1;
      var idA = String(a.id || "").replace(/^(cn|global):/, "").toLowerCase();
      var idB = String(b.id || "").replace(/^(cn|global):/, "").toLowerCase();
      return idA < idB ? -1 : (idA > idB ? 1 : 0);
    }

    list.sort(function (a, b) {
      if (creditsSortOrder) {
        var valA = modelCreditValue(a), valB = modelCreditValue(b);
        var hasA = valA !== null, hasB = valB !== null;
        if (hasA && !hasB) return -1;
        if (!hasA && hasB) return 1;
        if (hasA && hasB && valA !== valB) return creditsSortOrder === "asc" ? valA - valB : valB - valA;
      }
      return compareDefault(a, b);
    });

    setText("modelWorkspaceTitle", modelViewMode === "aggregate"
      ? "对外模型路由聚合"
      : (modelVendorFilter ? vendorLabel(modelVendorFilter, "") : "全部模型"));
    var resetModelBtn = document.getElementById("btnResetModelScope");
    if (resetModelBtn) resetModelBtn.hidden = !(modelViewMode === "vendor" && modelVendorFilter);
    setText("modelCount", allModels.length
      ? ("(" + (list.length === allModels.length ? allModels.length : (list.length + " / " + allModels.length)) + ")")
      : "");

    if (!allModels.length) {
      renderEmptyState(host, "暂无模型清单", "正在从上游自动获取模型清单，也可点击左上角「读取模型清单」手动拉取。", "立即读取", function () { refreshModels(false); });
      syncModelSelection();
      return;
    }
    if (!list.length) {
      renderEmptyState(host, "没有匹配的模型", "尝试清空搜索词、切回「全部」筛选或选择其他供应商。", "重置筛选", function () {
        document.getElementById("modelFilter").value = "";
        modelVendorFilter = "";
        setModelQuickFilter("all");
      });
      syncModelSelection();
      return;
    }

    if (modelViewMode === "aggregate") {
      renderAggregatedModels(host, list);
    } else {
      var hideVendor = !!modelVendorFilter;
      var pageSlice = renderPager("modelPager", modelPagerState, list.length, [25, 50, 0], renderModels);
      var pageItems = list.slice(pageSlice.start, pageSlice.end);
      var wrap = el("div", null, "table-wrap");
      wrap.appendChild(buildModelsTable(pageItems, hideVendor, true));
      host.appendChild(wrap);
      bindTableScrollShadows(wrap);
    }
    syncModelSelection();
  }

  // ---- 模型表单元格渲染 ----
  function modelCheckCell(model) {
    var key = modelKey(model);
    var cell = el("td");
    var checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = !!selectedModels[key];
    checkbox.setAttribute("data-model-id", key);
    checkbox.addEventListener("change", function () {
      if (checkbox.checked) selectedModels[key] = true;
      else delete selectedModels[key];
      var tr = checkbox.closest && checkbox.closest("tr");
      if (tr) tr.classList.toggle("is-selected", checkbox.checked);
      syncModelSelection();
    });
    cell.appendChild(checkbox);
    return cell;
  }

  function modelStatusCell(model) {
    var td = el("td");
    var wrap = el("span", null, "model-status-wrap");
    var sw = document.createElement("input");
    sw.type = "checkbox";
    sw.className = "switch sm";
    sw.checked = !model.disabled;
    sw.title = model.disabled ? "点击立即启用此模型" : "点击立即停用此模型";
    sw.setAttribute("aria-label", (model.disabled ? "启用 " : "停用 ") + (model.alias || model.id));
    sw.addEventListener("change", function () {
      var wantDisabled = !sw.checked;
      sw.disabled = true;
      toggleModelIDs([modelKey(model)], wantDisabled).then(function () {
        sw.disabled = false;
      }, function () {
        sw.checked = !model.disabled;
        sw.disabled = false;
      });
    });
    wrap.appendChild(sw);
    td.appendChild(wrap);
    return td;
  }

  function modelVendorCell(model) {
    var vendor = vendorLabel(model.vendor_id, model.realm);
    var p = pill(vendor, vendorChipClass(model.vendor_id, vendor));
    p.style.cursor = "pointer";
    p.title = "点击切换到「" + vendor + "」模型列表";
    p.addEventListener("click", function () {
      modelViewMode = "vendor";
      modelVendorFilter = model.vendor_id || "";
      modelPagerState.page = 1;
      setModelViewMode("vendor");
    });
    return cellWith(p);
  }

  function formatCredits(raw) {
    var str = String(raw || "").trim();
    if (!str) return "";
    var cleaned = str.replace(/\bcredits?\b/ig, "").replace(/^[xX]/, "").replace(/[xX]$/, "").trim();
    var num = parseFloat(cleaned);
    if (!isNaN(num) && isFinite(num) && /^[0-9]+(\.[0-9]+)?$/.test(cleaned) && num >= 0) {
      return num.toFixed(2) + "X";
    }
    return str;
  }

  function modelCreditsCell(model) {
    var credits = formatCredits(model.credits);
    if (!credits) return el("td", "—", "muted");
    var cell = el("td", credits, "mono");
    cell.title = "上游计费倍率：" + credits;
    return cell;
  }

  var modelAliasSaveVersions = {};

  function modelIDCell(model) {
    var bareID = String(model.id || "");
    var key = String(model.scope_id || model.id);
    return editableCell({
      saved: model.alias || "",
      fallback: function () { return bareID; },
      prefill: function () { return bareID; },
      placeholder: bareID,
      mono: true,
      title: function (saved) {
        return saved
          ? "点击编辑对外模型 ID（留空恢复官方 ID：" + bareID + "）"
          : "点击编辑对外模型 ID（留空即用官方 ID：" + bareID + "）";
      },
      save: function (next) {
        var version = (modelAliasSaveVersions[key] || 0) + 1;
        modelAliasSaveVersions[key] = version;
        function notify(kind, message, duration) {
          if (modelAliasSaveVersions[key] === version) banner(kind, message, duration);
        }
        return api("POST", "/models/alias", { model: key, alias: next }).then(function (data) {
          if (!data) return false;
          var savedAlias = typeof data.alias === "string" ? data.alias : next;
          model.alias = savedAlias;
          notify("ok", "别名已保存，正在同步 CPA 模型列表：" + (savedAlias || bareID), 0);
          return syncModelConfig().then(function (synced) {
            if (!synced) {
              notify("warn", "别名已保存，但 CPA 模型列表同步失败，请重试或重新打开插件页面。", 0);
              return { value: savedAlias };
            }
            return verifyModelAlias(model, savedAlias, 0).then(function (effectiveID) {
              if (effectiveID) notify("ok", "别名已保存并生效：" + bareID + " → " + effectiveID, 8000);
              else notify("warn", "别名已保存；" + (model.disabled ? "模型当前已禁用" : "该供应商暂无已启用账号") + "，启用后才能核对生效。", 0);
              return { value: savedAlias };
            }).catch(function (err) {
              notify("warn", "别名已保存，但生效核对未通过：" + err.message, 0);
              return { value: savedAlias };
            });
          });
        });
      }
    });
  }

  function verifyModelAlias(model, alias, attempt) {
    return api("GET", "/status").then(function (status) {
      if (!status) throw new Error("管理连接未确认，请重新连接后核对。");
      var accounts = (status.accounts || []).filter(function (account) {
        return account.vendor_id === model.vendor_id && !account.disabled && (account.auth_id || account.file_id);
      });
      if (model.disabled || !accounts.length) return null;
      var expected = alias || model.id;
      var tag = (status.settings || {}).model_name_tag;
      if (!alias && (tag === "prefix" || tag === "suffix")) {
        var tagged = tag === "prefix" ? model.vendor_id + "-" + model.id : model.id + "-" + model.vendor_id;
        var collision = allModels.some(function (item) {
          return item.vendor_id === model.vendor_id && String(item.id).toLowerCase() === tagged.toLowerCase();
        });
        if (!collision) expected = tagged;
      }
      return Promise.all(accounts.map(function (account) {
        return api("GET", hostPath("/auth-files/models?name=" + encodeURIComponent(account.auth_id || account.file_id)));
      })).then(function (results) {
        var registered = !status.restart_pending && results.some(function (result) {
          return result && (result.models || []).some(function (item) { return item.id === expected; });
        });
        if (registered) return expected;
        if (attempt >= 5) throw new Error("CPA 尚未注册模型「" + expected + "」，请检查账号状态或稍后重试。");
        return new Promise(function (resolve) { setTimeout(resolve, 500); }).then(function () {
          return verifyModelAlias(model, alias, attempt + 1);
        });
      });
    });
  }

  function parseContextTokens(value) {
    var text = String(value || "").trim();
    if (!text) return 0;
    var match = /^(\d+(?:\.\d+)?)\s*([KM]?)$/i.exec(text);
    if (!match) throw new Error("请输入 token 数、400K 或 1M；留空恢复自动值");
    var scale = { "": 1, K: 1000, M: 1000000 }[match[2].toUpperCase()];
    var tokens = Number(match[1]) * scale;
    if (!Number.isSafeInteger(tokens) || tokens < 0 || tokens > 100000000) {
      throw new Error("上下文必须是 0 到 100000000 之间的整数 token 数");
    }
    return tokens;
  }

  function modelContextCell(model) {
    var automatic = typeof model.upstream_context_length === "number"
      ? model.upstream_context_length : (Number(model.context_length) || 0);
    var key = String(model.scope_id || model.id);
    if (model.context_locked) {
      var cell = el("td", formatTokens(Number(model.context_length) || automatic) + " · 固定", "mono");
      cell.title = "该平台上下文由插件固定，不支持修改";
      return cell;
    }
    return editableCell({
      saved: model.context_override ? String(model.context_override) : "",
      fallback: function () { return automatic ? formatTokens(automatic) + " · 自动" : "—"; },
      prefill: function () { return automatic ? String(automatic) : ""; },
      display: function (saved) { return formatTokens(parseContextTokens(saved)) + " · 自定义"; },
      placeholder: "token 数 / 400K / 1M，留空自动",
      mono: true,
      selectAll: true,
      title: function () {
        return "点击编辑上下文（token 数、400K、1M）；留空恢复自动值 "
          + (automatic || "未知") + "。自定义值仍受供应商实际限制。";
      },
      save: function (next) {
        var tokens = parseContextTokens(next);
        return api("POST", "/models/context", { model: key, context_length: tokens }).then(function (data) {
          if (!data || !data.ok) return false;
          model.context_override = data.context_override || 0;
          model.context_length = data.context_length || automatic;
          syncModelConfig();
          return true;
        });
      }
    });
  }

  // selectedModelIDs 取当前勾选的模型（跨分页持久勾选 + DOM 兜底）。
  function selectedModelIDs() {
    var set = {};
    Object.keys(selectedModels).forEach(function (id) { set[id] = true; });
    Array.prototype.forEach.call(
      document.querySelectorAll("#models input[type=checkbox][data-model-id]"),
      function (box) {
        var id = box.getAttribute("data-model-id");
        if (box.checked) set[id] = true;
      });
    return Object.keys(set);
  }

  function toggleModelIDs(ids, disabled) {
    if (!ids || !ids.length) { banner("err", "请先勾选模型"); return Promise.resolve(); }
    var verb = disabled ? "停用" : "启用";
    return api("POST", "/models/toggle", { models: ids, disabled: disabled }).then(function (data) {
      if (!data) return;
      banner("ok", "已" + verb + " " + (data.changed || ids.length) + " 个模型，正在同步到宿主…");
      syncModelConfig();
      loadModels(false);
    }).catch(function (err) { banner("err", err.message); throw err; });
  }

  function toggleModels(disabled) {
    toggleModelIDs(selectedModelIDs(), disabled).catch(function () { });
  }

  var MODEL_SYNC_DEBOUNCE_MS = 400;
  var modelSyncTimer = null;
  var modelSyncRunning = false;
  var modelSyncWaiters = [];
  var modelSyncSelfHealed = false;

  function syncModelConfig() {
    var result = new Promise(function (resolve) { modelSyncWaiters.push(resolve); });
    if (modelSyncTimer) { clearTimeout(modelSyncTimer); }
    modelSyncTimer = setTimeout(runModelSync, MODEL_SYNC_DEBOUNCE_MS);
    return result;
  }

  function runModelSync() {
    modelSyncTimer = null;
    if (modelSyncRunning) return;
    modelSyncRunning = true;
    var waiters = modelSyncWaiters;
    modelSyncWaiters = [];
    var body = { config_reloaded_at: new Date().toISOString() };
    var configPath = "/config" + BASE.replace(/^\/plugins\//, "/plugins/configs/");
    api("PATCH", hostPath(configPath, 8), body).catch(function (err) {
      if (err.status !== 404 && err.status !== 405) throw err;
      return api("PATCH", hostPath(BASE + "/config"), body);
    }).then(function (result) {
      if (!result || result.status !== "ok") throw new Error("CPA 未确认重载配置");
      loadModels(false);
      return true;
    }).catch(function (err) {
      banner("err", "模型列表同步失败：" + err.message
        + "（可再操作一次重试；宿主版本过老时需手动重启一次）");
      return false;
    }).then(function (synced) {
      modelSyncRunning = false;
      waiters.forEach(function (resolve) { resolve(synced); });
      if (modelSyncWaiters.length && !modelSyncTimer) {
        modelSyncTimer = setTimeout(runModelSync, MODEL_SYNC_DEBOUNCE_MS);
      }
    });
  }

  // formatTokens 把 token 数格式化为可读串。
  function formatTokens(value) {
    var n = Number(value) || 0;
    if (n >= 1000000) return Number((n / 1000000).toFixed(2)) + "M";
    if (n >= 1000) return Number((n / 1000).toFixed(2)) + "K";
    return String(n);
  }

  // modelsLoaded 标记是否已尝试过拉取，避免自动刷新与手动刷新互相触发。
  var modelsLoaded = false;
  var modelsPollLeft = 2;

  function loadModels(autoRefresh) {
    return api("GET", "/models").then(function (data) {
      if (!data) return;
      allModels = (data && data.models) || [];
      renderModels();
      if (data && data.pending_probes && modelsPollLeft > 0) {
        modelsPollLeft--;
        setTimeout(function () { loadModels(false); }, 3000);
        return;
      }
      if (allModels.length || !autoRefresh || modelsLoaded) return;
      modelsLoaded = true;
      refreshModels(true);
    }).catch(function (err) { banner("err", err.message); });
  }

  function refreshModels(quiet) {
    var btn = document.getElementById("btnLoadModels");
    if (btn) btn.disabled = true;
    modelsLoaded = true;
    modelsPollLeft = 2;
    if (!quiet) banner("ok", "正在从上游拉取模型清单…", 0);
    return api("POST", "/models/refresh", {}).then(function (data) {
      if (!data) return;
      var count = data.models || 0;
      if (!quiet) {
        banner(count ? "ok" : "warn",
          count ? ("已从上游拉取 " + count + " 个模型") : "上游返回 0 个模型，请查看运行日志", 6000);
      }
      return loadModels(false);
    }).catch(function (err) {
      if (!quiet) banner("err", "从上游刷新失败：" + err.message, 10000);
    }).then(function () { if (btn) btn.disabled = false; });
  }
