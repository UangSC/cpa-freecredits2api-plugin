import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { loadConsoleHTML } from './_console.mjs';

const html = loadConsoleHTML();
const script = (start, end) => html.slice(html.indexOf(start), html.indexOf(end));

test('插件业务 403 保留管理连接，CPA 认证失败停止自动请求', async () => {
  const requests = [];
  const authFailures = [];
  const responses = [
    new Response('{"error":"该平台上下文固定"}', { status: 403, headers: { 'X-TierBridge-Response': 'management' } }),
    new Response('{"error":"invalid management key"}', { status: 401 }),
  ];
  const scope = vm.createContext({
    stopped: false,
    MGMT: '/v0/management/plugins/test-plugin',
    HOST_MGMT: '/v0/management',
    managementKey: () => 'test-management-key',
    haltOnAuthFailure(status) { authFailures.push(status); scope.stopped = true; return true; },
    fetch(url, options) { requests.push({ url, options }); return Promise.resolve(responses.shift()); },
  });
  vm.runInContext(script('  var HOST_PREFIX =', '  // ---- 通用 DOM'), scope);
  await assert.rejects(scope.api('POST', '/models/context', { context_length: 10 }), /该平台上下文固定/);
  assert.deepEqual(authFailures, []);
  assert.equal(requests[0].url, '/v0/management/plugins/test-plugin/models/context');
  assert.equal(await scope.api('GET', scope.hostPath('/auth-files/models?name=test.json')), null);
  assert.equal(requests[1].url, '/v0/management/auth-files/models?name=test.json');
  assert.deepEqual(authFailures, [401]);
  assert.equal(await scope.api('GET', '/logs'), null);
  assert.equal(requests.length, 2);
});

test('排程留空明确恢复默认值，非法小时不发送', () => {
  const inputs = [{ value: ' ', dataset: { taskKind: 'keepalive' } }, { value: '10, 18', dataset: { taskKind: 'checkin' } }];
  const scope = vm.createContext({ document: { querySelectorAll: () => inputs } });
  vm.runInContext(script('  function collectTaskSchedules(', '  saveSettingsButton.addEventListener'), scope);
  assert.equal(JSON.stringify(scope.collectTaskSchedules()), '{"keepalive":[],"checkin":[10,18]}');
  inputs[1].value = '10,18abc';
  assert.throws(() => scope.collectTaskSchedules(), /0–23/);
});

test('额度或账号状态刷新保留未保存的运行期设置', async () => {
  const nodes = new Map();
  const get = id => {
    if (!nodes.has(id)) nodes.set(id, {});
    return nodes.get(id);
  };
  const scope = vm.createContext({
    document: { getElementById: get },
    api: () => Promise.resolve({ settings: { auto_checkin: true, auto_checkin_at: '13:00' } }),
    renderAccounts() {}, renderVendorPickerGrid() {}, renderTaskSchedules() {}, syncCustomSelect() {}, setText() {},
  });
  vm.runInContext(script('  var settingsDirty = false;', '  function renderTaskSchedules('), scope);
  await scope.loadStatus(true);
  assert.equal(get('setCheckinAt').value, '13:00');
  get('setCheckinAt').value = '20:00';
  scope.setSettingsDirty(true);
  await scope.loadStatus(true);
  assert.equal(get('setCheckinAt').value, '20:00');
  assert.equal(get('unsavedBadge').hidden, false);
});
