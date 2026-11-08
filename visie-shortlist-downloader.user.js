// ==UserScript==
// @name         Visie 收藏原图批量下载
// @namespace    local.visie.shortlist-downloader
// @version      1.2.0
// @description  在已登录的 Chrome 中按项目选择 Visie 收藏原图，自定义文件夹/文件命名，自动分包保存 ZIP；记住已下载项目，支持停止与失败重试。
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

  const VERSION = '1.2.0';
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
      :host{font:14px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC","Segoe UI",sans-serif;color:#18181b;color-scheme:light}
      :host([hidden]),[hidden]{display:none!important}*{box-sizing:border-box}
      button,select,input{font:inherit;color:#18181b}
      button{cursor:pointer;border:1px solid #d4d4d8;border-radius:8px;background:#fff;padding:6px 11px}
      button:hover:not(:disabled){background:#f4f4f5}button:disabled{opacity:.45;cursor:not-allowed}
      :is(button,select,input):focus-visible{outline:2px solid #2563eb;outline-offset:2px}
      .primary{background:#18181b;color:#fff;border-color:#18181b}.primary:hover:not(:disabled){background:#3f3f46}
      input[type=search],input[type=text],select{border:1px solid #d4d4d8;border-radius:8px;padding:6px 9px;background:#fff}
      input[type=checkbox]{accent-color:#2563eb;width:16px;height:16px;margin:0}
      label{cursor:pointer}.muted{font-size:12px;color:#71717a}.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
      #toggle{float:right;box-shadow:0 4px 20px #0002}
      #panel{clear:both;width:min(360px,calc(100vw - 40px));max-height:70vh;overflow:auto;background:#fff;border:1px solid #e4e4e7;border-radius:12px;padding:14px;box-shadow:0 8px 35px #0003;margin-bottom:10px;display:grid;gap:10px}
      #panel h3{font-size:15px;margin:0}#status{white-space:pre-wrap;overflow-wrap:anywhere;max-height:140px;overflow:auto;margin:0}#summary{margin:0}
      progress{width:100%;accent-color:#2563eb}#save{width:100%;background:#166534;color:#fff;border-color:#166534}
      #picker{border:0;border-radius:14px;padding:0;width:min(1180px,96vw);height:min(860px,92vh);box-shadow:0 20px 80px #0005;color:#18181b;background:#fff}
      #picker[open]{display:flex;flex-direction:column}#picker::backdrop{background:#0008;backdrop-filter:blur(3px)}
      .ph{padding:14px 18px;border-bottom:1px solid #eee;display:grid;gap:10px}.ph h2{font-size:18px;margin:0}
      .title-row{display:flex;justify-content:space-between;align-items:center;gap:12px}#search{flex:1;min-width:180px}
      .body{flex:1;display:grid;grid-template-columns:1fr 300px;min-height:0}
      #projects{overflow:auto;padding:12px 18px;display:grid;gap:8px;align-content:start}
      .proj{border:1px solid #e4e4e7;border-radius:10px;background:#fff}.proj.on{border-color:#2563eb;background:#f5f8ff}
      .proj-main{display:grid;grid-template-columns:auto 64px 1fr auto;gap:12px;align-items:center;padding:8px 10px}
      .proj-main img,.tile img{background:#f4f4f5;object-fit:cover;border-radius:6px;display:block}.proj-main img{width:64px;height:80px}
      .meta{min-width:0}.meta strong{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.meta small{display:block}
      .badge{display:inline-block;font-size:11px;padding:0 7px;border-radius:99px;background:#dcfce7;color:#166534;margin-left:6px}
      .imgs{display:grid;grid-template-columns:repeat(auto-fill,minmax(110px,1fr));gap:8px;padding:0 10px 10px}
      .tile{position:relative;border:2px solid transparent;border-radius:8px;overflow:hidden}.tile.on{border-color:#2563eb}
      .tile img{width:100%;aspect-ratio:3/4}.tile input{position:absolute;top:6px;left:6px}
      .tile .done{position:absolute;right:4px;bottom:4px;font-size:10px;background:#166534;color:#fff;border-radius:4px;padding:0 4px}
      .naming{border-left:1px solid #eee;padding:14px 16px;overflow:auto;display:grid;gap:10px;align-content:start;background:#fafafa}
      .naming h4{margin:4px 0 0;font-size:13px}.naming label{display:grid;gap:4px;font-size:12px;color:#52525b}
      .naming label.inline{display:flex;align-items:center;gap:6px;color:#18181b;font-size:13px}
      .chips{display:flex;flex-wrap:wrap;gap:5px}.chips button{padding:2px 8px;font-size:12px;border-radius:99px}
      #name-preview{display:block;font:12px/1.6 ui-monospace,Menlo,monospace;background:#fff;border:1px solid #e4e4e7;border-radius:8px;padding:8px;white-space:pre-wrap;word-break:break-all}
      .warn{color:#b45309;font-size:12px;margin:0}.empty{padding:40px;text-align:center;color:#71717a}
      .pf{padding:12px 18px;border-top:1px solid #eee;display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap}
      @media(max-width:800px){.body{grid-template-columns:1fr;grid-template-rows:1fr auto}.naming{border-left:0;border-top:1px solid #eee;max-height:40vh}}
    </style>
    <section id="panel" hidden aria-label="Visie 下载面板">
      <h3>Visie 收藏原图下载</h3>
      <p id="summary" class="muted"></p>
      <progress id="progress" value="0" max="1"></progress>
      <p id="status" role="status" aria-live="polite">点击「选择图片」读取当前收藏。</p>
      <button id="save" hidden>保存 ZIP</button>
      <div class="row">
        <button id="choose" class="primary">选择图片</button>
        <button id="stop" disabled>停止</button>
        <button id="start" disabled>继续剩余</button>
        <button id="retry" disabled>重试失败</button>
      </div>
      <div class="row">
        <button id="resave" disabled title="重新保存最近一包，不重新下载">重存最近一包</button>
        <button id="links" disabled title="导出当前所选图片的原图链接">导出链接</button>
      </div>
    </section>
    <button id="toggle" aria-expanded="false">Visie 下载</button>
    <dialog id="picker" aria-labelledby="picker-title">
      <div class="ph">
        <div class="title-row">
          <h2 id="picker-title">选择要下载的项目</h2>
          <span id="selection-count" class="muted"></span>
        </div>
        <div class="row">
          <input id="search" type="search" placeholder="搜索项目名、品牌、日期…" aria-label="搜索项目">
          <button id="all" title="选中当前列表中可见的全部项目">全选可见</button>
          <button id="only-new" title="选中可见项目中尚未下载过的图片">选未下载</button>
          <button id="none">清空</button>
          <label class="inline"><input id="hide-done" type="checkbox"> 隐藏已下载项目</label>
        </div>
      </div>
      <div class="body">
        <div id="projects" role="list"></div>
        <aside class="naming" aria-label="命名与下载设置">
          <h4>命名方式</h4>
          <label>预设<select id="preset"></select></label>
          <label>文件夹名（留空则不分文件夹）<input id="folder-tpl" type="text" spellcheck="false"></label>
          <label>文件名<input id="file-tpl" type="text" spellcheck="false"></label>
          <div>
            <p class="muted" style="margin:0 0 4px">点字段插入到光标处：</p>
            <div id="chips" class="chips"></div>
          </div>
          <p id="name-warn" class="warn" hidden></p>
          <div><p class="muted" style="margin:0 0 4px">预览（按当前选择）：</p><code id="name-preview"></code></div>
          <h4>下载设置</h4>
          <label class="inline"><input id="auto" type="checkbox"> 自动保存 ZIP（不必每包确认）</label>
          <label>每包最多<select id="size"><option value="25">25 张</option><option value="50">50 张</option><option value="100">100 张</option></select></label>
          <p class="muted" style="margin:0">单包约超过 64 MiB 会提前分包。设置会自动记住。</p>
          <button id="clear-history" title="清除本收藏的“已下载”标记">清除本收藏的下载记录</button>
        </aside>
      </div>
      <div class="pf">
        <span id="pick-hint" class="muted">点项目卡片选中整个项目；点「选单张」可只挑其中几张。</span>
        <div class="row"><button id="cancel-picker">取消</button><button id="confirm" class="primary" disabled>开始下载</button></div>
      </div>
    </dialog>`;
  document.documentElement.appendChild(host);
  const $ = id => shadow.getElementById(id);
  const state = { collection: null, source: '', items: [], projects: [], selected: new Set(), expanded: new Set(), taskItems: [], remaining: [], failed: new Map(), done: new Set(), busy: false, controller: null, ready: null, lastSaved: null, part: 0, saves: 0, started: false, namer: null, lastInput: null };
  const routeId = () => /^\/shortlists\/(\d+)\/?$/.exec(location.pathname)?.[1];
  const routeKey = () => location.origin + location.pathname + location.search;
  const status = text => { $('status').textContent = text; };
  const openPanel = () => { $('panel').hidden = false; $('toggle').setAttribute('aria-expanded', 'true'); };
  const selectedItems = () => state.items.filter(item => state.selected.has(item.url));
  const itemsOf = project => state.items.filter(item => item.group === project.key);
  const doneMap = () => (state.collection && history[state.collection.id]) || {};
  const isDone = item => !!doneMap()[itemKey(item)];

  $('auto').checked = preferences.autoSave;
  $('size').value = String(preferences.size);
  $('folder-tpl').value = preferences.folderTemplate;
  $('file-tpl').value = preferences.fileTemplate;
  $('hide-done').checked = preferences.hideDone;
  for (const [i, p] of PRESETS.entries()) $('preset').add(new Option(p.label, String(i)));
  $('preset').add(new Option('自定义', 'custom'));
  for (const key of Object.keys(NAME_FIELDS)) {
    const chip = document.createElement('button'); chip.type = 'button'; chip.textContent = key;
    chip.onclick = () => insertField(`{${key}}`); $('chips').appendChild(chip);
  }

  function persist(key, value) {
    try {
      if (typeof GM_setValue === 'function') Promise.resolve(GM_setValue(key, value)).catch(() => status('设置未能持久保存；本次仍有效。'));
    } catch { status('设置未能持久保存；本次仍有效。'); }
  }
  function rememberSettings() {
    preferences = { autoSave: $('auto').checked, size: Number($('size').value), folderTemplate: $('folder-tpl').value.slice(0, 200),
      fileTemplate: $('file-tpl').value.slice(0, 200), hideDone: $('hide-done').checked };
    persist(SETTINGS_KEY, preferences);
  }
  function markSaved(records) {
    if (!state.collection || !records?.length) return;
    const id = state.collection.id, map = { ...(history[id] || {}) }, now = Date.now();
    for (const record of records) map[itemKey(record)] = now;
    history = { ...history, [id]: map };
    persist(HISTORY_KEY, history);
  }

  function render() {
    const locked = state.busy || !!state.ready;
    $('size').disabled = locked; $('auto').disabled = locked;
    $('choose').disabled = locked || !routeId();
    $('start').disabled = locked || !state.started || !state.remaining.length;
    $('retry').disabled = locked || !state.failed.size;
    $('links').disabled = !state.selected.size || state.busy;
    $('stop').disabled = !state.busy;
    $('save').hidden = !state.ready;
    $('resave').disabled = !state.lastSaved || !!state.ready;
    if (state.lastSaved) $('resave').title = '重新保存：' + state.lastSaved.filename;
    $('progress').max = Math.max(1, state.started ? state.taskItems.length : 1);
    $('progress').value = state.started ? state.done.size : 0;
    $('summary').textContent = !state.collection ? '' : state.started
      ? `${state.collection.title}：本次 ${state.taskItems.length} 张；已获取 ${state.done.size}；失败 ${state.failed.size}；待处理 ${state.remaining.length}；已发起 ${state.saves} 包保存`
      : `${state.collection.title}：${state.projects.length} 个项目，${state.items.length} 张`;
  }

  // ---- 命名设置 ----
  function syncPreset() {
    const i = PRESETS.findIndex(p => p.folder === $('folder-tpl').value && p.file === $('file-tpl').value);
    $('preset').value = i >= 0 ? String(i) : 'custom';
  }
  function insertField(token) {
    const input = state.lastInput || $('file-tpl');
    const start = input.selectionStart ?? input.value.length, end = input.selectionEnd ?? start;
    const before = input.value.slice(0, start), after = input.value.slice(end);
    const sep = before && !/[_\-\s/]$/.test(before) ? '_' : '';
    input.value = before + sep + token + after;
    const pos = (before + sep + token).length;
    input.focus(); input.setSelectionRange(pos, pos);
    onNamingChange();
  }
  function currentNamer() {
    return makeNamer($('folder-tpl').value, $('file-tpl').value || DEFAULT_FILE_TEMPLATE, { collection: state.collection?.title || '' });
  }
  function renderNamePreview() {
    const sample = (selectedItems().length ? selectedItems() : state.items).slice(0, 3);
    const namer = currentNamer();
    $('name-preview').textContent = sample.length ? sample.map(item => namer(item, 'jpg')).join('\n') : '（读取收藏后显示）';
    const file = $('file-tpl').value;
    const unique = /\{(图片序号|总序号|原文件名|图片ID)\}/.test(file);
    const unknown = [...($('folder-tpl').value + file).matchAll(/\{([^{}]+)\}/g)].map(m => m[1].trim()).filter(k => !NAME_FIELDS[k]);
    const warns = [];
    if (!file.trim()) warns.push('文件名为空，将使用默认格式。');
    else if (!unique) warns.push('文件名没有序号或 ID，同名文件会自动加 _2、_3。');
    if (unknown.length) warns.push(`不认识的字段会被忽略：${[...new Set(unknown)].join('、')}`);
    $('name-warn').textContent = warns.join(' ');
    $('name-warn').hidden = !warns.length;
  }
  function onNamingChange() { syncPreset(); rememberSettings(); renderNamePreview(); }
  $('folder-tpl').onfocus = $('file-tpl').onfocus = event => { state.lastInput = event.target; };
  $('folder-tpl').oninput = $('file-tpl').oninput = onNamingChange;
  $('preset').onchange = () => {
    const p = PRESETS[Number($('preset').value)];
    if (p) { $('folder-tpl').value = p.folder; $('file-tpl').value = p.file; }
    rememberSettings(); renderNamePreview();
  };
  syncPreset();

  // ---- 按项目选图 ----
  function visibleProjects() {
    const q = $('search').value.trim().toLowerCase();
    return state.projects.filter(p => {
      if ($('hide-done').checked && itemsOf(p).every(isDone)) return false;
      return !q || [p.name, p.fullName, p.brand, p.date].join(' ').toLowerCase().includes(q);
    });
  }
  function updateSelectionCount() {
    const n = state.selected.size;
    const projects = state.projects.filter(p => itemsOf(p).some(i => state.selected.has(i.url))).length;
    $('selection-count').textContent = `已选 ${projects} 个项目 · ${n} / ${state.items.length} 张`;
    $('confirm').textContent = n ? `开始下载（${n} 张）` : '开始下载';
    $('confirm').disabled = !n;
    renderNamePreview(); render();
  }
  function setItems(items, on) { for (const i of items) on ? state.selected.add(i.url) : state.selected.delete(i.url); }

  function projectCard(project) {
    const items = itemsOf(project), chosen = items.filter(i => state.selected.has(i.url)).length, done = items.filter(isDone).length;
    const card = document.createElement('div'); card.className = 'proj' + (chosen ? ' on' : ''); card.setAttribute('role', 'listitem');
    card.dataset.key = project.key;
    const main = document.createElement('div'); main.className = 'proj-main';
    const box = document.createElement('input'); box.type = 'checkbox';
    box.checked = chosen === items.length; box.indeterminate = chosen > 0 && chosen < items.length;
    box.setAttribute('aria-label', `选择项目 ${project.name}`);
    box.onclick = event => event.stopPropagation();
    box.onchange = () => { setItems(items, box.checked); refreshCard(project); };
    const img = document.createElement('img'); img.alt = ''; img.loading = 'lazy'; img.decoding = 'async'; img.referrerPolicy = 'no-referrer';
    img.onerror = () => { img.onerror = null; img.src = project.cover; };
    img.src = previewUrl(project.cover) || project.cover;
    const meta = document.createElement('div'); meta.className = 'meta';
    const title = document.createElement('strong'); title.textContent = project.name; title.title = project.fullName || project.name;
    if (done) { const b = document.createElement('span'); b.className = 'badge'; b.textContent = done === items.length ? '已下载' : `已下载 ${done}/${items.length}`; title.appendChild(b); }
    const sub = document.createElement('small'); sub.className = 'muted';
    sub.textContent = [project.brand, project.date, `${items.length} 张`, chosen && chosen < items.length ? `已选 ${chosen} 张` : ''].filter(Boolean).join(' · ');
    meta.append(title, sub);
    const actions = document.createElement('div'); actions.className = 'row';
    const expand = document.createElement('button'); expand.type = 'button';
    const open = state.expanded.has(project.key);
    expand.textContent = open ? '收起' : '选单张'; expand.setAttribute('aria-expanded', String(open));
    expand.onclick = event => { event.stopPropagation(); open ? state.expanded.delete(project.key) : state.expanded.add(project.key); refreshCard(project); };
    actions.appendChild(expand);
    if (project.url) {
      const link = document.createElement('a'); link.href = project.url; link.target = '_blank'; link.rel = 'noopener'; link.textContent = '打开';
      link.className = 'muted'; link.onclick = event => event.stopPropagation(); actions.appendChild(link);
    }
    main.append(box, img, meta, actions);
    main.style.cursor = 'pointer';
    main.onclick = () => { setItems(items, chosen !== items.length); refreshCard(project); };
    card.appendChild(main);
    if (open) {
      const grid = document.createElement('div'); grid.className = 'imgs';
      for (const item of items) {
        const tile = document.createElement('label'); tile.className = 'tile' + (state.selected.has(item.url) ? ' on' : '');
        const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = state.selected.has(item.url); cb.dataset.url = item.url;
        cb.setAttribute('aria-label', `${project.name} 第 ${item.indexInProject} 张`);
        cb.onchange = () => { setItems([item], cb.checked); refreshCard(project); };
        const pic = document.createElement('img'); pic.alt = ''; pic.loading = 'lazy'; pic.decoding = 'async'; pic.referrerPolicy = 'no-referrer';
        pic.onerror = () => { pic.onerror = null; pic.src = item.url; };
        pic.src = previewUrl(item.url) || item.url; pic.title = item.width ? `${item.width} × ${item.height}` : item.name;
        tile.append(cb, pic);
        if (isDone(item)) { const d = document.createElement('span'); d.className = 'done'; d.textContent = '已下载'; tile.appendChild(d); }
        grid.appendChild(tile);
      }
      card.appendChild(grid);
    }
    return card;
  }
  function refreshCard(project) {
    const old = $('projects').querySelector(`[data-key="${CSS.escape(project.key)}"]`);
    if (old) old.replaceWith(projectCard(project));
    updateSelectionCount();
  }
  function renderProjects() {
    const list = visibleProjects();
    $('projects').replaceChildren(...list.map(projectCard));
    if (!list.length) {
      const empty = document.createElement('p'); empty.className = 'empty';
      empty.textContent = state.projects.length ? '没有符合条件的项目。' : '收藏里没有可下载的图片。';
      $('projects').appendChild(empty);
    }
    updateSelectionCount();
  }
  $('search').oninput = renderProjects;
  $('hide-done').onchange = () => { rememberSettings(); renderProjects(); };
  $('all').onclick = () => { for (const p of visibleProjects()) setItems(itemsOf(p), true); renderProjects(); };
  $('only-new').onclick = () => { for (const p of visibleProjects()) for (const i of itemsOf(p)) setItems([i], !isDone(i)); renderProjects(); };
  $('none').onclick = () => { state.selected.clear(); renderProjects(); };
  $('clear-history').onclick = () => {
    if (!state.collection || !confirm('清除本收藏的“已下载”标记？不会删除已保存的文件。')) return;
    const next = { ...history }; delete next[state.collection.id]; history = next; persist(HISTORY_KEY, history); renderProjects();
  };

  function openPicker() {
    if (state.busy || state.ready) return;
    if (!state.collection || routeKey() !== state.source) { scan(); return; }
    renderProjects();
    if (!$('picker').open) $('picker').showModal();
    $('search').focus();
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
    state.collection = null; state.source = ''; state.items = []; state.projects = []; state.remaining = []; state.taskItems = [];
    state.selected.clear(); state.expanded.clear(); state.failed.clear(); state.done.clear(); state.part = 0; state.saves = 0; state.started = false;
    render(); status('正在读取收藏，稍后自动打开选择窗口…');
    let success = false;
    const timer = setTimeout(() => state.controller?.abort(new DOMException('读取超时，请检查网络后重试。', 'AbortError')), 45000);
    try {
      const response = await fetch(source, { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'text/html' }, signal });
      if (!response.ok) throw new Error(`读取收藏失败：HTTP ${response.status}。请确认当前账号有访问权限。`);
      if (new URL(response.url).pathname !== new URL(source).pathname) throw new Error('网站跳转到了其他页面，请先在此 Chrome 登录并打开收藏。');
      const text = await response.text(); aborted(signal);
      if (routeKey() !== source) throw new Error('收藏页面已切换，请重新读取。');
      const collection = collectImages(readPageData(new DOMParser().parseFromString(text, 'text/html')), id);
      state.collection = collection; state.source = source; state.items = collection.images; state.projects = collection.projects;
      const s = collection.stats;
      const warnings = [s.videos && `跳过 ${s.videos} 个视频`, s.duplicates && `去重 ${s.duplicates} 张`, s.unavailable && `${s.unavailable} 个条目已不可用`, s.unsupported && `${s.unsupported} 个未知类型未读取`, s.rejected && `${s.rejected} 个图片地址不受支持`].filter(Boolean);
      status(`${state.items.length ? '清单已就绪。勾选要下载的项目即可。' : '未找到可下载的图片。'}${warnings.length ? '\n' + warnings.join('；') + '。' : ''}`);
      success = !!state.items.length;
    } catch (error) { status(error.message); }
    finally { clearTimeout(timer); state.busy = false; state.controller = null; render(); }
    if (success) openPicker();
  }

  function report(failures) {
    return JSON.stringify({ version: VERSION, collection: state.collection?.title,
      source: state.source.split('?')[0], createdAt: new Date().toISOString(), selectedCount: state.taskItems.length,
      naming: { folder: preferences.folderTemplate, file: preferences.fileTemplate },
      scope: '仅所选收藏图片；使用 media.url，不推测地址、不降级缩略图。保存次数只代表已发起下载，需核对浏览器下载列表。',
      skipped: state.collection?.stats, failed: failures }, null, 2);
  }

  function zipName(records, part) {
    const groups = [...new Set(records.map(r => r.group))];
    const base = groups.length === 1 && records[0] ? `${state.collection.title}_${records[0].project}` : state.collection.title;
    return `${safeName(base, 80)}_part-${String(part).padStart(3, '0')}.zip`;
  }

  function stagePart(files, records, failures, signal) {
    const part = ++state.part;
    const blob = makeZip([...files, { name: '图片清单.json', data: JSON.stringify(records, null, 2) }, { name: '下载报告.json', data: report(failures) }]);
    const packet = { blob, filename: zipName(records, part), records };
    let autoError = '';
    if (preferences.autoSave && signal && !signal.aborted) {
      try {
        saveBlob(blob, packet.filename); state.lastSaved = packet; state.saves++; markSaved(records);
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
    if (routeKey() !== state.source) { status('当前页面与已读取的收藏不一致，请重新选择图片。'); return; }
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
        if (routeKey() !== state.source) throw new DOMException('页面已切换，任务已停止。请重新选择图片。', 'AbortError');
        const item = state.remaining[0]; status(`正在下载：${item.project}（第 ${item.indexInProject}/${item.projectTotal} 张）`);
        let result;
        try { result = await downloadImage(item.url, signal, GM_xmlhttpRequest, sleep, status); }
        catch (error) {
          aborted(signal); if (error.name === 'AbortError') throw error;
          state.failed.set(item.url, { item, error: error.message }); failures.push({ url: item.url, name: item.name, error: error.message });
          state.remaining.shift(); render(); await sleep(250, signal); continue;
        }
        if (files.length && bytes + result.data.length > PART_BYTES) await flush();
        aborted(signal);
        const path = imagePath(item, result.extension, state.namer);
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
    if (!state.busy && !state.ready && !state.started) openPicker();
  }
  $('toggle').onclick = () => {
    if ($('panel').hidden) launch();
    else { $('panel').hidden = true; $('toggle').setAttribute('aria-expanded', 'false'); }
  };
  $('choose').onclick = () => {
    if (state.started && state.remaining.length && !confirm('当前任务还有未下载的图片。重新选择会放弃剩余进度，继续吗？')) return;
    if (!state.collection || routeKey() !== state.source) scan(); else openPicker();
  };
  $('start').onclick = () => start();
  $('retry').onclick = () => start(true);
  $('stop').onclick = () => state.controller?.abort(new DOMException('你已停止任务。', 'AbortError'));
  $('links').onclick = () => saveBlob(new Blob([selectedItems().map(i => i.url).join('\n') + '\n'], { type: 'text/plain;charset=utf-8' }), `${safeName(state.collection.title)}-所选原图链接.txt`);
  $('save').onclick = () => {
    const ready = state.ready; if (!ready) return;
    try { saveBlob(ready.blob, ready.filename); }
    catch (error) { status(`无法发起保存：${error.message}。ZIP 仍保留，可重试。`); return; }
    state.lastSaved = { blob: ready.blob, filename: ready.filename, records: ready.records }; state.saves++; state.ready = null;
    markSaved(ready.records);
    ready.resume?.();
    if (!state.busy) status('已发起 ZIP 保存，请检查下载列表。可继续剩余图片或重试失败项。');
    render();
  };
  $('resave').onclick = () => {
    if (!state.lastSaved) return;
    try { saveBlob(state.lastSaved.blob, state.lastSaved.filename); status(`已再次发起保存：${state.lastSaved.filename}。请核对下载列表。`); }
    catch (error) { status(`补存失败：${error.message}`); }
  };
  $('auto').onchange = $('size').onchange = rememberSettings;
  $('cancel-picker').onclick = () => $('picker').close();
  $('confirm').onclick = () => {
    if (state.busy || state.ready || !state.selected.size) return;
    if (routeKey() !== state.source) { $('picker').close(); status('页面已切换，请重新选择图片。'); return; }
    rememberSettings();
    state.namer = currentNamer();
    state.taskItems = selectedItems(); state.remaining = [...state.taskItems];
    state.done.clear(); state.failed.clear(); state.saves = 0; state.part = 0; state.started = true;
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
      state.controller?.abort(new DOMException('页面已切换，任务已停止。请重新选择图片。', 'AbortError'));
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
