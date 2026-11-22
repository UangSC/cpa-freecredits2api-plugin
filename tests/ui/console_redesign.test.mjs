import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { loadConsoleHTML } from './_console.mjs';

const html = loadConsoleHTML();
const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);

test('控制台页面语法完整且包含所有多标签视图与基础占位符', () => {
  assert.ok(scriptMatch, '必须包含内嵌 <script> 块');
  assert.doesNotThrow(() => new vm.Script(scriptMatch[1]), '控制台脚本不能存在语法错误');
  assert.equal(html.includes('{{'), false, '页面不能残留模板占位符');
  for (const marker of [
    'id="view-accounts"',
    'id="view-models"',
    'id="view-tasks"',
    'id="view-settings"',
    'id="view-logs"',
    'id="accountDrawer"',
    'id="accountVendorRail"',
    'id="modelVendorRail"',
    'id="btnModelViewAgg"',
    '__BASE__',
  ]) {
    assert.equal(html.includes(marker), true, `缺少关键标记 ${marker}`);
  }
});

test('脚本引用的静态 DOM ID 均在 HTML 中存在', () => {
  const htmlPart = html.slice(0, html.indexOf('<script>'));
  const jsPart = html.slice(html.indexOf('<script>'));
  const htmlIds = new Set([...htmlPart.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
  const dynamicIds = new Set(['vpGrid', 'vpSearchInput', 'chkAccountsPage', 'chkModelsPage']);
  const missing = [...new Set([...jsPart.matchAll(/getElementById\("([^"]+)"\)/g)].map(m => m[1]))]
    .filter(id => !htmlIds.has(id) && !dynamicIds.has(id));
  assert.deepEqual(missing, []);
});

test('账号与任务的六个主要操作使用独立图标和可读标签', () => {
  for (const [id, icon, label] of [
    ['btnLoadQuotas', 'quota', '查询额度'],
    ['btnCheckin', 'checkin', '一键签到'],
    ['btnRefresh', 'credential', '凭证更新'],
    ['btnAutoAll', 'automate', '一键做任务'],
    ['btnScan', 'scan', '扫描待办'],
    ['btnRunQueue', 'queue', '执行待办队列'],
  ]) {
    const button = html.match(new RegExp(`id="${id}">([\\s\\S]*?)</button>`));
    assert.ok(button, id);
    assert.ok(button[1].includes(`<use href="#action-icon-${icon}"/>`), id);
    assert.ok(button[1].includes(`<span class="btn-label">${label}</span>`), id);
    assert.ok(html.includes(`<symbol id="action-icon-${icon}" viewBox="0 0 24 24">`), icon);
  }
  assert.doesNotMatch(html, /Token 续期/);
});

test('accountNeedsAttention 与 accountQuotaScore 准确识别待关注账号及排序分值', () => {
  const slice = html.slice(
    html.indexOf('  function quotaRemainingText('),
    html.indexOf('  function accountNameCell('),
  );
  const scope = vm.createContext({ vendorsById: {} });
  vm.runInContext(slice, scope);

  assert.equal(scope.accountNeedsAttention({ disabled: true, quota: { ok: false, message: 'err' } }), false);
  assert.equal(scope.accountNeedsAttention({ disabled: false, quota_credential_hint: 'h', quota_credential_bound: false }), true);
  assert.equal(scope.accountNeedsAttention({ disabled: false, quota: { ok: false, message: 'timeout' } }), true);
  assert.equal(scope.accountNeedsAttention({ disabled: false, quota: { ok: true, stale: true, stale_reason: 'rate limit' } }), true);
  assert.equal(scope.accountNeedsAttention({ disabled: false, quota: { ok: true, has_total: true, remain: 15, total: 100 } }), true);
  assert.equal(scope.accountNeedsAttention({ disabled: false, quota: { ok: true, has_total: true, remain: 50, total: 100 } }), false);
  assert.equal(scope.accountNeedsAttention({ disabled: false, checkin_pending: true }), true);

  assert.equal(scope.accountQuotaScore({ quota: { ok: true, unlimited: true } }), Number.MAX_SAFE_INTEGER);
  assert.equal(scope.accountQuotaScore({ quota: { ok: true, has_total: true, remain: 30, total: 100 } }), 0.3);
  assert.equal(scope.accountQuotaScore({ quota: { ok: true, has_total: false, metrics: [{ key: 'credit_remain', value: 888 }] } }), 888);
  assert.equal(scope.accountQuotaScore({ quota: { ok: false } }), -1);
});

test('套餐额度格式化保留非零小数位', () => {
  const slice = html.slice(
    html.indexOf('  function formatGrantUnits('),
    html.indexOf('  function setupClaimCaptcha('),
  );
  const scope = vm.createContext({});
  vm.runInContext(slice, scope);

  assert.equal(scope.formatGrantUnits(125000), '12.5万 tokens');
  assert.equal(scope.formatGrantUnits(100000), '10万 tokens');
  assert.equal(scope.formatGrantUnits(120000000), '1.2亿 tokens');
  assert.equal(scope.formatGrantUnits(500), '500 tokens');
});

test('对外模型 ID 计算正确处理别名、渠道标识与冲突保护', () => {
  const slice = html.slice(
    html.indexOf('  function effectiveModelID('),
    html.indexOf('  function modelCreditValue('),
  );
  const scope = vm.createContext({
    lastStatus: { settings: { model_name_tag: 'prefix' } },
    allModels: [
      { id: 'glm-5', vendor_id: 'zcode' },
      { id: 'zcode-glm-5', vendor_id: 'zcode' },
      { id: 'gpt-5', vendor_id: 'qodercn' },
    ],
  });
  vm.runInContext(slice, scope);

  assert.equal(scope.effectiveModelID({ id: 'gpt-5', vendor_id: 'qodercn', alias: 'custom-gpt' }), 'custom-gpt');
  assert.equal(scope.effectiveModelID({ id: 'gpt-5', vendor_id: 'qodercn', alias: '' }), 'qodercn-gpt-5');
  assert.equal(scope.effectiveModelID({ id: 'glm-5', vendor_id: 'zcode', alias: '' }), 'glm-5');
});

test('账号与模型页统一采用顶部 KPI 分类卡片，移除工具栏下方冗余分类栏', () => {
  assert.equal(html.includes('id="accountKpiStrip"'), true, '账号页应保留顶部 KPI 分类卡片');
  assert.equal(html.includes('id="modelKpiStrip"'), true, '模型页应包含顶部 KPI 分类卡片');
  for (const id of ['mKpiValAll', 'mKpiValEnabled', 'mKpiValDisabled', 'mKpiValAliased', 'mKpiValImages', 'mKpiValTools']) {
    assert.equal(html.includes(`id="${id}"`), true, `模型页缺少分类卡片计数 ${id}`);
  }
  assert.equal(html.includes('id="accountStatusPills"'), false, '添加账号下方不应再存在冗余状态分类栏');
  assert.equal(html.includes('id="modelFilterPills"'), false, '模型工具栏下方不应再存在冗余分类栏');
});

test('查询失败改用悬浮气泡与点击详情弹层，且下拉框保留原生 select 与美化增强', () => {
  assert.equal(html.includes('id="infoPopover"'), true, '页面应包含全局悬浮/点击详情弹层节点');
  assert.equal(html.includes('class="quota-sub"'), false, '列表内不应再直接多行渲染查询失败文本');
  assert.equal(html.includes('function enhanceSelect('), true, '应提供自定义下拉美化增强函数');
  for (const id of ['accountSort', 'setPromptMode', 'setModelNameTag']) {
    assert.equal(html.includes(`id="${id}"`), true, `应保留原生 select#${id} 以兼容既有逻辑`);
  }
  assert.equal(html.includes('function bindTableScrollShadows('), true, '应提供窄屏表格固定列动态阴影辅助函数');
  assert.equal(html.includes('#accounts .table-wrap td.col-end'), true, '账号表末尾操作列应支持窄屏粘性固定');
});

test('一键做任务已从账号页隔离至模块化任务中心，并由 /tasks/modules 协议驱动', () => {
  const accountsSec = html.slice(html.indexOf('<section id="view-accounts"'), html.indexOf('<section id="view-models"'));
  const tasksSec = html.slice(html.indexOf('<section id="view-tasks"'), html.indexOf('<section id="view-settings"'));

  assert.equal(accountsSec.includes('id="btnAutoAll"'), false, '账号页不应再混入全局「一键做任务」按钮');
  assert.equal(tasksSec.includes('id="btnAutoAll"'), true, '「一键做任务」应归位到任务中心');
  for (const id of ['taskKpiStrip', 'taskVendorRail', 'taskModulesGrid', 'tKpiValModules', 'tKpiValScan', 'tKpiValChat', 'tKpiValPending']) {
    assert.equal(tasksSec.includes(`id="${id}"`), true, `任务中心缺少模块化节点 ${id}`);
  }
  assert.equal(html.includes('"/tasks/modules"'), true, '任务中心应通过 GET /tasks/modules 拉取已挂载模块');
  assert.equal(html.includes('"/tasks/auto"'), true, '任务中心应保留单任务触发路由 /tasks/auto');

  // 验证通用扫描任务解析与动态消耗对话提示（不硬编码具体渠道文案）
  const tasksSlice = html.slice(
    html.indexOf('  function taskCategoryLabel('),
    html.indexOf('  function renderTaskCenter('),
  );
  const scope = vm.createContext({
    vendorsList: [{ id: 'traecn', name: 'Trae（国内）' }, { id: 'workbuddycn', name: 'WorkBuddy（国内）' }],
    lastStatus: { accounts: [] },
    taskModules: [],
  });
  vm.runInContext(tasksSlice, scope);

  assert.deepEqual(
    scope.scanItems({ tasks: [{ kind: 'ops_benefit', kind_label: '运营活动', code: 'ops:1' }] }).map(i => i.code),
    ['ops:1'],
  );
  assert.deepEqual(
    scope.scanItems({ growth: [{ kind: 'growth', code: 'g1' }], school: [{ kind: 'school', code: 's1' }] }).map(i => i.code),
    ['g1', 's1'],
  );
  assert.equal(scope.taskKindDisplay({ kind: 'ops_benefit', kind_label: '运营活动' }), '运营活动');
  const safeConfirm = scope.buildAutoAllConfirmText('Trae（国内）', [{ id: 'trae.ug', name: 'Trae 活动福利领取', uses_chat: false }], 2);
  assert.match(safeConfirm, /不消耗对话额度/);
  const chatConfirm = scope.buildAutoAllConfirmText('WorkBuddy（国内）', [{ id: 'workbuddy.tasks', name: '成长任务与活动闭环', uses_chat: true }], 1);
  assert.match(chatConfirm, /真实对话/);
  assert.match(chatConfirm, /成长任务与活动闭环/);
});

test('空供应商侧栏与工作区等高对齐，管理密钥升级为独立登录弹窗并支持记住密钥与右上角退出', () => {
  // 1. 分栏布局与右侧工作区等高对齐
  const splitRule = html.slice(html.indexOf('.split-layout {'), html.indexOf('.vendor-rail {'));
  assert.match(splitRule, /align-items:\s*stretch;/, '空供应商侧栏应与右侧模型清单/账号工作区保持等高');
  assert.equal(html.includes('rail-empty'), true, '空供应商侧栏应包含优雅的空态占位提示');

  // 2. 右上角退出按钮与独立管理密钥弹窗
  const headerPart = html.slice(html.indexOf('<header>'), html.indexOf('</header>'));
  const mainPart = html.slice(html.indexOf('<main>'), html.indexOf('</main>'));
  assert.equal(headerPart.includes('id="btnLogout"'), true, '右上角顶栏应包含退出面板按钮 #btnLogout');
  assert.equal(mainPart.includes('id="keyBox"'), false, '管理密钥不应再置顶内联在 <main> 中');
  assert.equal(html.includes('class="modal auth-modal" id="keyBox"'), true, '管理密钥应为独立居中弹窗 .modal.auth-modal#keyBox');
  for (const id of ['keyModalTitle', 'keyStatusBar', 'keyInput', 'btnToggleKeyVis', 'chkRememberKey', 'btnUseKey', 'btnReusePanelKey']) {
    assert.equal(html.includes(`id="${id}"`), true, `独立密钥弹窗缺少节点 ${id}`);
  }

  // 3. 验证记住密钥混淆落盘与退出隔离逻辑
  const store = (init = {}) => {
    const map = new Map(Object.entries(init));
    return {
      getItem: k => (map.has(k) ? map.get(k) : null),
      setItem: (k, v) => { map.set(k, String(v)); },
      removeItem: k => { map.delete(k); },
      _map: map,
    };
  };
  const local = store({ 'cli-proxy-auth': JSON.stringify({ state: { managementKey: 'panel-key-999' } }) });
  const session = store();
  const keySlice = html.slice(
    html.indexOf('  var PANEL_STORE_KEY ='),
    html.indexOf('  var bannerTimer = null;'),
  );
  const scope = vm.createContext({
    localStorage: local,
    sessionStorage: session,
    location: { host: '127.0.0.1:8317' },
    navigator: { userAgent: 'test' },
    TextEncoder,
    TextDecoder,
    btoa: s => Buffer.from(s, 'binary').toString('base64'),
    atob: s => Buffer.from(s, 'base64').toString('binary'),
  });
  vm.runInContext(keySlice, scope);

  assert.equal(scope.managementKey(), 'panel-key-999', '未退出时可自动复用 CPA 面板密钥');
  scope.saveRememberedKey('secret-key-abc', true);
  assert.equal(scope.rememberedLocalKey(), 'secret-key-abc', '勾选记住密钥后应可正确混淆读取');
  assert.match(local.getItem('cpa-freecredits2api-management-key'), /^enc::v2::/, '记住密钥不应以明文落盘');
  assert.equal(scope.managementKey(), 'secret-key-abc');

  scope.saveRememberedKey('session-only-xyz', false);
  assert.equal(scope.rememberedLocalKey(), '', '取消记住密钥后应清除 localStorage 持久密钥');
  assert.equal(scope.managementKey(), 'session-only-xyz', '取消记住时当前标签会话仍可用');

  scope.clearSavedKeys(true);
  assert.equal(scope.isExplicitlyLoggedOut(), true, '退出后应记录显式退出态');
  assert.equal(scope.managementKey(), '', '退出后即使 CPA 面板存在密钥也不应静默自动重登');
  assert.equal(scope.panelAuthKey(), 'panel-key-999', '退出不应破坏 CPA 主面板自身的 localStorage 密钥');

  for (const prefix of ['cpa-tierbridge', 'cpa-freetier']) {
    session.removeItem('cpa-freecredits2api-logged-out');
    session.setItem(`${prefix}-logged-out`, '1');
    local.setItem(`${prefix}-management-key`, 'legacy-key');
    assert.equal(scope.isExplicitlyLoggedOut(), true, '升级后应保留退出状态');
    assert.equal(scope.managementKey(), '', '升级后不应绕过显式退出');
    assert.equal(scope.rememberedLocalKey(), 'legacy-key');
    assert.match(local.getItem('cpa-freecredits2api-management-key'), /^enc::v2::/);
    assert.equal(local.getItem(`${prefix}-management-key`), null);
    assert.equal(session.getItem(`${prefix}-logged-out`), null);
    scope.clearSavedKeys(true);
    assert.equal(scope.rememberedLocalKey(), '', '退出后应清除已迁移的密钥');
  }
});
