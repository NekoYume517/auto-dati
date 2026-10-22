/** Version checks, network/cache handling and release signature verification. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { verifyCrx } from '../tools/crx3.mjs';

let now = 1800000000000, calls = 0, enabled = false, alarmListener, timeoutImmediately = false;
const storage = {}, responses = [];
class Clock extends Date { static now() { return now; } }
const context = vm.createContext({ console, Date: Clock, AbortController,
  setTimeout: (fn, delay) => timeoutImmediately ? setTimeout(fn, 1) : setTimeout(fn, delay), clearTimeout,
  AD: { Settings: { get: async () => ({ updates: { autoCheck: enabled } }) } },
  chrome: { runtime: { getManifest: () => ({ version: '0.2.0' }) }, storage: { local: {
    get: async key => ({ [key]: storage[key] }), set: async value => Object.assign(storage, value)
  } }, alarms: { create: () => {}, onAlarm: { addListener: fn => { alarmListener = fn; } } } },
  fetch: async (url, options) => {
    calls++; assert.equal(url, 'https://api.github.com/repos/NekoYume517/auto-dati/releases/latest');
    assert.equal(options.credentials, 'omit'); assert.equal(options.headers.Authorization, undefined);
    const response = responses.shift();
    if (response === 'timeout') return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(Object.assign(new Error('abort'), { name: 'AbortError' }))));
    if (response instanceof Error) throw response;
    return { status: response.status || 200, ok: !response.status || response.status === 200, json: async () => response.body };
  }
});
for (const file of ['extension/common/release.js', 'extension/background/updates.js']) vm.runInContext(fs.readFileSync(file, 'utf8'), context);
await new Promise(resolve => setTimeout(resolve, 0));
const { Release, Updates } = context.AD;
let count = 0;
function ok(name, condition) { assert.ok(condition, name); count++; console.log('  ✓ ' + name); }
const release = tag => ({ tag_name: tag, html_url: 'https://github.com/NekoYume517/auto-dati/releases/tag/' + tag, draft: false, prerelease: false });
ok('数字版本比较支持 v 前缀和四段版本，不按字符串排序', Release.compare('v0.2.10', '0.2.9') > 0 && Release.compare('0.2.0.0', 'v0.2.0') === 0);
ok('拒绝非正式版本、异常和越界版本号', !Release.version('v0.3.0-rc1') && !Release.version('1.2.70000') && !Release.version('javascript:alert(1)'));
ok('关闭自动检查时启动不请求 GitHub', calls === 0);
responses.push({ body: release('v0.3.0') });
const [first, duplicate] = await Promise.all([Updates.check(true), Updates.check(true)]);
ok('并发检查只请求一次，识别新版本并使用发布地址', calls === 1 && first.available && duplicate.latest === '0.3.0' && first.releaseUrl.endsWith('/tag/v0.3.0'));
await Updates.check(true);
ok('重复手动检查使用短期缓存，避免 GitHub 限流', calls === 1);
now += 61000; responses.push({ status: 404 });
const missing = await Updates.check(true);
ok('尚无 Release 时明确提示，保留上次成功记录', missing.error.includes('尚未发布') && missing.checkedAt === first.checkedAt && missing.available);
now += 61000; responses.push({ status: 429 });
ok('限流有可读提示', (await Updates.check(true)).error.includes('受限'));
now += 61000; responses.push({ body: { ...release('v0.4.0'), html_url: 'https://evil.example/update' } });
ok('拒绝其他仓库或站点注入的发布链接', (await Updates.check(true)).error.includes('发布地址无效'));
now += 61000; responses.push({ body: { ...release('v0.4.0'), prerelease: true } });
ok('不把预发布版本当正式更新', (await Updates.check(true)).error.includes('正式版本'));
now += 61000; responses.push(new Error('network unavailable'));
ok('网络异常不会覆盖已缓存版本或安装任何文件', (await Updates.check(true)).latest === '0.3.0');
now += 61000; responses.push('timeout'); timeoutImmediately = true;
ok('请求超时能退出并显示重试提示', (await Updates.check(true)).error.includes('超时')); timeoutImmediately = false;
now += 61000; responses.push({ body: release('v0.2.0') });
ok('同版本不会误报更新', !(await Updates.check(true)).available);
const beforeAlarm = calls; alarmListener({ name: 'dati_release_check' }); await new Promise(resolve => setTimeout(resolve, 0));
ok('定时检查遵守用户关闭设置', calls === beforeAlarm);
storage.dati_release_update.releaseUrl = 'javascript:alert(1)';
ok('被篡改的缓存地址不会被打开', (await Updates.status()).releaseUrl === Release.latest);
const crx = fs.readFileSync('dist/auto-dati-v0.2.0.crx'), verified = verifyCrx(crx);
ok('CRX3 签名有效，ZIP 与单独发布文件完全相同', verified.zip.equals(fs.readFileSync('dist/auto-dati-v0.2.0.zip')));
const tampered = Buffer.from(crx); tampered[tampered.length - 1] ^= 1;
assert.throws(() => verifyCrx(tampered));
ok('修改 CRX 任意负载字节会导致验签失败', true);
console.log('\n更新与签名回归：' + count + ' 通过');
