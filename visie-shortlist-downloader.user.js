// ==UserScript==
// @name         Visie 收藏原图批量下载
// @namespace    local.visie.shortlist-downloader
// @version      1.1.0
// @description  在已登录的 Chrome 中选择 Visie 收藏原图，自动分包保存 ZIP；支持预览选图、设置记忆、停止及失败重试。
// @match        https://visie.io/*
// @match        https://www.visie.io/*
// @run-at       document-idle
// @noframes
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      cdn.visie.io
// @connect      visie.io
// @connect      www.visie.io
// @license      MIT
// ==/UserScript==

(function () {
  'use strict';

  const VERSION = '1.1.0';
  const ALLOWED_HOSTS = new Set(['cdn.visie.io', 'visie.io', 'www.visie.io']);
  const MAX_IMAGE_BYTES = 64 * 1024 * 1024;
  const PART_BYTES = 64 * 1024 * 1024;
  const encoder = new TextEncoder();

  function safeName(value, length = 90) {
    let name = String(value ?? '').normalize('NFC')
      .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '_').trim();
    name = Array.from(name).slice(0, length).join('').replace(/[. ]+$/g, '');
    if (!name || /^\.+$/.test(name)) name = '未命名';
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = '_' + name;
    return name;
  }

  function allowedImageUrl(value) {
    if (typeof value !== 'string' || !value.trim()) return null;
    try {
      const url = new URL(value, 'https://visie.io/');
      if (url.protocol !== 'https:' || url.port || url.username || url.password ||
          !ALLOWED_HOSTS.has(url.hostname)) return null;
      url.hash = '';
      return url.href;
    } catch { return null; }
  }

  function collectImages(page, expectedId) {
    const list = page?.props?.shortlist;
    if (!list) throw new Error('未读到收藏数据。请在平时使用的 Chrome 登录 Visie，再打开收藏详情页。');
    if (String(list.id) !== String(expectedId)) throw new Error('收藏编号不一致，已停止，避免下载错误的收藏。');
    if (!Array.isArray(list.items)) throw new Error('收藏数据结构已变化，不能确认清单完整；请勿把结果当成全部图片。');
    if (list.next_page_url || Number(list.items_count) > list.items.length) {
      throw new Error('网站返回了分页清单，本版无法确认完整性，已停止。');
    }
    const stats = { videos: 0, duplicates: 0, unavailable: 0, unsupported: 0, rejected: 0 };
    const images = [], projects = [];
    const seen = new Set();
    list.items.forEach((row, rowIndex) => {
      if (!row || ['headline', 'text'].includes(row.type)) return;
      if (!['project', 'profile', 'media', 'image'].includes(row.type)) {
        stats.unsupported++;
        return;
      }
      const item = row.item;
      if (!item) { stats.unavailable++; return; }
      const media = ['media', 'image'].includes(row.type) ? [item] : item.media;
      if (!Array.isArray(media)) {
        throw new Error('某个收藏条目的图片清单不是数组，无法确认完整性，已停止。');
      }
      const group = `${row.type}:${item.id ?? rowIndex}:${rowIndex}`;
      const project = {
        key: group, index: projects.length + 1, type: row.type,
        name: String(item.name || row.name || '未命名项目'),
        fullName: String(item.full_name || item.name || row.name || ''),
        brand: Array.isArray(item.clients) ? item.clients.map(c => c?.name).filter(Boolean).join('、')
          : Array.isArray(item.professions) ? item.professions.map(p => p?.name || p).filter(v => typeof v === 'string').join('、') : '',
        date: typeof item.date === 'string' ? item.date.slice(0, 10) : '',
        url: typeof item.url === 'string' ? item.url : '', count: 0, cover: ''
      };
      for (const entry of media) {
        if (!entry || typeof entry !== 'object') { stats.rejected++; continue; }
        if (entry.type === 'video' || /\.(mp4|mov|webm|m3u8)(?:[?#]|$)/i.test(entry.url || '')) {
          stats.videos++;
          continue;
        }
        if (entry.type !== 'image') { stats.unsupported++; continue; }
        const url = allowedImageUrl(entry.url);
        if (!url) { stats.rejected++; continue; }
        if (seen.has(url)) { stats.duplicates++; continue; }
        seen.add(url);
        project.count++;
        if (!project.cover) project.cover = url;
        images.push({
          sequence: images.length + 1, id: entry.id ?? null, url,
          name: String(entry.name || `image-${entry.id || images.length + 1}`),
          group, project: project.name, fullName: project.fullName, brand: project.brand, date: project.date,
          projectIndex: project.index, indexInProject: project.count,
          projectUrl: project.url, link: allowedImageUrl(entry.link) ? entry.link : '',
          width: Number(entry.width) || null, height: Number(entry.height) || null
        });
      }
      if (project.count) projects.push(project);
    });
    for (const image of images) image.projectTotal = projects.find(p => p.key === image.group)?.count || 1;
    return { id: String(list.id), title: String(list.name || list.title || `收藏-${list.id}`), images, projects, stats };
  }

  function readPageData(doc) {
    const script = doc.querySelector('script[data-page="app"][type="application/json"]');
    const legacy = doc.querySelector('#app[data-page]');
    const text = script?.textContent || legacy?.getAttribute('data-page');
    if (!text) throw new Error('页面未返回收藏数据，可能尚未登录、无权访问或遇到网站验证。请在 Chrome 打开该收藏确认。');
    try { return JSON.parse(text); }
    catch { throw new Error('无法解析收藏数据，网站格式可能已变化。'); }
  }

  function imageExtension(bytes) {
    if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'jpg';
    if (bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v)) return 'png';
    const head = String.fromCharCode(...bytes.subarray(0, 64));
    if (/^GIF8[79]a/.test(head)) return 'gif';
    if (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP') return 'webp';
    if (head.slice(4, 8) === 'ftyp' && /avif|avis/.test(head.slice(8))) return 'avif';
    if (head.startsWith('II*\0') || head.startsWith('MM\0*')) return 'tif';
    if (head.startsWith('BM')) return 'bmp';
    throw new Error('响应不是支持的图片文件（可能是登录页、错误页或未知格式），未保存为图片。');
  }

  // 命名字段：{字段名}；未知字段原样保留提示，空字段自动省略多余分隔符。
  const NAME_FIELDS = {
    '收藏': (item, ctx) => ctx?.collection || '',
    '项目': item => item.project,
    '完整标题': item => item.fullName || item.project,
    '品牌': item => item.brand,
    '日期': item => item.date,
    '项目序号': item => String(item.projectIndex || 1).padStart(3, '0'),
    '图片序号': item => String(item.indexInProject || item.sequence).padStart(2, '0'),
    '总序号': item => String(item.sequence).padStart(4, '0'),
    '原文件名': item => String(item.name || '').replace(/\.[a-z0-9]{1,8}$/i, ''),
    '尺寸': item => item.width && item.height ? `${item.width}x${item.height}` : '',
    '图片ID': item => item.id == null ? '' : String(item.id)
  };
  const DEFAULT_FOLDER_TEMPLATE = '{项目序号}_{品牌}_{项目}';
  const DEFAULT_FILE_TEMPLATE = '{项目}_{图片序号}';

  function renderTemplate(template, item, ctx, length = 120) {
    const text = String(template || '').replace(/\{([^{}]+)\}/g, (_, key) => {
      const field = NAME_FIELDS[key.trim()];
      return field ? safeName(field(item, ctx) || '', 80).replace(/^未命名$/, '') : '';
    });
    const cleaned = text.replace(/([_\-\s.·])\1+/g, '$1').replace(/^[_\-\s.·]+|[_\-\s.·]+$/g, '')
      .replace(/[_\-\s·]+(?=[_\-\s·])/g, '');
    return safeName(cleaned, length);
  }

  function makeNamer(folderTemplate, fileTemplate, ctx) {
    const used = new Set();
    return (item, extension) => {
      const folder = folderTemplate === '' ? '' : renderTemplate(folderTemplate || DEFAULT_FOLDER_TEMPLATE, item, ctx, 100);
      const stem = renderTemplate(fileTemplate || DEFAULT_FILE_TEMPLATE, item, ctx, 120);
      let candidate = `${folder ? folder + '/' : ''}${stem}.${extension}`;
      for (let n = 2; used.has(candidate.toLowerCase()); n++) candidate = `${folder ? folder + '/' : ''}${stem}_${n}.${extension}`;
      used.add(candidate.toLowerCase());
      return candidate;
    };
  }

  function imagePath(item, extension, namer) {
    return (namer || makeNamer())(item, extension);
  }

  // 仅用于选图预览的小图；Visie CDN 对原图提供 _small.webp。原图下载不受影响。
  function previewUrl(url) {
    const safe = allowedImageUrl(url);
    if (!safe) return null;
    const u = new URL(safe);
    if (u.hostname !== 'cdn.visie.io' || !/\.(jpe?g|png|webp)$/i.test(u.pathname) || /_(small|medium|large)\.webp$/i.test(u.pathname)) return safe;
    u.pathname = u.pathname.replace(/\.(jpe?g|png|webp)$/i, '_small.webp');
    return u.href;
  }

  const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
    for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
    return n >>> 0;
  });
  function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }

  // ZIP STORE: 图片本身已压缩；不加载外部库，不重新压缩图片。
  function makeZip(files) {
    if (files.length > 65535) throw new Error('单包文件过多。');
    const local = [], central = [];
    let offset = 0, centralSize = 0;
    for (const file of files) {
      const name = encoder.encode(file.name);
      const data = file.data instanceof Uint8Array ? file.data : encoder.encode(file.data);
      if (name.length > 65535 || data.length > 0xffffffff || offset + data.length + name.length + 30 > 0xffffffff) {
        throw new Error('ZIP 超出本版安全大小限制。');
      }
      const crc = crc32(data);
      const header = new Uint8Array(30), h = new DataView(header.buffer);
      h.setUint32(0, 0x04034b50, true);
      h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true);
      h.setUint16(12, 33, true); // 1980-01-01，合法且可复现的 ZIP 日期。
      h.setUint32(14, crc, true); h.setUint32(18, data.length, true); h.setUint32(22, data.length, true);
      h.setUint16(26, name.length, true);
      local.push(header, name, data);
      const record = new Uint8Array(46), c = new DataView(record.buffer);
      c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true);
      c.setUint16(8, 0x0800, true); c.setUint16(14, 33, true); c.setUint32(16, crc, true);
      c.setUint32(20, data.length, true); c.setUint32(24, data.length, true);
      c.setUint16(28, name.length, true); c.setUint32(42, offset, true);
      central.push(record, name);
      offset += header.length + name.length + data.length;
      centralSize += record.length + name.length;
    }
    const end = new Uint8Array(22), e = new DataView(end.buffer);
    e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true);
    e.setUint32(12, centralSize, true); e.setUint32(16, offset, true);
    return new Blob([...local, ...central, end], { type: 'application/zip' });
  }

  function aborted(signal) {
    if (signal?.aborted) throw signal.reason || new DOMException('任务已停止', 'AbortError');
  }
  function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(signal.reason); return; }
      const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
      const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  function requestImage(url, signal, request) {
    return new Promise((resolve, reject) => {
      if (!allowedImageUrl(url)) { reject(new Error('图片域名不在 Visie 白名单内。')); return; }
      if (signal?.aborted) { reject(signal.reason); return; }
      let handle, settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        error ? reject(error) : resolve(value);
      };
      const onAbort = () => {
        finish(signal.reason || new DOMException('任务已停止', 'AbortError'));
        handle?.abort();
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        handle = request({
          method: 'GET', url, responseType: 'arraybuffer', timeout: 60000,
          anonymous: new URL(url).hostname === 'cdn.visie.io',
          onprogress: event => {
            if (event.loaded > MAX_IMAGE_BYTES || event.total > MAX_IMAGE_BYTES) {
              finish(new Error('单张图片超过 64 MiB，请用导出的链接单独下载。'));
              handle?.abort();
            }
          },
          onload: response => {
            if (settled) return;
            try {
              if (response.status < 200 || response.status >= 300) {
                const error = new Error(`HTTP ${response.status}`);
                error.status = response.status;
                const retry = /^retry-after:\s*(.+)$/im.exec(response.responseHeaders || '')?.[1]?.trim();
                const seconds = retry && /^\d+$/.test(retry) ? Number(retry) : (Date.parse(retry) - Date.now()) / 1000;
                error.retryMs = Number.isFinite(seconds) ? Math.min(60000, Math.max(0, seconds * 1000)) : 0;
                throw error;
              }
              if (response.finalUrl && !allowedImageUrl(response.finalUrl)) throw new Error('图片重定向到非 Visie 域名，已拒绝。');
              if (!response.response || typeof response.response.byteLength !== 'number') throw new Error('脚本管理器未返回二进制图片。');
              const data = new Uint8Array(response.response);
              if (data.length > MAX_IMAGE_BYTES) throw new Error('单张图片超过 64 MiB。');
              finish(null, { data, extension: imageExtension(data) });
            } catch (error) { finish(error); }
          },
          onerror: () => finish(Object.assign(new Error('网络错误，检查脚本猫的跨域请求授权。'), { transient: true })),
          ontimeout: () => finish(Object.assign(new Error('图片下载超时。'), { transient: true })),
          onabort: () => finish(signal?.reason || new DOMException('请求已取消', 'AbortError'))
        });
      } catch (error) { finish(error); }
    });
  }

  async function downloadImage(url, signal, request, wait = sleep, notify = () => {}) {
    for (let attempt = 0; attempt < 3; attempt++) {
      aborted(signal);
      try { return await requestImage(url, signal, request); }
      catch (error) {
        aborted(signal);
        const retryable = error.transient || error.status === 429 || error.status >= 500;
        if (!retryable || attempt === 2) throw error;
        const delay = Math.max(error.retryMs || 0, error.status === 429 ? 10000 : 800 * 2 ** attempt);
        notify(`请求失败，${Math.ceil(delay / 1000)} 秒后重试（${attempt + 1}/2）…`);
        await wait(delay, signal);
      }
    }
  }

  const core = { safeName, allowedImageUrl, collectImages, readPageData, imageExtension, imagePath, crc32, makeZip, requestImage, downloadImage,
    NAME_FIELDS, renderTemplate, makeNamer, previewUrl, DEFAULT_FOLDER_TEMPLATE, DEFAULT_FILE_TEMPLATE };
  if (typeof module === 'object' && module.exports && typeof window === 'undefined') {
    module.exports = core;
    return;
  }
  if (window.top !== window.self || document.getElementById('visie-local-downloader')) return;

  const SETTINGS_KEY = 'visie-downloader-settings-v1';
  const PAGE_SIZE = 48;
  const HISTORY_KEY = 'visie-downloader-history-v1';
  const PRESETS = [
    { label: '按项目分文件夹（推荐）', folder: DEFAULT_FOLDER_TEMPLATE, file: DEFAULT_FILE_TEMPLATE },
    { label: '品牌_日期_项目', folder: '{品牌}_{日期}_{项目}', file: '{品牌}_{项目}_{图片序号}' },
    { label: '全部放一个文件夹', folder: '', file: '{品牌}_{项目}_{图片序号}' },
    { label: '保留 Visie 原文件名', folder: '{项目序号}_{项目}', file: '{原文件名}' }
  ];
  const tpl = (value, fallback) => typeof value === 'string' && value.length <= 200 ? value : fallback;
  let preferences = { autoSave: true, size: 50, folderTemplate: DEFAULT_FOLDER_TEMPLATE, fileTemplate: DEFAULT_FILE_TEMPLATE, hideDone: false };
  let history = {};
  try {
    const stored = typeof GM_getValue === 'function' ? GM_getValue(SETTINGS_KEY, {}) : {};
    preferences = {
      autoSave: typeof stored?.autoSave === 'boolean' ? stored.autoSave : true,
      size: [25, 50, 100].includes(Number(stored?.size)) ? Number(stored.size) : 50,
      folderTemplate: tpl(stored?.folderTemplate, DEFAULT_FOLDER_TEMPLATE),
      fileTemplate: tpl(stored?.fileTemplate, DEFAULT_FILE_TEMPLATE) || DEFAULT_FILE_TEMPLATE,
      hideDone: stored?.hideDone === true
    };
    const h = typeof GM_getValue === 'function' ? GM_getValue(HISTORY_KEY, {}) : {};
    if (h && typeof h === 'object' && !Array.isArray(h)) history = h;
  } catch { /* 设置读取失败不阻止下载，使用默认值。 */ }
  const itemKey = item => item.id != null ? String(item.id) : item.url;

  const host = document.createElement('div');
  host.id = 'visie-local-downloader';
  host.style.cssText = 'all:initial;position:fixed;right:20px;bottom:20px;z-index:2147483647;';
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>
      :host{font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#18181b;color-scheme:light}
      :host([hidden]),[hidden]{display:none!important}*{box-sizing:border-box}
      button,select,input{font:inherit}button{cursor:pointer;border:1px solid #d4d4d8;border-radius:8px;background:#fff;padding:7px 11px;color:#18181b}
      button:hover:not(:disabled){background:#f4f4f5}button:disabled{opacity:.45;cursor:not-allowed}
      button:focus-visible,select:focus-visible,input:focus-visible{outline:2px solid #2563eb;outline-offset:2px}
      .primary{background:#18181b;color:#fff;border-color:#18181b}.primary:hover:not(:disabled){background:#3f3f46}
      #toggle{float:right;box-shadow:0 4px 20px #0002}#panel{clear:both;width:min(380px,calc(100vw - 40px));max-height:80vh;overflow:auto;background:white;border:1px solid #ddd;border-radius:12px;padding:16px;box-shadow:0 8px 35px #0003;margin-bottom:10px}
      h3{font-size:16px;margin:0}p{margin:8px 0}.muted{font-size:12px;color:#666}.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:10px}
      #status{white-space:pre-wrap;overflow-wrap:anywhere;max-height:160px;overflow:auto}progress{width:100%;accent-color:#18181b;margin-top:12px}
      #save{width:100%;background:#166534;color:white;margin-top:10px}select{border:1px solid #ddd;border-radius:6px;padding:5px;max-width:100%;background:white;color:#18181b}
      details{margin-top:10px}summary{cursor:pointer}input[type=checkbox]{accent-color:#18181b}label{cursor:pointer}
      #picker{border:1px solid #ddd;border-radius:16px;padding:0;background:white;color:#18181b;width:min(1000px,94vw);max-height:90vh;box-shadow:0 20px 80px #0004;font:inherit}
      #picker::backdrop{background:#0007;backdrop-filter:blur(3px)}.picker-head,.picker-foot{padding:16px 20px}.picker-head{border-bottom:1px solid #eee}.picker-title-row{display:flex;justify-content:space-between;gap:12px;align-items:center}
      #picker-title{font-size:19px;margin:0}.picker-foot{border-top:1px solid #eee;display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap}
      #gallery{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:12px;padding:18px 20px;max-height:52vh;overflow:auto;min-height:180px}
      .preview-card{position:relative;border:2px solid #e4e4e7;border-radius:9px;overflow:hidden;padding:7px;background:#fff;font-size:12px;min-width:0}
      .preview-card:has(input:checked){border-color:#2563eb;background:#eff6ff}.preview-card input{position:absolute;top:9px;left:9px;width:18px;height:18px;z-index:1}
      .preview-card img{display:block;width:100%;height:135px;object-fit:contain;background:#f4f4f5;border-radius:5px}.preview-card strong,.preview-card small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.preview-card strong{margin-top:6px}.preview-card small{color:#666}
      .preview-error{height:135px;display:flex;align-items:center;text-align:center;color:#777}.pager{justify-content:center;margin:0;padding:8px}
      @media(max-width:700px){#gallery{grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;padding:12px}.preview-card img,.preview-error{height:105px}.picker-head,.picker-foot{padding:12px}}
    </style>
    <section id="panel" hidden aria-label="Visie 图片下载面板">
      <h3>Visie 收藏原图下载 <small class="muted">v1.1</small></h3>
      <div class="row"><button id="start" class="primary" disabled>选择图片并下载</button><button id="scan">重新读取</button><button id="choose" disabled>重新选图</button></div>
      <div class="row"><button id="retry" disabled>重试失败</button><button id="links" disabled>导出所选链接</button><button id="stop" disabled>停止</button></div>
      <details><summary>下载设置（自动记住）</summary>
        <div class="row"><label><input id="auto" type="checkbox" checked> 自动保存 ZIP，不逐包确认</label></div>
        <div class="row"><label>每包最多 <select id="size"><option>25</option><option selected>50</option><option>100</option></select> 张</label><span class="muted">约 64 MiB 提前分包</span></div>
      </details>
      <progress id="progress" value="0" max="1"></progress>
      <p id="summary" class="muted"></p><p id="status" role="status" aria-live="polite">点击入口即可读取收藏并选图。</p>
      <button id="save" hidden>保存 ZIP 并继续</button>
      <div class="row"><button id="resave" hidden>重新保存最近一包</button></div>
      <p class="muted">自动保存请允许 Chrome 的多文件下载，并核对下载列表；受拦截可改用手动模式。仅保留最近一包供补存。关闭或刷新页面会丢失未保存进度。</p>
    </section>
    <button id="toggle" aria-expanded="false">↓ Visie 下载</button>
    <dialog id="picker" aria-labelledby="picker-title">
      <header class="picker-head">
        <div class="picker-title-row"><h2 id="picker-title">选择要下载的图片</h2><button id="close-picker" aria-label="关闭选图窗口">✕</button></div>
        <p id="picker-note" class="muted"></p>
        <div class="row"><select id="group" aria-label="筛选项目"><option value="">全部项目</option></select><button id="all">全选当前范围</button><button id="none">清空当前范围</button><button id="invert">反选当前范围</button></div>
      </header>
      <div id="gallery" aria-label="图片选择列表"></div>
      <div class="row pager"><button id="previous">上一页</button><span id="page-label" class="muted"></span><button id="next">下一页</button></div>
      <footer class="picker-foot"><span id="selection-count"></span><div class="row"><button id="cancel-picker">稍后下载</button><button id="confirm" class="primary">开始下载</button></div></footer>
    </dialog>`;
  document.documentElement.appendChild(host);
  const $ = id => shadow.getElementById(id);
  const state = { collection: null, source: '', items: [], selected: new Set(), taskItems: [], remaining: [], failed: new Map(), done: new Set(), busy: false, controller: null, ready: null, lastSaved: null, part: 0, saves: 0, started: false, galleryPage: 0 };
  const routeId = () => /^\/shortlists\/(\d+)\/?$/.exec(location.pathname)?.[1];
  const routeKey = () => location.origin + location.pathname + location.search;
  const status = text => { $('status').textContent = text; };
  const openPanel = () => { $('panel').hidden = false; $('toggle').setAttribute('aria-expanded', 'true'); };
  const selectedItems = () => state.items.filter(item => state.selected.has(item.url));
  const filteredItems = () => state.items.filter(item => !$('group').value || item.group === $('group').value);
  $('auto').checked = preferences.autoSave;
  $('size').value = String(preferences.size);

  function rememberSettings() {
    preferences = { autoSave: $('auto').checked, size: Number($('size').value) };
    try {
      if (typeof GM_setValue === 'function') {
        Promise.resolve(GM_setValue(SETTINGS_KEY, preferences)).catch(() => status('设置未能持久保存；本次仍有效。'));
      }
    } catch { status('设置未能持久保存；本次仍有效。'); }
  }
  $('auto').onchange = rememberSettings;
  $('size').onchange = rememberSettings;

  function render() {
    const locked = state.busy || !!state.ready;
    $('scan').disabled = locked || !routeId();
    $('size').disabled = locked; $('auto').disabled = locked;
    $('choose').disabled = locked || !state.items.length;
    $('start').disabled = locked || (state.started ? !state.remaining.length : !state.items.length);
    $('start').textContent = state.started ? '继续剩余图片' : '选择图片并下载';
    $('retry').disabled = locked || !state.failed.size;
    $('links').disabled = !state.selected.size || state.busy;
    $('stop').disabled = !state.busy;
    $('save').hidden = !state.ready;
    $('resave').hidden = !state.lastSaved || !!state.ready;
    if (state.lastSaved) $('resave').title = state.lastSaved.filename;
    $('progress').max = Math.max(1, state.started ? state.taskItems.length : state.selected.size);
    $('progress').value = state.done.size;
    $('summary').textContent = state.collection
      ? `${state.collection.title}：共 ${state.items.length} 张，已选 ${state.selected.size} 张${state.started ? `；已获取 ${state.done.size}/${state.taskItems.length}；失败 ${state.failed.size}；待处理 ${state.remaining.length}；已发起 ${state.saves} 包保存` : ''}` : '';
  }

  function updateSelectionCount() {
    $('selection-count').textContent = `已选 ${state.selected.size} / ${state.items.length} 张`;
    $('confirm').textContent = `开始下载（${state.selected.size} 张）`;
    $('confirm').disabled = !state.selected.size;
    render();
  }

  function renderGallery() {
    const items = filteredItems(), pages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
    state.galleryPage = Math.min(state.galleryPage, pages - 1);
    $('gallery').replaceChildren();
    for (const item of items.slice(state.galleryPage * PAGE_SIZE, (state.galleryPage + 1) * PAGE_SIZE)) {
      const card = document.createElement('label'); card.className = 'preview-card';
      const box = document.createElement('input'); box.type = 'checkbox'; box.checked = state.selected.has(item.url);
      box.dataset.url = item.url; box.setAttribute('aria-label', `${item.sequence}. ${item.project} ${item.name}`);
      box.onchange = () => { box.checked ? state.selected.add(item.url) : state.selected.delete(item.url); updateSelectionCount(); };
      const img = document.createElement('img'); img.alt = item.name; img.loading = 'lazy'; img.decoding = 'async'; img.referrerPolicy = 'no-referrer';
      img.onerror = () => { const error = document.createElement('span'); error.className = 'preview-error'; error.textContent = '预览不可用，仍可选择原图'; img.replaceWith(error); };
      img.src = item.previewUrl || item.url;
      const title = document.createElement('strong'); title.textContent = `${item.sequence}. ${item.project || item.name}`; title.title = item.name;
      const size = document.createElement('small'); size.textContent = item.width && item.height ? `${item.width} × ${item.height}` : '尺寸未知';
      card.append(box, img, title, size); $('gallery').appendChild(card);
    }
    $('page-label').textContent = `第 ${state.galleryPage + 1} / ${pages} 页 · 当前范围 ${items.length} 张`;
    $('previous').disabled = state.galleryPage === 0; $('next').disabled = state.galleryPage + 1 === pages;
    $('gallery').scrollTop = 0;
    updateSelectionCount();
  }

  function openPicker() {
    if (state.busy || state.ready) return;
    if (!state.collection || routeKey() !== state.source) { scan(); return; }
    $('picker-note').textContent = state.started
      ? '重新开始会重置当前任务进度；可能重新下载之前的图片。只想继续，请关闭窗口并点「继续剩余图片」。'
      : '默认全部选中，也可逐张或按项目选择。筛选项目不会自动取消其他项目；只下某项目请先清空全部，再筛选并全选。';
    renderGallery();
    if (!$('picker').open) $('picker').showModal();
  }

  function saveBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url; anchor.download = filename;
    document.documentElement.appendChild(anchor);
    try { anchor.click(); }
    finally { anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000); }
  }

  async function scan() {
    if (state.busy || state.ready || !routeId()) return;
    $('picker').close();
    state.busy = true; state.controller = new AbortController();
    const signal = state.controller.signal, source = routeKey(), id = routeId();
    state.collection = null; state.source = ''; state.items = []; state.remaining = []; state.taskItems = [];
    state.selected.clear(); state.failed.clear(); state.done.clear(); state.part = 0; state.saves = 0; state.started = false;
    render(); status('正在读取收藏，稍后自动打开选图窗口…');
    let success = false;
    const timer = setTimeout(() => state.controller?.abort(new DOMException('读取超时，请检查网络后重试。', 'AbortError')), 45000);
    try {
      const response = await fetch(source, { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'text/html' }, signal });
      if (!response.ok) throw new Error(`读取收藏失败：HTTP ${response.status}。请确认当前账号有访问权限。`);
      if (new URL(response.url).pathname !== new URL(source).pathname) throw new Error('网站跳转到了其他页面，请先在此 Chrome 登录并打开收藏。');
      const text = await response.text(); aborted(signal);
      if (routeKey() !== source) throw new Error('收藏页面已切换，请重新读取。');
      const doc = new DOMParser().parseFromString(text, 'text/html');
      const collection = collectImages(readPageData(doc), id);
      // 只使用页面实际声明的预览地址；原图下载仍使用 media.url。
      const previews = new Map();
      for (const img of [...doc.querySelectorAll('img[id]'), ...document.querySelectorAll('img[id]')]) {
        const url = allowedImageUrl(img.currentSrc || img.getAttribute('src'));
        if (url) previews.set(img.id, url);
      }
      for (const item of collection.images) item.previewUrl = previews.get(String(item.id)) || item.url;
      state.collection = collection; state.source = source; state.items = collection.images;
      state.selected = new Set(state.items.map(item => item.url)); state.galleryPage = 0;
      $('group').replaceChildren(new Option('全部项目', ''));
      for (const [group, title] of new Map(state.items.map(item => [item.group, item.project || item.group]))) $('group').add(new Option(title, group));
      const s = collection.stats;
      const warnings = [s.videos && `跳过 ${s.videos} 个视频`, s.duplicates && `去重 ${s.duplicates} 张`, s.unavailable && `${s.unavailable} 个条目已不可用`, s.unsupported && `${s.unsupported} 个未知类型未读取`, s.rejected && `${s.rejected} 个图片地址不受支持`].filter(Boolean);
      status(`${state.items.length ? '清单已就绪，无需滚动页面。选好图片即可开始下载。' : '未找到可下载的图片。'}${warnings.length ? '\n' + warnings.join('；') + '。' : ''}`);
      success = !!state.items.length;
    } catch (error) { status(error.message); }
    finally { clearTimeout(timer); state.busy = false; state.controller = null; render(); }
    if (success) openPicker();
  }

  function report(failures) {
    return JSON.stringify({ version: VERSION, collection: state.collection?.title,
      source: state.source.split('?')[0], createdAt: new Date().toISOString(), selectedCount: state.taskItems.length,
      scope: '仅所选收藏图片；使用 media.url，不推测地址、不降级缩略图。保存次数只代表已发起下载，需核对浏览器下载列表。',
      skipped: state.collection?.stats, failed: failures }, null, 2);
  }

  function stagePart(files, records, failures, signal) {
    const part = ++state.part;
    const blob = makeZip([...files, { name: '图片清单.json', data: JSON.stringify(records, null, 2) }, { name: '下载报告.json', data: report(failures) }]);
    const filename = `${safeName(state.collection.title, 70)}_${state.collection.id}_part-${String(part).padStart(3, '0')}.zip`;
    const packet = { blob, filename };
    let autoError = '';
    if (preferences.autoSave && signal && !signal.aborted) {
      try {
        saveBlob(blob, filename); state.lastSaved = packet; state.saves++;
        status(`已发起第 ${part} 包保存，继续下载。请允许浏览器多文件下载并核对下载列表。`);
        render(); return Promise.resolve();
      } catch (error) {
        autoError = `自动保存失败：${error.message}。已切换手动模式。\n`;
        $('auto').checked = false; rememberSettings();
      }
    }
    return new Promise((resolve, reject) => {
      const onAbort = () => { state.ready && (state.ready.resume = null); reject(signal.reason); };
      const resume = () => { signal?.removeEventListener('abort', onAbort); resolve(); };
      state.ready = { ...packet, resume };
      if (signal && !signal.aborted) signal.addEventListener('abort', onAbort, { once: true });
      else state.ready.resume = null;
      $('save').textContent = `保存第 ${part} 包（${files.length} 张，${(blob.size / 1048576).toFixed(1)} MiB）${signal && !signal.aborted ? '并继续' : ''}`;
      status(autoError + 'ZIP 已在本地准备好。点击绿色按钮保存；请检查浏览器下载列表确认落盘。');
      render();
      if (!signal || signal.aborted) resolve();
    });
  }

  async function start(retry = false) {
    if (state.busy || state.ready) return;
    if (routeKey() !== state.source) { status('当前页面与已读取的收藏不一致，请先重新读取。'); return; }
    if (typeof GM_xmlhttpRequest !== 'function') { status('缺少脚本猫下载 API。请作为用户脚本安装，不要粘贴到网页控制台。'); return; }
    if (retry) state.remaining = [...new Map([...state.failed.values()].map(f => [f.item.url, f.item]).concat(state.remaining.map(i => [i.url, i]))).values()];
    if (!state.remaining.length) return;
    state.busy = true; state.controller = new AbortController();
    const signal = state.controller.signal, maxCount = Number($('size').value);
    let files = [], records = [], bytes = 0, failures = [];
    const flush = async () => {
      const batch = files, entries = records, errors = failures;
      files = []; records = []; bytes = 0; failures = [];
      await stagePart(batch, entries, errors, signal); aborted(signal);
    };
    render();
    try {
      while (state.remaining.length) {
        aborted(signal);
        if (routeKey() !== state.source) throw new DOMException('页面已切换，任务已停止。请重新读取新收藏。', 'AbortError');
        const item = state.remaining[0]; status(`正在下载：${item.project}\n${item.name}`);
        let result;
        try { result = await downloadImage(item.url, signal, GM_xmlhttpRequest, sleep, status); }
        catch (error) {
          aborted(signal); if (error.name === 'AbortError') throw error;
          state.failed.set(item.url, { item, error: error.message }); failures.push({ url: item.url, name: item.name, error: error.message });
          state.remaining.shift(); render(); await sleep(250, signal); continue;
        }
        if (files.length && bytes + result.data.length > PART_BYTES) await flush();
        aborted(signal);
        const path = imagePath(item, result.extension);
        files.push({ name: path, data: result.data }); records.push({ ...item, file: path }); bytes += result.data.length;
        state.done.add(item.url); state.failed.delete(item.url); state.remaining.shift(); render();
        if (files.length >= maxCount || bytes >= PART_BYTES) await flush();
        await sleep(250, signal);
      }
      if (files.length || failures.length) await flush();
      status(`处理完成：已获取 ${state.done.size}/${state.taskItems.length} 张，失败 ${state.failed.size} 张。\n已发起 ${state.saves} 包 ZIP 保存，请检查浏览器下载列表；失败项可重试。`);
    } catch (error) {
      if (files.length || failures.length) await stagePart(files, records, failures, null);
      status(`${error.message}\n${state.ready ? '已获取的内容仍可点击绿色按钮保存。保存后可继续剩余图片。' : '可以继续剩余图片。'}`);
    } finally { state.busy = false; state.controller = null; render(); }
  }

  function launch() {
    openPanel();
    if (!state.busy && !state.ready && (!state.collection || routeKey() !== state.source)) scan();
    else if (!state.started && !state.busy && !state.ready) openPicker();
  }
  $('toggle').onclick = () => {
    if ($('panel').hidden) launch();
    else { $('panel').hidden = true; $('toggle').setAttribute('aria-expanded', 'false'); }
  };
  $('scan').onclick = scan; $('choose').onclick = openPicker;
  $('start').onclick = () => state.started ? start() : openPicker();
  $('retry').onclick = () => start(true);
  $('stop').onclick = () => state.controller?.abort(new DOMException('你已停止任务。', 'AbortError'));
  $('links').onclick = () => saveBlob(new Blob([selectedItems().map(i => i.url).join('\n') + '\n'], { type: 'text/plain;charset=utf-8' }), `${safeName(state.collection.title)}-所选原图链接.txt`);
  $('save').onclick = () => {
    const ready = state.ready; if (!ready) return;
    try { saveBlob(ready.blob, ready.filename); }
    catch (error) { status(`无法发起保存：${error.message}。ZIP 仍保留，可重试。`); return; }
    state.lastSaved = { blob: ready.blob, filename: ready.filename }; state.saves++; state.ready = null;
    ready.resume?.();
    if (!state.busy) status('已发起 ZIP 保存，请检查下载列表。可继续剩余图片或重试失败项。');
    render();
  };
  $('resave').onclick = () => {
    if (!state.lastSaved) return;
    try { saveBlob(state.lastSaved.blob, state.lastSaved.filename); status(`已再次发起保存：${state.lastSaved.filename}。请核对下载列表。`); }
    catch (error) { status(`补存失败：${error.message}`); }
  };
  $('group').onchange = () => { state.galleryPage = 0; renderGallery(); };
  for (const mode of ['all', 'none', 'invert']) $(mode).onclick = () => {
    for (const item of filteredItems()) {
      const selected = mode === 'all' || (mode === 'invert' && !state.selected.has(item.url));
      selected ? state.selected.add(item.url) : state.selected.delete(item.url);
    }
    renderGallery();
  };
  $('previous').onclick = () => { state.galleryPage--; renderGallery(); };
  $('next').onclick = () => { state.galleryPage++; renderGallery(); };
  $('close-picker').onclick = $('cancel-picker').onclick = () => $('picker').close();
  $('confirm').onclick = () => {
    if (state.busy || state.ready || !state.selected.size) return;
    if (routeKey() !== state.source) { $('picker').close(); status('页面已切换，请重新读取收藏。'); return; }
    state.taskItems = selectedItems(); state.remaining = [...state.taskItems];
    state.done.clear(); state.failed.clear(); state.saves = 0; state.started = true;
    $('picker').close(); render(); start();
  };
  if (typeof GM_registerMenuCommand === 'function') GM_registerMenuCommand('打开 Visie 下载面板', () => {
    if (!routeId()) { alert('请先打开 Visie 的某个收藏详情页，例如 /shortlists/512。'); return; }
    launch();
  });
  let lastRoute = routeKey();
  function syncRoute() {
    const current = routeKey();
    if (current !== lastRoute) {
      lastRoute = current; $('picker').close();
      state.controller?.abort(new DOMException('页面已切换，任务已停止。请重新读取收藏。', 'AbortError'));
    }
    host.hidden = !routeId() && !state.busy && !state.ready;
    render();
  }
  window.addEventListener('beforeunload', event => {
    if (state.busy || state.ready) { event.preventDefault(); event.returnValue = ''; }
  });
  document.addEventListener('inertia:navigate', syncRoute);
  window.addEventListener('popstate', syncRoute);
  setInterval(syncRoute, 1000);
  syncRoute();
})();
