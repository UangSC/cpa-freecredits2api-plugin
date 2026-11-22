  // ---- 管理密钥弹窗验证（支持记住密钥、显隐切换、回车提交与一键复用面板密钥） ----
  function setKeySubmitBusy(busy) {
    var btn = document.getElementById("btnUseKey");
    if (!btn) return;
    btn.disabled = !!busy;
    var lbl = btn.querySelector(".btn-label");
    if (lbl) lbl.textContent = busy ? "正在验证…" : "验证并进入面板";
  }

  function submitManagementKey(value, remember) {
    if (keyBusy) return;
    if (Date.now() < keyRetryAfter) {
      var waitSec = Math.max(1, Math.ceil((keyRetryAfter - Date.now()) / 1000));
      setKeyStatus("密钥刚验证失败，请等待 " + waitSec + " 秒后再试（防触发 CPA IP 限流）", "warn");
      banner("warn", "密钥刚验证失败，请稍候 " + waitSec + " 秒再试。");
      return;
    }
    if (!value) {
      setKeyStatus("请先输入管理密钥", "warn");
      banner("err", "请先填入管理密钥");
      return;
    }
    if (!KEY_RE.test(value)) {
      setKeyStatus("管理密钥只能包含可见 ASCII 字符", "err");
      banner("err", "管理密钥只能包含可见 ASCII 字符");
      return;
    }

    keyBusy = true;
    manualKey = value;
    stopped = false;
    authReady = false;
    setKeySubmitBusy(true);
    setKeyStatus("正在连接并验证管理密钥…", "checking");
    probeManagementAuth().then(function (ok) {
      keyBusy = false;
      setKeySubmitBusy(false);
      if (!ok) {
        manualKey = "";
        keyRetryAfter = Date.now() + 10000;
        revealKeyInput();
        setKeyStatus("密钥验证未通过，请核对后重试（已启用 10 秒冷却保护）", "err");
        if (!stopped) banner("err", "密钥验证失败：请求未能通过 CPA 鉴权。");
        return;
      }
      saveRememberedKey(value, !!remember);
      authReady = true;
      var input = document.getElementById("keyInput");
      if (input) input.value = "";
      hideKeyInput();
      setKeyStatus("已通过管理密钥验证", "ok");
      clearBanner();
      startConsole();
    }).catch(function (err) {
      keyBusy = false;
      setKeySubmitBusy(false);
      manualKey = "";
      revealKeyInput();
      setKeyStatus("无法连接插件管理接口：" + (err && err.message ? err.message : "请求异常"), "err");
      banner("err", err && err.message ? err.message : "无法连接插件管理接口");
    });
  }

  document.getElementById("btnUseKey").addEventListener("click", function () {
    var input = document.getElementById("keyInput");
    var rememberBox = document.getElementById("chkRememberKey");
    submitManagementKey((input && input.value || "").trim(), rememberBox ? !!rememberBox.checked : true);
  });

  document.getElementById("keyInput").addEventListener("keydown", function (event) {
    if (event.key === "Enter") {
      event.preventDefault();
      document.getElementById("btnUseKey").click();
    }
  });

  document.getElementById("btnToggleKeyVis").addEventListener("click", function () {
    var input = document.getElementById("keyInput");
    if (!input) return;
    var showing = input.type === "text";
    input.type = showing ? "password" : "text";
    this.setAttribute("aria-pressed", showing ? "false" : "true");
    input.focus();
  });

  document.getElementById("btnReusePanelKey").addEventListener("click", function () {
    var key = panelAuthKey();
    if (!key) {
      setKeyStatus("未检测到 CPA 主面板已登录密钥，请手动输入", "warn");
      this.hidden = true;
      return;
    }
    var rememberBox = document.getElementById("chkRememberKey");
    submitManagementKey(key, rememberBox ? !!rememberBox.checked : false);
  });

  // ---- 添加账号（OAuth / 滑块 / 短信 / API Key / 凭证导入 / 墨点授权） ----
  var loginTimer = null;
  var loginPollGeneration = 0;

  function stopLoginPolling() {
    loginPollGeneration++;
    if (loginTimer) { clearInterval(loginTimer); loginTimer = null; }
  }

  var currentApiKeyVendor = null;
  var currentAccountInputMode = "api_key";
  var currentLoginVendor = null;
  var accountAddGeneration = 0;
  var currentLoginState = "";

  // ---- 授权表单中的可选余额绑定 ----
  var quotaCredentialAccount = null;
  var quotaCredentialGeneration = 0;
  function closeQuotaCredential() {
    quotaCredentialGeneration++;
    document.getElementById("inputQuotaCredential").value = "";
    document.getElementById("quotaAuthorizationUrl").value = "";
    var link = document.getElementById("quotaAuthorizationLink");
    link.hidden = true;
    link.removeAttribute("href");
    document.getElementById("btnCopyQuotaAuthorizationUrl").disabled = true;
    document.getElementById("btnQuotaAuthorizationGenerate").disabled = false;
  }
  function generateQuotaAuthorization() {
    if (!currentApiKeyVendor || !currentApiKeyVendor.quota_authorization) return;
    var account = quotaCredentialAccount;
    var apiKey = (document.getElementById("inputApiKey").value || "").trim();
    if (!account && !apiKey) { banner("err", "请先填写完整 API Key"); return; }
    closeQuotaCredential();
    var generation = quotaCredentialGeneration;
    document.getElementById("btnQuotaAuthorizationGenerate").disabled = true;
    document.getElementById("quotaCredentialHint").textContent = "正在生成授权地址…";
    var body = account ? { account_id: accountKey(account) } : { vendor: currentApiKeyVendor.id, api_key: apiKey };
    api("POST", "/accounts/quota-auth/start", body).then(function (result) {
      if (generation !== quotaCredentialGeneration) return;
      if (!result || !result.ok) throw new Error((result && result.error) || "无法获取授权地址");
      document.getElementById("quotaAuthorizationUrl").value = result.url;
      var link = document.getElementById("quotaAuthorizationLink");
      link.href = result.url;
      link.hidden = false;
      document.getElementById("btnCopyQuotaAuthorizationUrl").disabled = false;
      document.getElementById("btnQuotaAuthorizationGenerate").disabled = false;
      document.getElementById("quotaCredentialHint").textContent = "打开授权地址登录，再粘贴完整回调网址。授权地址 15 分钟内有效；可改用余额请求 cURL。";
    }).catch(function (error) {
      if (generation !== quotaCredentialGeneration) return;
      document.getElementById("btnQuotaAuthorizationGenerate").disabled = false;
      document.getElementById("quotaCredentialHint").textContent = error.message + "；也可粘贴已登录余额页的 cURL";
    });
  }
  function openQuotaCredential(account) {
    if (!account || account.disabled) { banner("err", "请先启用该账号再完成授权"); return; }
    var vendor = vendorsById[account.vendor_id];
    if (!vendor || !vendor.quota_credential_hint) return;
    startAccountCredentialInput(vendor, "api_key", account);
    generateQuotaAuthorization();
  }
  function submitExistingQuotaCredential() {
    var account = quotaCredentialAccount;
    var input = document.getElementById("inputQuotaCredential").value.trim();
    if (!input) { banner("err", "请粘贴授权回调或余额 cURL"); return; }
    var generation = accountAddGeneration;
    var accountID = accountKey(account);
    var btn = document.getElementById("btnSubmitApiKey");
    btn.disabled = true;
    btn.textContent = "保存中…";
    api("POST", "/accounts/quota-credential", { account_id: accountID, credential_curl: input }).then(function (result) {
      if (generation !== accountAddGeneration) return;
      if (!result || !result.ok) throw new Error((result && result.error) || "绑定失败");
      resetAccountAddFlow();
      banner("ok", "当前账号授权已更新");
      return loadQuotas(true, [accountID]);
    }).catch(function (error) {
      if (generation !== accountAddGeneration) return;
      btn.disabled = false;
      btn.textContent = "完成授权";
      banner("err", error.message);
    });
  }
  document.getElementById("btnQuotaAuthorizationGenerate").addEventListener("click", generateQuotaAuthorization);
  document.getElementById("btnCopyQuotaAuthorizationUrl").addEventListener("click", function () {
    var value = document.getElementById("quotaAuthorizationUrl").value;
    if (!value) return;
    navigator.clipboard.writeText(value).then(function () { banner("ok", "授权地址已复制"); }).catch(function () { banner("warn", "可选中授权地址输入框手动复制"); });
  });
  document.getElementById("inputApiKey").addEventListener("input", function () {
    if (currentApiKeyVendor && currentApiKeyVendor.quota_credential_hint) {
      closeQuotaCredential();
      document.getElementById("quotaCredentialHint").textContent = "Key 已更新，请重新生成授权地址或粘贴此账号的余额 cURL。";
    }
  });

  function supportsCredentialImport(vendor) {
    return !!vendor && (vendor.credential_import === true || vendor.id === "autoclawglobal");
  }

  function resetAccountAddFlow() {
    accountAddGeneration++;
    closeQuotaCredential();
    quotaCredentialAccount = null;
    stopLoginPolling();
    resetLoginCaptcha();
    currentApiKeyVendor = null;
    currentAccountInputMode = "api_key";
    currentLoginVendor = null;
    currentLoginState = "";
    currentSmsVendor = null;
    smsSessionKey = "";
    ["inputApiKey", "inputApiLabel", "loginUrl", "loginPasteUrl", "inputSmsPhone", "inputSmsCode", "inputSmsLabel"].forEach(function (id) {
      var field = document.getElementById(id);
      if (field) field.value = "";
    });
    ["loginBox", "apiKeyBox", "smsBox", "quotaCredentialBox", "loginCredentialRow", "loginPasteBox", "loginPasteRedirect"].forEach(function (id) {
      var box = document.getElementById(id);
      if (box) { box.hidden = true; if (id === "loginBox" || id === "apiKeyBox") box.style.display = ""; }
    });
    ["loginStatus", "loginPasteStatus", "smsStatus"].forEach(function (id) {
      var status = document.getElementById(id);
      if (status) status.textContent = "";
    });
    var redirect = document.getElementById("loginPasteRedirect");
    if (redirect) redirect.removeAttribute("href");
    var toggle = document.getElementById("btnToggleCredentialMode");
    if (toggle) toggle.hidden = true;
    [["btnSubmitApiKey", "保存账号"], ["btnSmsSend", "发送验证码"], ["btnSmsVerify", "登录并添加"], ["btnSubmitCallback", "提交回调链接"]].forEach(function (entry) {
      var button = document.getElementById(entry[0]);
      if (button) { button.disabled = false; button.textContent = entry[1]; }
    });
  }

  function setupCredentialImportFallback(vendor) {
    currentLoginVendor = vendor;
    var row = document.getElementById("loginCredentialRow");
    if (row) row.hidden = !supportsCredentialImport(vendor);
  }

  function startVendorAdd(vendor) {
    if (!vendor) return;
    resetAccountAddFlow();

    if (vendor && vendor.login_captcha) {
      startCaptchaLogin(vendor);
      return;
    }
    if (vendor.supports_login !== false && vendor.auth_mode !== "apikey") {
      startLogin(vendor);
      return;
    }
    if (vendor.auth_mode !== "apikey" && supportsCredentialImport(vendor)) {
      startCredentialPaste(vendor);
      return;
    }
    if (vendor.id === "autoclawglobal") startCredentialPaste(vendor);
    else startAccountCredentialInput(vendor, "api_key");
  }

  function startCredentialPaste(vendor) {
    if (!supportsCredentialImport(vendor)) return;
    startAccountCredentialInput(vendor, "credential_json");
  }

  function startAccountCredentialInput(vendor, mode, account) {
    resetAccountAddFlow();
    currentApiKeyVendor = vendor;
    currentAccountInputMode = mode;
    quotaCredentialAccount = account || null;
    var apiKeyBox = document.getElementById("apiKeyBox");
    if (!apiKeyBox) return;
    apiKeyBox.hidden = false;
    apiKeyBox.style.display = "flex";
    document.getElementById("apiKeyFields").hidden = !!account;
    var importing = mode === "credential_json";
    var quotaBinding = !importing && !!vendor.quota_credential_hint;
    document.getElementById("quotaCredentialBox").hidden = !quotaBinding;
    document.getElementById("btnQuotaAuthorizationGenerate").hidden = !vendor.quota_authorization;
    document.getElementById("quotaCredentialHint").textContent = vendor.quota_credential_hint || "";
    document.getElementById("btnSubmitApiKey").textContent = quotaBinding ? "完成授权" : "保存账号";
    document.getElementById("apiKeyTitle").textContent = quotaBinding ? "完成授权 · " + vendor.name : (importing ? "粘贴 " : "添加 ") + vendor.name + (importing ? " 凭证" : " 账号");
    var hint = (vendor.credential_import_hint || "").trim();
    if (!hint && vendor.id === "autoclawglobal") hint = "粘贴 AutoClaw 国际版凭证 JSON（含访问令牌与刷新令牌，可从 AutoClaw 桌面端登录态文件或 Agent2API 获取）。保存后插件会自动续期。";
    document.getElementById("apiKeyHint").textContent = importing
      ? hint || "粘贴该供应商的登录凭证 JSON，插件校验后会保存账号。"
      : quotaBinding ? "输入完整模型 API Key；可在下方一同完成墨点授权，确认后保存账号。" : "请输入从官网申请的 API Key，确认后保存账号。";
    var input = document.getElementById("inputApiKey");
    input.hidden = false;
    if (account) document.getElementById("apiKeyHint").textContent = "正在为 " + accountDisplay(account) + " 更新墨点授权；继续使用此账号已保存的模型 Key。";
    input.placeholder = importing ? "粘贴凭证 JSON（必填）" : "输入 API Key（必填）";
    var toggle = document.getElementById("btnToggleCredentialMode");
    if (toggle) {
      toggle.hidden = !supportsCredentialImport(vendor) || vendor.auth_mode !== "apikey" || vendor.id === "autoclawglobal";
      toggle.textContent = importing ? "改用 API Key" : "粘贴凭证";
    }
    (account ? document.getElementById("inputQuotaCredential") : input).focus();
  }

  var loginVariantButtons = [];
  var loginCaptchaFlow = null;
  var loginCaptchaGeneration = 0;

  function startCaptchaLogin(vendor) {
    resetAccountAddFlow();
    setupCredentialImportFallback(vendor);
    var login = document.getElementById("loginBox");
    var sms = document.getElementById("smsBox");
    var apiKey = document.getElementById("apiKeyBox");
    if (sms) sms.hidden = true;
    if (apiKey) apiKey.hidden = true;
    if (!login) return;
    login.hidden = false;
    document.getElementById("loginTitle").textContent = "添加 " + vendor.name + " 账号（网页登录）";
    document.getElementById("loginUrl").value = "";
    var pasteBox = document.getElementById("loginPasteBox");
    if (pasteBox) pasteBox.hidden = true;

    var status = document.getElementById("loginStatus");
    status.textContent = "先选择登录方式；点按钮后会弹出阿里云人机验证（官方要求的风控步骤）。";

    var row = document.getElementById("loginVariantRow");
    row.textContent = "";
    row.hidden = false;
    row.style.display = "flex";
    loginVariantButtons = [];
    var variants = (vendor && vendor.login_variants) || [{ id: "google", label: "Google" }];
    variants.forEach(function (variant) {
      var btn = el("button", "使用 " + variant.label + " 登录", "act primary");
      btn.type = "button";
      btn.addEventListener("click", function () { beginCaptchaLogin(vendor, variant); });
      row.appendChild(btn);
      loginVariantButtons.push(btn);
    });
  }

  function setLoginVariantBusy(busy) {
    loginVariantButtons.forEach(function (btn) { btn.disabled = busy; });
  }

  function beginCaptchaLogin(vendor, variant) {
    var generation = accountAddGeneration;
    var status = document.getElementById("loginStatus");
    setLoginVariantBusy(true);
    status.textContent = "正在准备人机验证…";
    resetLoginCaptcha();
    api("GET", "/login/captcha-config?vendor=" + encodeURIComponent(vendor.id)).then(function (data) {
      if (generation !== accountAddGeneration || currentLoginVendor !== vendor) return;
      if (!data || !data.ok) throw new Error((data && data.message) || "获取风控验证配置失败");
      var config = data.captcha || {};
      if (!config.enabled) throw new Error("上游没有开启网页登录，请改用「粘贴凭证」");
      if (!config.scene_id || !config.prefix) throw new Error("上游返回的风控配置不完整，请稍后重试");
      status.textContent = "请在弹出的滑块中完成验证（官方要求的风控步骤）。";
      return runLoginCaptcha(config, function (verifyParam) {
        return requestLoginURL(vendor, variant, verifyParam);
      });
    }).catch(function (err) {
      if (generation !== accountAddGeneration || currentLoginVendor !== vendor) return;
      status.textContent = "登录失败：" + ((err && err.message) || err);
      resetLoginCaptcha();
      setLoginVariantBusy(false);
    });
  }

  function requestLoginURL(vendor, variant, verifyParam) {
    var generation = accountAddGeneration;
    var status = document.getElementById("loginStatus");
    status.textContent = "人机验证通过，正在获取授权链接…";
    return api("POST", "/login/start", {
      vendor_id: vendor.id,
      metadata: { oauth_variant: variant.id, ali_captcha_verify_param: verifyParam }
    }).then(function (data) {
      if (generation !== accountAddGeneration || currentLoginVendor !== vendor) return false;
      if (!data || !data.ok) throw new Error((data && data.message) || "获取授权链接失败");
      if (!data.url) throw new Error("上游没有返回授权链接，请重试");
      currentLoginState = data.state || "";
      document.getElementById("loginUrl").value = data.url;
      var hint = data.callback_hint || variant.callback_hint || "";
      var pasteBox = document.getElementById("loginPasteBox");
      if (pasteBox) pasteBox.hidden = false;
      document.getElementById("loginPasteHint").textContent =
        "登录完成后浏览器会停在 " + (hint || "http://localhost/ 的回调地址") +
        "。远程 / Docker 部署下这个地址打不开是正常的，把地址栏里的整条链接复制后粘贴到下面提交。";
      document.getElementById("loginPasteUrl").value = "";
      document.getElementById("loginPasteStatus").textContent = "";
      document.getElementById("btnSubmitCallback").disabled = false;
      status.textContent = "请打开下面的链接完成 " + variant.label + " 登录。";
      setLoginVariantBusy(false);
      return true;
    }).catch(function (err) {
      if (generation !== accountAddGeneration || currentLoginVendor !== vendor) return false;
      status.textContent = "获取授权链接失败：" + ((err && err.message) || err);
      throw err;
    });
  }

  function runLoginCaptcha(config, onVerify) {
    resetLoginCaptcha();
    var generation = ++loginCaptchaGeneration;
    var holder = document.getElementById("loginCaptcha");
    holder.textContent = "";
    holder.hidden = false;

    var element = document.createElement("div");
    element.id = "login-captcha-element-" + generation;
    holder.appendChild(element);

    var trigger = document.createElement("button");
    trigger.id = "login-captcha-trigger-" + generation;
    trigger.type = "button";
    trigger.setAttribute("aria-hidden", "true");
    trigger.style.position = "fixed";
    trigger.style.width = "1px";
    trigger.style.height = "1px";
    trigger.style.opacity = "0";
    trigger.style.pointerEvents = "none";
    holder.appendChild(trigger);

    var flow = { generation: generation, instance: null, element: element, button: trigger, timer: 0, verified: false };
    loginCaptchaFlow = flow;

    window.AliyunCaptchaConfig = { region: config.region || "ga", prefix: config.prefix };
    return loadAliyunSdk().then(function () {
      if (generation !== loginCaptchaGeneration) return null;
      return new Promise(function (resolve, reject) {
        var settled = false;
        function settle(fn) {
          if (settled) return false;
          settled = true;
          if (flow.timer) { clearTimeout(flow.timer); flow.timer = 0; }
          fn();
          return true;
        }
        flow.timer = setTimeout(function () {
          settle(function () { reject(new Error("验证码组件初始化超时，请重试")); });
        }, 40000);
        try {
          window.initAliyunCaptcha({
            SceneId: config.scene_id,
            mode: "popup",
            language: "zh-CN",
            element: "#" + element.id,
            button: "#" + trigger.id,
            slideStyle: { width: 360, height: 40 },
            getInstance: function (inst) {
              if (generation !== loginCaptchaGeneration) {
                try { if (inst && inst.destroy) inst.destroy(); } catch (e) { /* 忽略 */ }
                return;
              }
              flow.instance = inst;
              settle(resolve);
            },
            captchaVerifyCallback: function (param) {
              if (generation !== loginCaptchaGeneration) return { captchaResult: false, bizResult: false };
              var value = captchaParamText(param);
              if (!value) return { captchaResult: false, bizResult: false };
              return Promise.resolve(onVerify(value)).then(function (ok) {
                if (ok) flow.verified = true;
                return { captchaResult: !!ok, bizResult: !!ok };
              }).catch(function () {
                return { captchaResult: false, bizResult: false };
              });
            },
            onError: function (err) {
              if (!flow.instance) {
                settle(function () { reject(new Error((err && err.message) || "验证码组件不可用，请重试")); });
              }
            }
          });
        } catch (err) {
          settle(function () { reject(err); });
        }
      });
    }).then(function (ready) {
      if (ready === null || generation !== loginCaptchaGeneration) return;
      return new Promise(function (resolve) { setTimeout(resolve, 2100); });
    }).then(function () {
      if (generation !== loginCaptchaGeneration) return;
      trigger.click();
      setTimeout(function () {
        if (generation !== loginCaptchaGeneration || flow.verified) return;
        document.getElementById("loginStatus").textContent = "验证码等待超时，请重新点击登录再试一次";
        resetLoginCaptcha();
        setLoginVariantBusy(false);
      }, 120000);
    });
  }

  function clearLoginVariants() {
    var row = document.getElementById("loginVariantRow");
    if (row) {
      row.textContent = "";
      row.hidden = true;
      row.style.display = "none";
    }
    loginVariantButtons = [];
  }

  function resetLoginCaptcha() {
    var flow = loginCaptchaFlow;
    loginCaptchaFlow = null;
    loginCaptchaGeneration++;
    if (flow) {
      if (flow.timer) clearTimeout(flow.timer);
      if (flow.instance && typeof flow.instance.destroy === "function") {
        try { flow.instance.destroy(); } catch (e) { /* 忽略 */ }
      }
      if (flow.element && flow.element.parentNode) flow.element.parentNode.removeChild(flow.element);
      if (flow.button && flow.button.parentNode) flow.button.parentNode.removeChild(flow.button);
    }
    var holder = document.getElementById("loginCaptcha");
    if (holder) { holder.textContent = ""; holder.hidden = true; }
    clearLoginVariants();
  }

  function captchaParamText(param) {
    if (typeof param === "string") return param;
    if (param && typeof param.captchaVerifyParam === "string") return param.captchaVerifyParam;
    if (param && typeof param.verifyParam === "string") return param.verifyParam;
    return "";
  }

  var currentSmsVendor = null;
  var smsSessionKey = "";

  function startSmsLogin(vendor) {
    resetAccountAddFlow();
    currentSmsVendor = vendor;
    smsSessionKey = "";
    var box = document.getElementById("smsBox");
    var login = document.getElementById("loginBox");
    var apiKey = document.getElementById("apiKeyBox");
    if (login) login.hidden = true;
    if (apiKey) apiKey.hidden = true;
    box.hidden = false;
    document.getElementById("smsTitle").textContent = "添加 " + vendor.name + " 账号（手机验证码登录）";
    document.getElementById("inputSmsPhone").value = "";
    document.getElementById("inputSmsCode").value = "";
    document.getElementById("inputSmsLabel").value = "";
    document.getElementById("smsStatus").textContent = "输入手机号获取验证码。";
    document.getElementById("inputSmsPhone").focus();
  }

  function startLogin(vendor) {
    if (vendor && vendor.sms_login) { startSmsLogin(vendor); return; }
    resetAccountAddFlow();
    setupCredentialImportFallback(vendor);
    var generation = accountAddGeneration;
    var smsBox = document.getElementById("smsBox");
    if (smsBox) smsBox.hidden = true;
    var apiKey = document.getElementById("apiKeyBox");
    if (apiKey) apiKey.hidden = true;
    currentSmsVendor = null;
    stopLoginPolling();
    currentLoginState = "";
    var box = document.getElementById("loginBox");
    document.getElementById("loginTitle").textContent = "完成授权" + (vendor && vendor.name ? " · " + vendor.name : "");
    var urlField = document.getElementById("loginUrl");
    var status = document.getElementById("loginStatus");
    var pasteBox = document.getElementById("loginPasteBox");
    box.hidden = false;
    urlField.value = "";
    status.textContent = "正在获取授权链接…";

    var canPaste = !!(vendor && vendor.paste_callback);
    pasteBox.hidden = !canPaste;
    document.getElementById("loginPasteRedirect").hidden = true;
    if (canPaste) {
      var hint = ((vendor && vendor.callback_hint) || "").trim() || "http://127.0.0.1/";
      document.getElementById("loginPasteHint").textContent =
        "上游只认本机回调地址 " + hint +
        "。与插件同一台机器时直接点「打开链接」即可；远程 / Docker 部署时浏览器会停在该地址上，" +
        "把地址栏里的整条链接复制后粘贴到下面提交。";
      document.getElementById("loginPasteUrl").value = "";
      document.getElementById("loginPasteStatus").textContent = "";
      document.getElementById("btnSubmitCallback").disabled = false;
    }

    api("GET", hostPath("/freetier-auth-url?vendor=" + encodeURIComponent(vendor.id))).then(function (data) {
      if (generation !== accountAddGeneration || currentLoginVendor !== vendor) return;
      if (!data || !data.url) {
        status.textContent = "获取授权链接失败：" + ((data && data.error) || "响应缺少 url");
        return;
      }
      urlField.value = data.url;
      status.textContent = "请打开下面的链接完成授权，页面会自动检测结果。";
      var state = data.state || "";
      currentLoginState = state;
      if (state) pollLogin(state);
    }).catch(function (err) {
      if (generation !== accountAddGeneration || currentLoginVendor !== vendor) return;
      status.textContent = "获取授权链接失败：" + err.message;
    });
  }

  function pollLogin(state) {
    stopLoginPolling();
    var generation = accountAddGeneration;
    var pollGeneration = loginPollGeneration;
    var status = document.getElementById("loginStatus");
    var attempts = 0;
    var busy = false;
    loginTimer = setInterval(function () {
      if (generation !== accountAddGeneration || pollGeneration !== loginPollGeneration || state !== currentLoginState || busy) return;
      attempts++;
      if (attempts > 150) {
        stopLoginPolling();
        status.textContent = "授权超时，请重新发起登录。";
        return;
      }
      busy = true;
      api("GET", hostPath("/get-auth-status?state=" + encodeURIComponent(state))).then(function (data) {
        busy = false;
        if (generation !== accountAddGeneration || pollGeneration !== loginPollGeneration || state !== currentLoginState) return;
        var value = (data && data.status) || "";
        if (value === "ok") {
          stopLoginPolling();
          currentLoginState = "";
          status.textContent = "授权成功，账号已写入 CPA。";
          banner("ok", "账号添加成功，正在查询该账号额度…");
          loadQuotas(true);
          return;
        }
        if (value === "error") {
          stopLoginPolling();
          status.textContent = "授权失败：" + ((data && data.error) || "未知原因");
          return;
        }
        status.textContent = "等待授权中…（已等待 " + attempts * 2 + " 秒）";
      }).catch(function (err) {
        busy = false;
        if (generation !== accountAddGeneration || pollGeneration !== loginPollGeneration || state !== currentLoginState) return;
        stopLoginPolling();
        status.textContent = "轮询失败：" + err.message;
      });
    }, 2000);
  }

  document.getElementById("btnAddAccount").addEventListener("click", function (event) {
    event.stopPropagation();
    toggleVendorMenu();
  });
  document.addEventListener("click", closeVendorMenu);
  document.getElementById("btnOpenUrl").addEventListener("click", function () {
    var url = document.getElementById("loginUrl").value;
    if (url) window.open(url, "_blank", "noopener");
  });
  document.getElementById("btnCopyUrl").addEventListener("click", function () {
    var field = document.getElementById("loginUrl");
    if (!field.value) return;
    field.select();
    Promise.resolve().then(function () {
      return navigator.clipboard.writeText(field.value);
    }).then(function () {
      document.getElementById("loginStatus").textContent = "链接已复制。";
    }).catch(function () {
      document.getElementById("loginStatus").textContent = "复制失败，请手动选中复制。";
    });
  });
  document.getElementById("btnLoginCancel").addEventListener("click", function () { resetAccountAddFlow(); });
  document.getElementById("btnPasteCredential").addEventListener("click", function () {
    if (currentLoginVendor) startCredentialPaste(currentLoginVendor);
  });
  document.getElementById("btnToggleCredentialMode").addEventListener("click", function () {
    if (!currentApiKeyVendor || !supportsCredentialImport(currentApiKeyVendor) || currentApiKeyVendor.auth_mode !== "apikey") return;
    var vendor = currentApiKeyVendor;
    if (currentAccountInputMode === "credential_json") startAccountCredentialInput(vendor, "api_key");
    else startCredentialPaste(vendor);
  });

  function submitLoginCallback() {
    var pasteStatus = document.getElementById("loginPasteStatus");
    var redirect = document.getElementById("loginPasteRedirect");
    var btn = document.getElementById("btnSubmitCallback");
    var raw = document.getElementById("loginPasteUrl").value.trim();
    if (!currentLoginState) { pasteStatus.textContent = "登录会话已结束，请重新发起登录后再粘贴。"; return; }
    if (!raw) { pasteStatus.textContent = "请先粘贴浏览器地址栏里的整条链接。"; return; }
    stopLoginPolling();
    btn.disabled = true;
    btn.textContent = "提交中…";
    redirect.hidden = true;
    var submittedState = currentLoginState;
    var generation = accountAddGeneration;
    api("POST", "/login/callback", { state: submittedState, url: raw }).then(function (data) {
      if (generation !== accountAddGeneration || submittedState !== currentLoginState) return;
      btn.disabled = false;
      btn.textContent = "提交回调链接";
      var value = (data && data.status) || "";
      var message = (data && data.message) || (data && data.error) || "";
      if (value === "success") {
        stopLoginPolling();
        document.getElementById("loginPasteUrl").value = "";
        currentLoginState = "";
        resetLoginCaptcha();
        clearLoginVariants();
        pasteStatus.textContent = message || "解析成功，正在写入账号…";
        document.getElementById("loginStatus").textContent = "授权成功，账号已写入 CPA。";
        banner("ok", "账号添加成功，正在查询该账号额度…");
        loadQuotas(true);
        setTimeout(function () {
          if (generation !== accountAddGeneration) return;
          var box = document.getElementById("loginBox");
          if (box) { box.hidden = true; box.style.display = "none"; }
        }, 1500);
        return;
      }
      pasteStatus.textContent = message || "回调链接暂时无法完成登录，请重新发起登录后重试。";
      if (data && data.redirect_url) { redirect.href = data.redirect_url; redirect.hidden = false; }
    }).catch(function (err) {
      if (generation !== accountAddGeneration || submittedState !== currentLoginState) return;
      btn.disabled = false;
      btn.textContent = "提交回调链接";
      pasteStatus.textContent = "提交失败：" + (err.message || err);
    });
  }

  document.getElementById("btnSubmitCallback").addEventListener("click", submitLoginCallback);

  document.getElementById("btnSmsSend").addEventListener("click", function () {
    var status = document.getElementById("smsStatus");
    var phone = document.getElementById("inputSmsPhone").value.trim();
    var btn = document.getElementById("btnSmsSend");
    if (!currentSmsVendor) { status.textContent = "请先重新打开添加面板。"; return; }
    if (!phone) { status.textContent = "请先填写手机号。"; return; }
    var generation = accountAddGeneration;
    btn.disabled = true; btn.textContent = "发送中…";
    status.textContent = "正在发送验证码…";
    api("POST", "/login/sms/send", { vendor_id: currentSmsVendor.id, phone: phone }).then(function (data) {
      if (generation !== accountAddGeneration) return;
      btn.disabled = false; btn.textContent = "发送验证码";
      if (data && data.ok) {
        smsSessionKey = (data.session_key || "");
        status.textContent = data.message || "验证码已发送。";
        document.getElementById("inputSmsCode").focus();
      } else {
        status.textContent = (data && data.message) || "发送失败，请稍后重试。";
      }
    }).catch(function (err) {
      if (generation !== accountAddGeneration) return;
      btn.disabled = false; btn.textContent = "发送验证码";
      status.textContent = "发送失败：" + err.message;
    });
  });

  document.getElementById("btnSmsVerify").addEventListener("click", function () {
    var status = document.getElementById("smsStatus");
    var phone = document.getElementById("inputSmsPhone").value.trim();
    var code = document.getElementById("inputSmsCode").value.trim();
    var label = document.getElementById("inputSmsLabel").value.trim();
    var btn = document.getElementById("btnSmsVerify");
    if (!currentSmsVendor) { status.textContent = "请先重新打开添加面板。"; return; }
    if (!phone || !code) { status.textContent = "请填写手机号与短信验证码。"; return; }
    var generation = accountAddGeneration;
    btn.disabled = true; btn.textContent = "登录中…";
    status.textContent = "正在验证并添加账号…";
    api("POST", "/login/sms/verify", { vendor_id: currentSmsVendor.id, session_key: smsSessionKey, phone: phone, code: code, label: label }).then(function (data) {
      if (generation !== accountAddGeneration) return;
      btn.disabled = false; btn.textContent = "登录并添加";
      if (data && data.ok) {
        resetAccountAddFlow();
        banner("ok", (data.message || "账号添加成功") + "：" + (data.auth_id || ""));
        loadQuotas(true);
      } else {
        status.textContent = (data && data.message) || "登录失败，请检查验证码后重试。";
      }
    }).catch(function (err) {
      if (generation !== accountAddGeneration) return;
      btn.disabled = false; btn.textContent = "登录并添加";
      status.textContent = "登录失败：" + err.message;
    });
  });

  document.getElementById("btnSmsCancel").addEventListener("click", function () { resetAccountAddFlow(); });
  document.getElementById("apiKeyBox").addEventListener("click", function (event) {
    if (event.target === this) resetAccountAddFlow();
  });
  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape" && !document.getElementById("apiKeyBox").hidden) resetAccountAddFlow();
  });
  document.getElementById("btnCancelApiKey").addEventListener("click", function () { resetAccountAddFlow(); });

  document.getElementById("btnSubmitApiKey").addEventListener("click", function () {
    if (!currentApiKeyVendor) return;
    if (quotaCredentialAccount) { submitExistingQuotaCredential(); return; }
    var importing = currentAccountInputMode === "credential_json";
    var input = document.getElementById("inputApiKey");
    var apiKey = (input.value || "").trim();
    var label = (document.getElementById("inputApiLabel").value || "").trim();
    if (!apiKey) { banner("err", importing ? "请先粘贴凭证 JSON" : "API Key 不能为空"); return; }
    if (importing) {
      var parsed;
      try { parsed = JSON.parse(apiKey); }
      catch (err) { banner("err", "凭证 JSON 格式无效，请检查后重试"); return; }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        banner("err", "凭证 JSON 必须是一个对象");
        return;
      }
    }
    var generation = accountAddGeneration;
    var btn = document.getElementById("btnSubmitApiKey");
    btn.disabled = true;
    btn.textContent = "保存中…";
    var payload = { vendor: currentApiKeyVendor.id, label: label };
    if (importing) {
      payload.credential_json = apiKey;
    } else {
      payload.api_key = apiKey;
      if (currentApiKeyVendor.quota_credential_hint) payload.quota_credential = document.getElementById("inputQuotaCredential").value.trim();
    }
    api("POST", "/accounts/add", payload).then(function (res) {
      if (generation !== accountAddGeneration) return;
      btn.disabled = false;
      btn.textContent = "保存账号";
      if (!res || !res.ok) { banner("err", (res && res.error) || "保存失败"); return; }
      banner("ok", res.message || "账号添加成功");
      resetAccountAddFlow();
      loadStatus(true).then(function () { if (payload.quota_credential) return loadQuotas(true, [res.auth_id]); }).catch(function () { });
    }).catch(function (err) {
      if (generation !== accountAddGeneration) return;
      btn.disabled = false;
      btn.textContent = "保存账号";
      banner("err", err.message || "保存失败");
    });
  });
