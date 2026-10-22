/** Public release metadata only. No credentials or page content are sent to GitHub. */
(function (AD) {
  'use strict';
  const repository = 'NekoYume517/auto-dati';
  function version(value) {
    const match = /^v?(\d+(?:\.\d+){1,3})$/.exec(String(value || '').trim());
    if (!match) return null;
    const parts = match[1].split('.').map(Number);
    return parts.every(function (n) { return Number.isSafeInteger(n) && n >= 0 && n <= 65535; }) ? parts : null;
  }
  function compare(a, b) {
    const left = version(a), right = version(b);
    if (!left || !right) throw new Error('版本号格式无效');
    for (let i = 0; i < 4; i++) {
      const delta = (left[i] || 0) - (right[i] || 0);
      if (delta) return delta > 0 ? 1 : -1;
    }
    return 0;
  }
  AD.Release = {
    repository: repository,
    home: 'https://github.com/' + repository,
    latest: 'https://github.com/' + repository + '/releases/latest',
    api: 'https://api.github.com/repos/' + repository + '/releases/latest',
    version: version,
    compare: compare
  };
}(globalThis.AD = globalThis.AD || {}));
