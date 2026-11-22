import { readFileSync } from 'node:fs';

export const loadConsoleAsset = (rel) => readFileSync(new URL(`../../internal/admin/ui/${rel}`, import.meta.url), 'utf8');
const brand = JSON.parse(readFileSync(new URL('../../registry.json', import.meta.url), 'utf8')).plugins[0].name;

// 与 internal/admin/console.go 保持完全一致的拼装顺序，用于 UI 单元测试直接加载。
export function loadConsoleHTML() {
  return [
    '<!DOCTYPE html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>__PLUGIN_NAME__</title>',
    '<style>',
    loadConsoleAsset('styles.css'),
    '</style>',
    '</head>',
    '<body>',
    loadConsoleAsset('body.html'),
    '<script>',
    loadConsoleAsset('core.js'),
    loadConsoleAsset('accounts.js'),
    loadConsoleAsset('models.js'),
    loadConsoleAsset('tasks.js'),
    loadConsoleAsset('auth.js'),
    loadConsoleAsset('settings_logs.js'),
    '</script>',
    '</body>',
    '</html>',
    '',
  ].join('\n').replaceAll('__PLUGIN_NAME__', brand).replaceAll('__PLUGIN_VERSION__', 'v0.0.0-test');
}
