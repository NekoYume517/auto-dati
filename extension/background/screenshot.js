/**
 * AutoDati · 截图与裁剪（仅 Service Worker）
 * captureVisibleTab 只能截可视区域；这里按元素 rect 裁剪并可选降采样。
 */
(function (AD) {
  'use strict';

  function blobToDataUrl(blob) {
    return new Promise(function (resolve, reject) {
      try {
        const fr = new FileReader();
        fr.onload = function () { resolve(String(fr.result || '')); };
        fr.onerror = function () { reject(fr.error || new Error('read failed')); };
        fr.readAsDataURL(blob);
      } catch (e) {
        reject(e);
      }
    });
  }

  /**
   * @param {object} args
   *   rect     {x,y,w,h} 视口 CSS 坐标（capture 时页面不能滚动）
   *   viewport {w,h}     视口 CSS 尺寸，用于换算真实缩放比
   *   format   'png'|'jpeg'
   *   crop     是否裁剪
   *   maxSide  最长边上限
   *   quality  jpeg 质量 0..1
   * @returns {Promise<{dataUrl,width,height,mime}>}
   */
  async function capture(args) {
    args = args || {};
    const format = args.format === 'jpeg' ? 'jpeg' : 'png';
    const maxSide = Math.max(64, Number(args.maxSide) || 1600);

    let dataUrl;
    try {
      dataUrl = await chrome.tabs.captureVisibleTab(undefined, {
        format: 'png',
        quality: 100
      });
    } catch (e) {
      throw new Error('截图失败：' + ((e && e.message) || e) + '（请确认当前标签页处于激活状态）');
    }

    let bitmap;
    try {
      const blob = await (await fetch(dataUrl)).blob();
      bitmap = await createImageBitmap(blob);
    } catch (e) {
      // 无法解码时直接返回原图，保证功能可用
      return { dataUrl: dataUrl, width: 0, height: 0, mime: 'image/png', raw: true };
    }

    const vw = Number(args.viewport && args.viewport.w) || bitmap.width;
    const vh = Number(args.viewport && args.viewport.h) || bitmap.height;
    const scale = vw > 0 ? bitmap.width / vw : (args.dpr || 1);

    let sx = 0, sy = 0, sw = bitmap.width, sh = bitmap.height;
    const rect = args.rect;
    if (args.crop !== false && rect && rect.w > 1 && rect.h > 1) {
      sx = Math.max(0, Math.round(rect.x * scale));
      sy = Math.max(0, Math.round(rect.y * scale));
      sw = Math.round(rect.w * scale);
      sh = Math.round(rect.h * scale);
      // 边界保护
      if (sx + sw > bitmap.width) sw = bitmap.width - sx;
      if (sy + sh > bitmap.height) sh = bitmap.height - sy;
      if (sw < 2 || sh < 2) { sx = 0; sy = 0; sw = bitmap.width; sh = bitmap.height; }
    }

    const outScale = Math.min(1, maxSide / Math.max(sw, sh));
    const ow = Math.max(1, Math.round(sw * outScale));
    const oh = Math.max(1, Math.round(sh * outScale));

    const canvas = new OffscreenCanvas(ow, oh);
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    if (format === 'jpeg') {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, ow, oh);
    }
    ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, ow, oh);
    try { bitmap.close && bitmap.close(); } catch (e) { /* noop */ }

    const type = format === 'jpeg' ? 'image/jpeg' : 'image/png';
    const blob = await canvas.convertToBlob({
      type: type,
      quality: format === 'jpeg' ? Math.min(0.95, Math.max(0.5, Number(args.quality) || 0.9)) : undefined
    });
    const outUrl = await blobToDataUrl(blob);

    return { dataUrl: outUrl, width: ow, height: oh, mime: type, scale: scale };
  }

  AD.Shot = { capture: capture, blobToDataUrl: blobToDataUrl };
}(globalThis.AD = globalThis.AD || {}));