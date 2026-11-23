import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const hostBinary = process.env.CPA_HOST_EXE;
const pluginLibrary = process.env.CPA_PLUGIN_LIBRARY;
const storeSource = process.env.CPA_PLUGIN_STORE_SOURCE;
const storeArchive = process.env.CPA_PLUGIN_STORE_ARCHIVE;
const pluginID = 'freecredits2api';
const loopback = '127.0.0.1';
const model = 'Agents-A1';
const upstreamKey = 'local-fixture-key';
const managementPrefix = `/v0/management/plugins/${pluginID}`;
const storePrefix = '/v8/management/plugins/store';

async function listen(server) {
  server.listen(0, loopback);
  await once(server, 'listening');
  return server.address().port;
}

async function close(server) {
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
}

function chatChunk(delta, finishReason = null) {
  return {
    id: 'chatcmpl-local', object: 'chat.completion.chunk', model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

function fixtureUpstream(executions, rateLimited = false) {
  return createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${upstreamKey}`) {
      res.writeHead(401).end();
      return;
    }
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: model, object: 'model' }] }));
      return;
    }
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      res.writeHead(404).end();
      return;
    }
    try {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      executions.push(body);
      if (rateLimited) {
        res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '120' });
        res.end(JSON.stringify({ code: 'frequency_limit', message: 'retry later' }));
        return;
      }
      if (body.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify(chatChunk({ role: 'assistant', content: 'local stream' }))}\n\n`);
        res.end(`data: ${JSON.stringify(chatChunk({}, 'stop'))}\n\ndata: [DONE]\n\n`);
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 'chatcmpl-local', object: 'chat.completion', model,
          choices: [{ index: 0, message: { role: 'assistant', content: 'local chat' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }));
      }
    } catch {
      res.writeHead(400).end();
    }
  });
}

async function fixtureStore(t, archivePath) {
  const archive = await readFile(archivePath);
  const name = basename(archivePath);
  const checksums = (await readFile(join(dirname(resolve(archivePath)), 'checksums.txt'), 'utf8')).split(/\r?\n/);
  const digest = createHash('sha256').update(archive).digest('hex');
  assert.ok(checksums.includes(`${digest}  ${name}`), `${name} 的 SHA-256 与发布清单不符`);
  const manifest = JSON.parse(await readFile(new URL('../../registry.json', import.meta.url), 'utf8'));
  const goos = process.platform === 'win32' ? 'windows' : process.platform;
  const goarch = { x64: 'amd64', arm64: 'arm64' }[process.arch];
  const plugin = manifest.plugins.find((entry) => entry.id === pluginID);
  assert.equal(name, `${pluginID}_${plugin.version}_${goos}_${goarch}.zip`);

  const server = createServer((req, res) => {
    if (req.url === '/registry.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(manifest));
    } else if (req.url === `/${name}`) {
      res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': archive.length });
      res.end(archive);
    } else {
      res.writeHead(404).end();
    }
  });
  const port = await listen(server);
  t.after(() => close(server));
  const origin = `http://${loopback}:${port}`;
  manifest.schema_version = 2;
  plugin.install = { type: 'direct', artifacts: [{ goos, goarch, url: `${origin}/${name}`, sha256: digest, size: archive.length }] };
  return `${origin}/registry.json`;
}

function isolatedEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(?:HOME_JWT$|DEPLOY$|MANAGEMENT_PASSWORD$|MANAGEMENT_STATIC_PATH$|(?:PGSTORE|GITSTORE|OBJECTSTORE)_)/i.test(key)));
}

async function eventually(check, message) {
  let latestError;
  for (let i = 0; i < 50; i++) {
    try {
      const result = await check();
      if (result) return result;
    } catch (err) {
      latestError = err;
    }
    await delay(200);
  }
  assert.fail(latestError ? `${message}（${latestError.message}）` : message);
}

async function startHost(t, upstreamPort, registrySource) {
  const distDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../dist');
  await mkdir(distDir, { recursive: true });
  const workspace = await mkdtemp(join(distDir, 'cpa-test-'));
  assert.equal(dirname(workspace), distDir);
  let stopHost;
  t.after(async () => {
    await stopHost?.();
    await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const plugins = join(workspace, 'plugins');
  if (!registrySource) {
    const arch = { x64: 'amd64', arm64: 'arm64' }[process.arch];
    assert.ok(arch, `未配置 ${process.arch} 的 CPA 插件目录`);
    const platform = process.platform === 'win32' ? 'windows' : process.platform;
    const platformDir = join(plugins, platform, arch);
    await mkdir(platformDir, { recursive: true });
    await copyFile(resolve(pluginLibrary), join(platformDir, `${pluginID}${extname(pluginLibrary)}`));
  }

  const reserve = createServer();
  const port = await listen(reserve);
  await close(reserve);
  const secret = randomUUID();
  const clientKey = randomUUID();
  const config = join(workspace, 'config.yaml');
  const authDir = join(workspace, 'auths');
  const quote = JSON.stringify;
  const fixtureAuth = storeArchive ? `
  store-auth:
    - match: ${quote(new URL(registrySource).origin + '/')}
      type: none
      apply-to: [registry, artifact]
      allow-insecure: true` : '';
  await writeFile(config, `config-version: 8
server:
  host: ${quote(loopback)}
  port: ${port}
management:
  allow-remote: false
  secret-key: ${quote(secret)}
  disable-control-panel: true
access:
  api-keys: [${quote(clientKey)}]
routing:
  cooldown:
    save-cooldown-status: true
oauth:
  auth-dir: ${quote(authDir)}
plugins:
  enabled: true
  dir: ${quote(plugins)}${registrySource && registrySource !== 'official' ? `\n  store-sources: [${quote(registrySource)}]` : ''}${fixtureAuth}
  configs:
    ${pluginID}:
      enabled: true
      state_dir: ${quote(join(workspace, 'state'))}
      log_level: debug
      log_to_host: false
      auto_checkin: false
      auto_tasks: false
      tokenplan_base_url: "http://${loopback}:${upstreamPort}/v1"
`);
  const child = spawn(resolve(hostBinary), ['-config', config, '-local-model'], {
    cwd: workspace, env: isolatedEnv(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', (chunk) => { output = (output + chunk).slice(-12000); });
  }
  const exited = new Promise((done) => {
    child.once('close', (code) => done({ code }));
    child.once('error', (error) => done({ error }));
  });
  stopHost = async () => {
    child.kill();
    await exited;
  };
  try {
    await once(child, 'spawn');
    const request = (path, { method = 'GET', body, auth = true, headers = {}, timeout = 5000 } = {}) => fetch(`http://${loopback}:${port}${path}`, {
      method,
      headers: {
        ...(auth && { Authorization: `Bearer ${path.startsWith('/v1/') ? clientKey : secret}` }),
        ...(body && { 'Content-Type': 'application/json' }), ...headers,
      },
      body: body && JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });
    if (registrySource) {
      await eventually(async () => {
        const response = await request('/v0/management/plugins');
        await response.body.cancel();
        return response.ok;
      }, 'CPA 插件商店的管理接口未就绪');
      const store = await jsonResponse(await request(storePrefix, { timeout: 45_000 }));
      const offer = store.plugins.find((entry) => entry.id === pluginID &&
        (registrySource === 'official' ? entry.source_id === 'official' : entry.source_url === registrySource));
      assert.ok(offer, `插件商店未找到 ${pluginID}（${JSON.stringify(store.source_errors || [])}）`);
      const installed = await jsonResponse(await request(`${storePrefix}/${pluginID}/install?source=${encodeURIComponent(offer.source_id)}`, {
        method: 'POST', timeout: 90_000,
      }));
      assert.equal(installed.id, pluginID);
      assert.equal(installed.restart_required, false);
      assert.ok(installed.path);
    }
    const statusResponse = await eventually(async () => {
      const response = await request(`${managementPrefix}/status`);
      return response.ok && response;
    }, 'CPA 未挂载插件管理路由');
    await statusResponse.body.cancel();
    return { request, authDir };
  } catch (error) {
    throw new Error(`${error.message}\n${output.replaceAll(secret, '[管理密钥]').replaceAll(clientKey, '[API Key]')}`, { cause: error });
  }
}

async function jsonResponse(response, expectedStatus = 200) {
  const raw = await response.text();
  assert.equal(response.status, expectedStatus, raw);
  return JSON.parse(raw);
}

test('CPA 通过动态库接入控制台、凭证、模型和普通及流式推理', {
  skip: !hostBinary && !pluginLibrary && !storeSource && !storeArchive ? '设定 CPA_HOST_EXE 和插件安装来源后运行' : false,
  timeout: storeSource || storeArchive ? 180_000 : 60_000,
}, async (t) => {
  assert.ok(hostBinary && [pluginLibrary, storeSource, storeArchive].filter(Boolean).length === 1,
    '设置 CPA_HOST_EXE，并从 CPA_PLUGIN_LIBRARY、CPA_PLUGIN_STORE_SOURCE、CPA_PLUGIN_STORE_ARCHIVE 选择一个');
  const executions = [];
  const upstream = fixtureUpstream(executions);
  const upstreamPort = await listen(upstream);
  t.after(() => close(upstream));
  const registrySource = storeArchive ? await fixtureStore(t, storeArchive) : storeSource;
  const { request } = await startHost(t, upstreamPort, registrySource);
  const manage = async (path, method = 'GET', body, expectedStatus = 200) =>
    jsonResponse(await request(`${managementPrefix}${path}`, { method, body }), expectedStatus);
  const modelIDs = async () => (await jsonResponse(await request('/v1/models'))).data.map(({ id }) => id);

  const resource = await request('/v0/resource/plugins/freecredits2api/console', { auth: false });
  assert.equal(resource.status, 200);
  assert.match(resource.headers.get('content-type'), /text\/html/);
  const page = await resource.text();
  const manifest = JSON.parse(await readFile(new URL('../../registry.json', import.meta.url), 'utf8'));
  assert.ok(page.includes(`<title>${manifest.plugins[0].name}</title>`));
  const unauthorized = await request(`${managementPrefix}/status`, { auth: false });
  assert.equal(unauthorized.status, 401);
  await unauthorized.body.cancel();

  const status = await manage('/status');
  assert.equal(status.account_count, 0);
  assert.equal(status.plugin, pluginID);
  assert.equal(status.version, `v${manifest.plugins[0].version}`);
  assert.ok(page.includes(`id="headerVersion">${status.version}</span>`));
  const { plugins } = await jsonResponse(await request('/v0/management/plugins'));
  const { metadata } = plugins.find((entry) => entry.id === status.plugin);
  assert.equal(metadata.name, manifest.plugins[0].name);
  assert.equal(metadata.version, status.version);
  const { vendors } = await manage('/vendors');
  assert.equal(new Set(vendors.map(({ id }) => id)).size, vendors.length);
  assert.ok(vendors.some(({ id, auth_mode }) => id === 'tokenplan' && auth_mode === 'apikey'));
  assert.ok(Array.isArray((await manage('/tasks/modules')).modules));
  assert.ok(Array.isArray((await manage('/logs?since=0&limit=10')).entries));

  const added = await manage('/accounts/add', 'POST', { vendor: 'tokenplan', api_key: upstreamKey, label: 'CPA fixture' });
  assert.equal(added.ok, true);
  const authID = added.auth_id;
  const fileID = authID.replace(/\.json$/i, '');
  const account = async () => (await manage('/status')).accounts.find((row) => row.file_id === fileID);
  await eventually(async () => {
    const accounts = (await manage('/status')).accounts;
    assert.ok(accounts.some((row) => row.file_id === fileID), JSON.stringify(accounts));
    return true;
  }, '宿主未注册新增的凭证');
  assert.equal((await manage('/accounts/alias', 'POST', { file_id: fileID, alias: '本地测试账号' })).ok, true);
  assert.equal((await account()).alias, '本地测试账号');
  const quotas = await manage('/quotas', 'POST', { account_ids: [authID] });
  assert.deepEqual(quotas.results, []);
  assert.equal((await manage('/settings', 'POST', { auto_checkin_at: '14:35' })).settings.auto_checkin_at, '14:35');

  const scope = `tokenplan:${model}`;
  const registered = await eventually(async () => (await modelIDs()).find((id) => id === model || id.includes(model)), '模型未进入 CPA 注册表');
  const { models } = await manage('/models');
  const consoleModel = models.find((item) => item.id === model);
  assert.equal(consoleModel?.context_length, 262144);
  assert.equal(consoleModel?.context_locked, true);
  const locked = await request(`${managementPrefix}/models/context`, {
    method: 'POST', body: { model: scope, context_length: 1000 },
  });
  assert.equal(locked.headers.get('X-FreeCredits2API-Response'), 'management');
  assert.equal((await jsonResponse(locked, 403)).context_locked, true);

  const alias = 'cpa-smoke-model';
  assert.equal((await manage('/models/alias', 'POST', { model: scope, alias })).alias, alias);
  const reloaded = await request(`/v8/management/config/plugins/configs/${pluginID}`, {
    method: 'PATCH', body: { config_reloaded_at: new Date().toISOString() },
  });
  assert.equal(reloaded.status, 200, await reloaded.text());
  await eventually(async () => {
    const ids = await modelIDs();
    return ids.includes(alias) && !ids.includes(registered);
  }, '更名后的模型未同步至 CPA 注册表');

  const prompt = { model: alias, messages: [{ role: 'user', content: 'local request' }] };
  const chat = await jsonResponse(await request('/v1/chat/completions', { method: 'POST', body: prompt }));
  assert.equal(chat.choices[0].message.content, 'local chat');
  const stream = await request('/v1/chat/completions', { method: 'POST', body: { ...prompt, stream: true } });
  assert.equal(stream.status, 200);
  assert.match(stream.headers.get('content-type'), /text\/event-stream/);
  const events = await stream.text();
  assert.match(events, /local stream/);
  assert.match(events, /data: \[DONE\]/);

  const responses = await jsonResponse(await request('/v1/responses', {
    method: 'POST', body: { model: alias, input: 'responses request' },
  }));
  assert.ok(responses.output.some((item) => item.content?.some((part) => part.text === 'local chat')));
  const messages = await jsonResponse(await request('/v1/messages', {
    method: 'POST', headers: { 'anthropic-version': '2023-06-01' },
    body: { ...prompt, max_tokens: 16 },
  }));
  assert.ok(messages.content.some((part) => part.text === 'local chat'));
  assert.deepEqual(executions.map((body) => body.model), [model, model, model, model]);

  assert.equal((await manage('/accounts/enabled', 'POST', { account_ids: [authID], enabled: false })).changed, 1);
  await eventually(async () => !(await modelIDs()).includes(alias), '停用账号后 CPA 仍展示相关模型');
  const enabled = await manage('/accounts/enabled', 'POST', { account_ids: [authID], enabled: true });
  assert.equal(enabled.changed, 1, JSON.stringify(enabled));
  try {
    await eventually(async () => (await modelIDs()).includes(alias), '重新启用账号后 CPA 未恢复模型');
  } catch (error) {
    const { files = [] } = await jsonResponse(await request('/v0/management/auth-files'));
    const { entries } = await manage('/logs?limit=50');
    t.diagnostic(JSON.stringify({ files: files.map(({ id, name, disabled }) => ({ id, name, disabled })), entries }));
    throw error;
  }
  const deleted = await manage('/accounts/delete', 'POST', { account_ids: [authID] });
  assert.equal(deleted.deleted, 1, JSON.stringify(deleted));
  await eventually(async () => {
    const remainingAccount = await account();
    const remainingModels = await modelIDs();
    const { files = [] } = await jsonResponse(await request('/v0/management/auth-files'));
    assert.equal(remainingAccount, undefined, '删除后账号仍在控制台');
    assert.ok(!remainingModels.includes(alias), '删除后模型仍在 CPA 注册表');
    assert.ok(!files.some(({ id, name }) => [id, name].includes(authID) || [id, name].includes(fileID)),
      '删除后凭证仍在 CPA 认证文件列表');
    return true;
  }, '删除未同步至 CPA');
});

for (const stream of [false, true]) {
  test(`CPA 将${stream ? '流式' : '普通'}推理的通用 HTTP 429 持久化`, {
    skip: !hostBinary || !pluginLibrary,
    timeout: 60_000,
  }, async (t) => {
    const executions = [];
    const upstream = fixtureUpstream(executions, true);
    const upstreamPort = await listen(upstream);
    t.after(() => close(upstream));

    const { request, authDir } = await startHost(t, upstreamPort);
    const added = await jsonResponse(await request(`${managementPrefix}/accounts/add`, {
      method: 'POST', body: { vendor: 'tokenplan', api_key: upstreamKey },
    }));
    assert.equal(added.ok, true);
    const registeredModel = await eventually(async () => {
      const { data } = await jsonResponse(await request('/v1/models'));
      return data.find(({ id }) => id === model || id.endsWith(`/${model}`))?.id;
    }, '限流测试模型未注册');

    const send = () => request('/v1/chat/completions', {
      method: 'POST', body: { model: registeredModel, stream, messages: [{ role: 'user', content: 'local request' }] },
    });
    const sentAt = Date.now();
    const response = await send();
    assert.equal(response.status, 429, await response.text());
    assert.equal(response.headers.get('retry-after'), '120');
    const fileID = added.auth_id.replace(/\.json$/i, '');
    let observed = [];
    const record = await eventually(async () => {
      observed = [];
      for (const name of await readdir(authDir)) {
        if (!name.endsWith('.cds')) continue;
        const { records } = JSON.parse(await readFile(join(authDir, name), 'utf8'));
        observed.push(...records);
        const found = records.find(({ auth_id, model: key }) => auth_id?.replace(/\.json$/i, '') === fileID && key === registeredModel);
        if (found) return found;
      }
      return false;
    }, 'CPA 未把 HTTP 429 的模型冷却写入 .cds').catch((error) => {
      t.diagnostic(JSON.stringify({ fileID, registeredModel, observed: observed.map(({ auth_id, model }) => ({ auth_id, model })) }));
      throw error;
    });
    assert.ok(Date.parse(record.next_retry_after) >= sentAt + 120_000);

    const blocked = await send();
    assert.equal(blocked.status, 429, await blocked.text());
    assert.equal(executions.length, 1, '冷却期间不应再次调用上游');
  });
}
