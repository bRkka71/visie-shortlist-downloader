'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const core = require('../visie-shortlist-downloader.user.js');
const url = 'https://cdn.visie.io/public/project/1/image/a.jpg';
const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==', 'base64'));
const media = (id, extra = {}) => ({ id, type: 'image', url: url.replace('a.jpg', `${id}.jpg`), name: `照片-${id}.jpg`, width: 3000, height: 4000, ...extra });
const page = items => ({ props: { shortlist: { id: 512, name: '赞', items }, suggestions: { media: [media(999)] } } });
const row = (images, extra = {}) => ({ type: 'project', item: { id: 8, name: '项目 / 秋冬', url: 'https://visie.io/project/test', media: images }, ...extra });
const requestWith = responses => {
  let count = 0;
  const request = options => {
    const response = responses[Math.min(count++, responses.length - 1)];
    queueMicrotask(() => response.event ? options[response.event]() : options.onload({ status: 200, response: png.buffer, ...response }));
    return { abort() {} };
  };
  request.count = () => count;
  return request;
};

test('extracts original URLs and all horizontal images, not suggestions or video', () => {
  const result = core.collectImages(page([row([media(1), media(2), media(3, { type: 'video', url: url.replace('.jpg', '.mp4') })])]), '512');
  assert.equal(result.title, '赞');
  assert.equal(result.images.length, 2);
  assert.equal(result.images[0].url, media(1).url);
  assert.equal(result.images[0].width, 3000);
  assert.equal(result.stats.videos, 1);
  assert.ok(!JSON.stringify(result).includes('999.jpg'));
});

test('deduplicates identical URLs across groups but preserves signed query strings', () => {
  const one = media(1, { url: url + '?signature=a&width=3000' });
  const result = core.collectImages(page([row([one, one]), row([media(2, { url: url + '?signature=b' })])]), 512);
  assert.equal(result.images.length, 2);
  assert.equal(result.stats.duplicates, 1);
  assert.ok(result.images[0].url.endsWith('?signature=a&width=3000'));
});

test('reports unavailable, unknown and rejected entries; ignores text sections', () => {
  const result = core.collectImages(page([
    { type: 'headline', name: '标题' }, { type: 'text' }, { type: 'project', item: null },
    { type: 'future' }, row([media(1, { url: 'https://other.example/image.jpg' }), media(2, { type: 'future' })])
  ]), 512);
  assert.equal(result.images.length, 0);
  assert.deepEqual(result.stats, { videos: 0, duplicates: 0, unavailable: 1, unsupported: 2, rejected: 1 });
});

test('supports profile rows and explicitly stored single-media entries', () => {
  const result = core.collectImages(page([row([media(1)], { type: 'profile' }), { type: 'media', item: media(2) }]), 512);
  assert.equal(result.images.length, 2);
});

test('fails closed on login, wrong shortlist, pagination and changed media schema', () => {
  assert.throws(() => core.collectImages({ props: {} }, 512), /登录/);
  assert.throws(() => core.collectImages(page([]), 513), /编号/);
  const changed = page([]); changed.props.shortlist.items = { data: [] };
  assert.throws(() => core.collectImages(changed, 512), /结构/);
  const partial = page([]); partial.props.shortlist.items_count = 10;
  assert.throws(() => core.collectImages(partial, 512), /分页/);
  const paginated = page([]); paginated.props.shortlist.next_page_url = '?page=2';
  assert.throws(() => core.collectImages(paginated, 512), /分页/);
  assert.throws(() => core.collectImages(page([row({ data: [media(1)] })]), 512), /不是数组/);
});

test('allows only HTTPS Visie image hosts, preserving URL parameters', () => {
  assert.equal(core.allowedImageUrl(url + '?token=a#fragment'), url + '?token=a');
  for (const bad of ['http://cdn.visie.io/a.jpg', 'https://cdn.visie.io.evil.test/a.jpg', 'https://user:pass@cdn.visie.io/a.jpg', 'https://cdn.visie.io:444/a.jpg', 'data:image/png,abc', 'javascript:alert(1)', '']) {
    assert.equal(core.allowedImageUrl(bad), null, bad);
  }
});

test('sanitizes traversal, OS-reserved names, control characters and Unicode lengths', () => {
  assert.equal(core.safeName('CON'), '_CON');
  assert.equal(core.safeName('..'), '未命名');
  assert.equal(core.safeName('照片 / test: \u0000 '), '照片 _ test_ _');
  assert.equal(core.safeName('😀'.repeat(100), 3), '😀😀😀');
  assert.ok(!core.safeName('../../evil').includes('/'));
  const item = core.collectImages(page([row([media(1, { name: '../../a.jpg' })])]), 512).images[0];
  const name = core.imagePath(item, 'png');
  assert.equal(name.split('/').length, 2);
  assert.ok(name.endsWith('.png'));
});

test('parses current JSON script and legacy data-page without executing page scripts', () => {
  const serialized = JSON.stringify(page([]));
  const modern = { querySelector: selector => selector.startsWith('script') ? { textContent: serialized } : null };
  assert.deepEqual(core.readPageData(modern), page([]));
  const legacy = { querySelector: selector => selector.startsWith('#app') ? { getAttribute: () => serialized } : null };
  assert.deepEqual(core.readPageData(legacy), page([]));
  assert.throws(() => core.readPageData({ querySelector: () => null }), /未返回/);
  assert.throws(() => core.readPageData({ querySelector: () => ({ textContent: 'bad json' }) }), /解析/);
});

test('detects real binary format instead of trusting the filename or Content-Type', () => {
  assert.equal(core.imageExtension(png), 'png');
  assert.equal(core.imageExtension(Uint8Array.from([255, 216, 255, 0])), 'jpg');
  assert.equal(core.imageExtension(Buffer.from('GIF89a00000')), 'gif');
  assert.equal(core.imageExtension(Buffer.from('RIFF0000WEBP0000')), 'webp');
  assert.equal(core.imageExtension(Buffer.from('0000ftypavif00000')), 'avif');
  assert.equal(core.imageExtension(Buffer.from('II*\0zzzz')), 'tif');
  assert.throws(() => core.imageExtension(Buffer.from('<html>Login required</html>')), /不是支持/);
  assert.throws(() => core.imageExtension(new Uint8Array()), /不是支持/);
});

test('CRC32 matches the published check vector', () => {
  assert.equal(core.crc32(Buffer.from('123456789')), 0xcbf43926);
});

test('ZIP is independently readable with correct bytes, CRC and UTF-8 paths', async () => {
  const archive = core.makeZip([{ name: '中文 项目/原图.png', data: png }, { name: '下载报告.json', data: '{"成功":true}' }]);
  const result = spawnSync('python3', ['-c', `import sys,io,zipfile,json,base64
z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read()))
assert z.testzip() is None
assert z.namelist()==['中文 项目/原图.png','下载报告.json']
assert json.loads(z.read('下载报告.json'))=={'成功':True}
assert z.read('中文 项目/原图.png')==base64.b64decode('${Buffer.from(png).toString('base64')}')
assert all(i.flag_bits & 0x800 for i in z.infolist())
print('ZIP CRC/UTF-8/payload OK')`], { input: Buffer.from(await archive.arrayBuffer()), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /payload OK/);
});

test('request sends only GET, binary response and no CDN credentials', async () => {
  let options;
  const result = await core.requestImage(url, new AbortController().signal, opts => {
    options = opts;
    queueMicrotask(() => opts.onload({ status: 200, response: png.buffer, finalUrl: url }));
    return { abort() {} };
  });
  assert.equal(options.method, 'GET');
  assert.equal(options.anonymous, true);
  assert.equal(options.responseType, 'arraybuffer');
  assert.equal(result.extension, 'png');
  assert.deepEqual(result.data, png);
});

test('retries temporary failures with bounded backoff and honors Retry-After', async () => {
  const request = requestWith([{ status: 503 }, { status: 429, responseHeaders: 'Retry-After: 45\r\n' }, {}]);
  const waits = [];
  const result = await core.downloadImage(url, new AbortController().signal, request, async delay => waits.push(delay));
  assert.equal(result.extension, 'png');
  assert.equal(request.count(), 3);
  assert.deepEqual(waits, [800, 45000]);
});

test('404 and HTML error responses are not retried or saved as images', async () => {
  const missing = requestWith([{ status: 404 }]);
  await assert.rejects(core.downloadImage(url, null, missing, async () => {}), /404/);
  assert.equal(missing.count(), 1);
  const html = requestWith([{ response: new TextEncoder().encode('<html>login</html>').buffer }]);
  await assert.rejects(core.downloadImage(url, null, html), /不是支持/);
  assert.equal(html.count(), 1);
});

test('network failures stop after three attempts', async () => {
  const request = requestWith([{ event: 'onerror' }]);
  await assert.rejects(core.downloadImage(url, null, request, async () => {}), /网络错误/);
  assert.equal(request.count(), 3);
});

test('abort cancels active request immediately without retrying', async () => {
  const controller = new AbortController();
  let cancelled = false;
  const pending = core.downloadImage(url, controller.signal, () => ({ abort() { cancelled = true; } }));
  controller.abort(new DOMException('用户停止', 'AbortError'));
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(cancelled, true);
});

test('rejects oversized images, unauthorized redirects and pre-aborted requests', async () => {
  const huge = options => {
    queueMicrotask(() => options.onprogress({ loaded: 65 * 1024 * 1024 }));
    return { abort() {} };
  };
  await assert.rejects(core.requestImage(url, null, huge), /超过 64/);
  await assert.rejects(core.requestImage(url, null, requestWith([{ finalUrl: 'https://other.example/image.jpg' }])), /重定向/);
  const controller = new AbortController(); controller.abort();
  let called = false;
  await assert.rejects(core.requestImage(url, controller.signal, () => { called = true; }), { name: 'AbortError' });
  assert.equal(called, false);
});

test('collects project metadata for project-level selection and naming', () => {
  const p = page([{ type: 'project', item: { id: 8, name: 'Fall', full_name: 'Brand Fall 2026', date: '2026-11-04', clients: [{ name: 'David Yurman' }], url: 'https://visie.io/project/f', media: [media(1), media(2)] } }, row([media(3)])]);
  const r = core.collectImages(p, 512);
  assert.equal(r.projects.length, 2);
  assert.deepEqual([r.projects[0].brand, r.projects[0].date, r.projects[0].count], ['David Yurman', '2026-11-04', 2]);
  assert.equal(r.images[1].indexInProject, 2);
  assert.equal(r.images[1].projectTotal, 2);
  assert.equal(r.images[2].projectIndex, 2);
});

test('naming templates fill fields, drop empty ones and stay safe', () => {
  const item = { project: '秋冬 / Fall', fullName: 'X', brand: '', date: '2026-11-04', projectIndex: 3, indexInProject: 7, sequence: 12, name: 'orig-1.jpg', width: 10, height: 20, id: 99 };
  assert.equal(core.renderTemplate('{项目序号}_{品牌}_{项目}', item), '003_秋冬 Fall');
  assert.equal(core.renderTemplate('{品牌}_{日期}_{图片序号}', item), '2026-11-04_07');
  assert.equal(core.renderTemplate('{原文件名}_{尺寸}_{图片ID}', item), 'orig-1_10x20_99');
  assert.equal(core.renderTemplate('{收藏}-{未知}', item, { collection: '赞' }), '赞');
  assert.ok(!core.renderTemplate('{项目}', { project: '../../x' }).includes('/'));
});

test('namer supports flat output and de-duplicates colliding names', () => {
  const namer = core.makeNamer('', '{项目}', {});
  const a = { project: 'A', indexInProject: 1, sequence: 1 };
  assert.equal(namer(a, 'jpg'), 'A.jpg');
  assert.equal(namer(a, 'jpg'), 'A_2.jpg');
  assert.equal(core.makeNamer('{项目}', '{图片序号}')(a, 'png'), 'A/01.png');
});

test('preview uses small CDN thumbnail but never changes non-CDN or bad URLs', () => {
  assert.equal(core.previewUrl('https://cdn.visie.io/p/a.jpg'), 'https://cdn.visie.io/p/a_small.webp');
  assert.equal(core.previewUrl('https://cdn.visie.io/p/a_medium.webp'), 'https://cdn.visie.io/p/a_medium.webp');
  assert.equal(core.previewUrl('https://evil.test/a.jpg'), null);
});
