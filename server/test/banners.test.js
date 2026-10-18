import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { SKIP, integrationEnabled, configureEnv, bootApp, makeStaff, makeUser, signIn } from './helpers/integration.js';

// Real Express app, real Mongoose models, real media registry and Cloudinary provider. Only the Cloudinary SDK network
// calls are replaced (in memory, below). Tests that need a database are skipped, not passed, without TEST_MONGODB_URI.
configureEnv({ LOG_LEVEL: process.env.TEST_LOG ?? 'silent', STORAGE_PROVIDER: 'cloudinary', CLOUDINARY_CLOUD_NAME: 'democloud', CLOUDINARY_API_KEY: 'k', CLOUDINARY_API_SECRET: 's', IMAGE_MAX_BYTES: '60000' });

const { v2: cloudinary } = await import('cloudinary');
const { bannerBody, bannerParams, SITE_SLOTS, SLOT_KEYS } = await import('../src/services/engage/bannerService.js');
const { presentBanner } = await import('../src/services/imageUrls.js');
const { adminEngage } = await import('../src/routes/adminEngage.js');
const { createApp } = await import('../src/app.js');

// ---- in-memory Cloudinary ----
const cloud = { files: new Map(), destroyed: [], failUpload: false };
cloudinary.uploader.upload_stream = (opts, cb) => {
  const chunks = [];
  return new Writable({
    write(c, _e, next) { chunks.push(c); next(); },
    final(done) {
      if (cloud.failUpload) cb({ http_code: 500, message: 'boom' });
      else {
        const bytes = Buffer.concat(chunks); cloud.files.set(opts.public_id, bytes);
        cb(null, { public_id: opts.public_id, secure_url: `https://res.cloudinary.com/democloud/image/upload/v1/${opts.public_id}.jpg`, bytes: bytes.length, width: 1600, height: 900, format: 'jpg', version: 1 });
      }
      done();
    },
  });
};
cloudinary.uploader.destroy = async (id) => { cloud.destroyed.push(id); return { result: cloud.files.delete(id) ? 'ok' : 'not found' }; };

const jpeg = (n = 2000) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(n, 7)]);
const here = path.dirname(fileURLToPath(import.meta.url));
const localUploads = path.join(here, '..', 'uploads', 'products');
const listLocal = () => (fs.existsSync(localUploads) ? fs.readdirSync(localUploads).sort() : []);
const cookieHeader = (b) => [...b.jar.values()].map((c) => `${c.name}=${c.value}`).join('; ');
const publicIdOf = (url) => new URL(url).pathname.replace(/^\/democloud\/image\/upload\/v1\//, '').replace(/\.jpg$/, '');

let app;
before(async () => { if (integrationEnabled) app = await bootApp(); });
after(async () => { await app?.stop(); });

async function upload(b, bytes, { purpose = 'banner', name = 'banner.jpg', type = 'image/jpeg', field = 'file' } = {}) {
  const form = new FormData(); if (bytes) form.append(field, new Blob([bytes], { type }), name);
  const res = await fetch(`${app.base}/api/admin/uploads/product-image?purpose=${purpose}`, { method: 'POST', headers: { 'x-requested-with': 'nessence', cookie: cookieHeader(b) }, body: form });
  const json = await res.json().catch(() => null); return { status: res.status, code: json?.code, data: json?.data };
}
async function staffBrowser(role = 'content_manager') {
  const s = await makeStaff({ role }); const b = app.browser(); const r = await b.post('/api/admin/auth/login', { email: s.email, password: s.password });
  assert.equal(r.status, 200); return b;
}
const model = async (n) => (await import(`../src/models/${n}.js`))[n];

// =============== always run (no database) ===============

test('slot registry: every site slot has a label, a place and a size hint', () => {
  assert.deepEqual(SLOT_KEYS, ['homeHero', 'homeMen', 'homeWomen', 'pageMen', 'pageWomen', 'pageNewArrivals', 'pageSale']);
  for (const k of SLOT_KEYS) for (const f of ['label', 'where', 'hint']) assert.ok(SITE_SLOTS[k][f], `${k}.${f}`);
});

test('banner body validation: image + alt required, other hosts and extra fields refused', () => {
  const good = 'https://res.cloudinary.com/democloud/image/upload/v1/nessence/banners/abc.jpg';
  assert.equal(bannerBody.safeParse({ image: { url: good, alt: 'Autumn coats' } }).success, true);
  assert.equal(bannerBody.parse({ image: { url: good, alt: 'Autumn coats' } }).active, true, 'active defaults on');
  assert.equal(bannerBody.safeParse({ image: { url: '/media/seed/hero.jpg', alt: 'Existing seed image' } }).success, true, 'built-in images stay allowed');
  for (const bad of [
    { image: { url: 'https://evil.example/x.jpg', alt: 'Autumn coats' } },
    { image: { url: 'https://res.cloudinary.com/othercloud/image/upload/v1/nessence/banners/abc.jpg', alt: 'Autumn coats' } },
    { image: { url: good, alt: 'ab' } },
    { image: { url: good } },
    { image: { url: good, alt: 'Autumn coats', publicId: 'nessence/banners/x' } },
    { image: { url: good, alt: 'Autumn coats' }, active: 'yes' },
    { image: { url: good, alt: 'Autumn coats' }, extra: 1 },
    {},
  ]) assert.equal(bannerBody.safeParse(bad).success, false, JSON.stringify(bad));
});

test('banner params: known slots for site, 24-hex ids for collection/category', () => {
  assert.equal(bannerParams.safeParse({ scope: 'site', ref: 'homeHero' }).success, true);
  assert.equal(bannerParams.safeParse({ scope: 'site', ref: 'nope' }).success, false);
  assert.equal(bannerParams.safeParse({ scope: 'collection', ref: 'a'.repeat(24) }).success, true);
  assert.equal(bannerParams.safeParse({ scope: 'category', ref: 'homeHero' }).success, false);
  assert.equal(bannerParams.safeParse({ scope: 'other', ref: 'a'.repeat(24) }).success, false);
});

test('presentBanner: absent or switched-off banners yield nothing (the storefront falls back); storage internals are not exposed', () => {
  assert.equal(presentBanner(undefined), undefined);
  assert.equal(presentBanner({ alt: 'x' }), undefined);
  assert.equal(presentBanner({ url: 'https://res.cloudinary.com/democloud/image/upload/v1/nessence/banners/a.jpg', alt: 'x', active: false }), undefined);
  const v = presentBanner({ url: 'https://res.cloudinary.com/democloud/image/upload/v1/nessence/banners/a.jpg', publicId: 'nessence/banners/a', alt: 'Hero', width: 1600, height: 900, bytes: 99, format: 'jpg' });
  assert.match(v.url, /^https:\/\/res\.cloudinary\.com\/democloud\/image\/upload\/.*nessence\/banners\/a/);
  assert.match(v.srcSet, /640w, .* 1280w, .* 2000w$/); assert.equal(v.alt, 'Hero'); assert.deepEqual([v.width, v.height], [1600, 900]);
  for (const k of ['publicId', 'bytes', 'format', 'active']) assert.equal(k in v, false, k);
});

test('every banner admin route is behind the content:write permission', () => {
  const routes = adminEngage.stack.map((l) => l.route).filter((r) => r?.path.startsWith('/banners'));
  assert.deepEqual(routes.map((r) => `${Object.keys(r.methods)[0]} ${r.path}`).sort(), ['delete /banners/:scope/:ref', 'get /banners', 'put /banners/:scope/:ref']);
  for (const r of routes) assert.ok(r.stack.some((l) => l.name === 'perm:content:write'), `${r.path} has no permission guard`);
});

test('unauthenticated banner requests (list, save, reset, upload) are refused before any database or storage work', async () => {
  const s = createApp().listen(0); const base = `http://127.0.0.1:${s.address().port}`; const h = { 'x-requested-with': 'nessence', 'content-type': 'application/json' };
  const body = JSON.stringify({ image: { url: '/media/seed/x.jpg', alt: 'Seed image' } });
  try {
    const calls = [
      ['GET', '/api/admin/banners'], ['PUT', '/api/admin/banners/site/homeHero', body], ['DELETE', '/api/admin/banners/site/homeHero'],
      ['PUT', `/api/admin/banners/collection/${'a'.repeat(24)}`, body], ['DELETE', `/api/admin/banners/category/${'a'.repeat(24)}`], ['POST', '/api/admin/uploads/product-image?purpose=banner'],
    ];
    for (const [method, p, b] of calls) {
      assert.equal((await fetch(base + p, { method, headers: h, body: b })).status, 401, `${method} ${p} anonymous`);
      assert.equal((await fetch(base + p, { method, headers: { ...h, cookie: 'ns_at=whatever' }, body: b })).status, 401, `${method} ${p} customer-style cookie`);
    }
  } finally { s.close(); }
});

// =============== need a MongoDB-compatible server ===============

test('admin list shows every site slot, empty, with its label; public payload is empty so the storefront falls back', { skip: SKIP }, async () => {
  const b = await staffBrowser(); const r = await b.get('/api/admin/banners');
  assert.equal(r.status, 200); assert.deepEqual(r.data.site.map((s) => s.key), SLOT_KEYS);
  for (const s of r.data.site) { assert.equal(s.banner, null); assert.ok(s.label && s.where && s.hint); }
  const pub = await app.browser().get('/api/banners'); assert.equal(pub.status, 200);
  assert.deepEqual(pub.data, { site: {}, collections: {}, categories: {} });
  assert.match(pub.headers.get('cache-control'), /no-store/, 'a saved banner must not be served stale');
});

test('authorization: support and manager cannot touch banners; content_manager and admin can; uploads need the banner purpose permission', { skip: SKIP }, async () => {
  const ref = '/api/admin/banners/site/homeHero'; const body = { image: { url: '/media/seed/x.jpg', alt: 'Seed image' } };
  for (const role of ['support', 'manager', 'inventory_manager']) {
    const b = await staffBrowser(role);
    assert.equal((await b.get('/api/admin/banners')).status, 403, `${role} list`); assert.equal((await b.put(ref, body)).status, 403, `${role} save`); assert.equal((await b.del(ref)).status, 403, `${role} reset`);
    assert.equal((await upload(b, jpeg())).status, 403, `${role} banner upload`);
  }
  const cust = await makeUser(); const cb = app.browser(); await signIn(cb, cust);
  assert.equal((await cb.get('/api/admin/banners')).status, 401); assert.equal((await cb.put(ref, body)).status, 401);
  for (const role of ['content_manager', 'admin', 'super_admin']) { const b = await staffBrowser(role); assert.equal((await b.get('/api/admin/banners')).status, 200, role); assert.equal((await upload(b, jpeg())).status, 201, `${role} upload`); }
});

test('upload validation: type, size, missing file and storage failure are rejected with clear errors and nothing is stored', { skip: SKIP }, async () => {
  const b = await staffBrowser(); const MediaAsset = await model('MediaAsset'); cloud.files.clear(); const rows = await MediaAsset.countDocuments();
  const text = await upload(b, Buffer.from('<?php echo 1; ?> not an image at all'), { name: 'evil.jpg' }); assert.equal(text.status, 400); assert.equal(text.code, 'INVALID_IMAGE');
  const svg = await upload(b, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), { name: 'x.svg', type: 'image/svg+xml' }); assert.equal(svg.status, 400); assert.equal(svg.code, 'INVALID_IMAGE');
  const gif = await upload(b, Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(100)]), { name: 'x.gif', type: 'image/gif' }); assert.equal(gif.status, 400);
  const big = await upload(b, jpeg(70_000)); assert.equal(big.status, 413); assert.equal(big.code, 'FILE_TOO_LARGE');
  const none = await upload(b, null); assert.equal(none.status, 400); assert.equal(none.code, 'NO_FILE');
  const wrongField = await upload(b, jpeg(), { field: 'image' }); assert.equal(wrongField.status, 400);
  assert.equal(cloud.files.size, 0, 'nothing reached storage'); assert.equal(await MediaAsset.countDocuments(), rows, 'nothing was registered');
  cloud.failUpload = true;
  try { const r = await upload(b, jpeg()); assert.equal(r.status, 502); assert.equal(r.code, 'STORAGE_UNAVAILABLE'); } finally { cloud.failUpload = false; }
  assert.equal(cloud.files.size, 0);
});

test('upload → preview → save → storefront: the image is served from the database record, not from local disk', { skip: SKIP }, async () => {
  const b = await staffBrowser(); const filesBefore = listLocal(); cloud.files.clear();
  const up = await upload(b, jpeg()); assert.equal(up.status, 201);
  assert.match(up.data.url, /^https:\/\/res\.cloudinary\.com\/democloud\/image\/upload\/.*nessence\/banners\//); assert.ok(up.data.assetId);
  const pub0 = await app.browser().get('/api/banners'); assert.equal(pub0.data.site.homeHero, undefined, 'an unsaved upload is not live');
  const saved = await b.put('/api/admin/banners/site/homeHero', { image: { url: up.data.url, alt: 'Model in an oxblood coat' }, active: true });
  assert.equal(saved.status, 200); assert.equal(saved.data.alt, 'Model in an oxblood coat'); assert.equal(saved.data.active, true); assert.ok(saved.data.preview);
  const pub = await app.browser().get('/api/banners'); const hero = pub.data.site.homeHero;
  assert.ok(hero, 'live immediately, same request cycle'); assert.equal(hero.alt, 'Model in an oxblood coat'); assert.match(hero.url, /nessence\/banners\//); assert.ok(hero.srcSet);
  assert.equal(Object.keys(pub.data.site).length, 1, 'only the saved slot appears');
  assert.equal('publicId' in hero, false);
  const SiteContent = await model('SiteContent'); const doc = await SiteContent.findOne({ key: 'banner:homeHero' }).lean();
  assert.equal(doc.data.url, up.data.url); assert.equal(doc.data.alt, 'Model in an oxblood coat'); assert.equal(doc.data.active, true); assert.ok(doc.data.publicId.startsWith('nessence/banners/'));
  const asset = await (await model('MediaAsset')).findOne({ publicId: doc.data.publicId }).lean(); assert.equal(asset.status, 'active'); assert.equal(asset.purpose, 'banner');
  assert.deepEqual(listLocal(), filesBefore, 'no file was written to the server disk');
  const AuditLog = await model('AdminAuditLog'); assert.ok(await AuditLog.findOne({ action: 'banner.saved', resourceId: 'site:homeHero' }));
});

test('persistence: a brand-new server process over the same database serves the saved banner (survives restart/redeploy)', { skip: SKIP }, async () => {
  const b = await staffBrowser(); const up = await upload(b, jpeg());
  await b.put('/api/admin/banners/site/pageSale', { image: { url: up.data.url, alt: 'Winter sale rail' } });
  const { once } = await import('node:events'); const fresh = createApp().listen(0, '127.0.0.1'); await once(fresh, 'listening');
  try {
    const r = await (await fetch(`http://127.0.0.1:${fresh.address().port}/api/banners`)).json();
    assert.equal(r.data.site.pageSale.alt, 'Winter sale rail'); assert.equal(r.data.site.pageSale.url.includes('nessence/banners/'), true);
    const sameFresh = await fetch(`http://127.0.0.1:${fresh.address().port}/api/admin/banners`, { headers: { 'x-requested-with': 'nessence', cookie: cookieHeader(b) } });
    assert.equal(sameFresh.status, 200, 'the admin session is cookie/DB based, not process memory');
    const list = (await sameFresh.json()).data.site.find((s) => s.key === 'pageSale'); assert.equal(list.banner.alt, 'Winter sale rail');
  } finally { fresh.close(); fresh.closeAllConnections?.(); }
});

test('replace: the new image goes live, the old one is deleted from storage and the registry; a failed save keeps the old banner', { skip: SKIP }, async () => {
  const b = await staffBrowser(); const MediaAsset = await model('MediaAsset');
  const a = await upload(b, jpeg(1500)); await b.put('/api/admin/banners/site/homeMen', { image: { url: a.data.url, alt: 'First banner' } });
  const oldId = publicIdOf(a.data.url); assert.ok(cloud.files.has(oldId));
  const bad = await b.put('/api/admin/banners/site/homeMen', { image: { url: 'https://res.cloudinary.com/democloud/image/upload/v1/nessence/banners/never-uploaded.jpg', alt: 'Forged' } });
  assert.equal(bad.status, 400); assert.equal(bad.code, 'INVALID_IMAGE');
  assert.equal((await app.browser().get('/api/banners')).data.site.homeMen.alt, 'First banner', 'the live banner is untouched by a rejected save'); assert.ok(cloud.files.has(oldId));
  const c = await upload(b, jpeg(1800)); const r = await b.put('/api/admin/banners/site/homeMen', { image: { url: c.data.url, alt: 'Second banner' } });
  assert.equal(r.status, 200);
  const pub = (await app.browser().get('/api/banners')).data.site.homeMen; assert.equal(pub.alt, 'Second banner'); assert.ok(pub.url.includes(publicIdOf(c.data.url)));
  assert.ok(cloud.destroyed.includes(oldId), 'old asset deleted from persistent storage'); assert.equal(cloud.files.has(oldId), false); assert.equal(await MediaAsset.findOne({ publicId: oldId }), null);
  assert.ok(cloud.files.has(publicIdOf(c.data.url)), 'new asset kept'); assert.equal((await MediaAsset.findOne({ publicId: publicIdOf(c.data.url) }).lean()).status, 'active');
});

test('settings-only save (alt text, show/hide) changes the record without touching the stored image; hidden banners fall back on the storefront', { skip: SKIP }, async () => {
  const b = await staffBrowser(); const a = await upload(b, jpeg()); const id = publicIdOf(a.data.url);
  await b.put('/api/admin/banners/site/homeWomen', { image: { url: a.data.url, alt: 'Original alt' } }); cloud.destroyed.length = 0;
  const r = await b.put('/api/admin/banners/site/homeWomen', { image: { url: a.data.url, alt: 'Better alt text' }, active: false });
  assert.equal(r.status, 200); assert.equal(r.data.active, false); assert.deepEqual(cloud.destroyed, [], 'same image is never deleted'); assert.ok(cloud.files.has(id));
  assert.equal((await app.browser().get('/api/banners')).data.site.homeWomen, undefined, 'hidden → storefront uses its built-in layout');
  const admin = (await b.get('/api/admin/banners')).data.site.find((s) => s.key === 'homeWomen'); assert.equal(admin.banner.alt, 'Better alt text'); assert.equal(admin.banner.active, false); assert.equal(admin.banner.url, a.data.url);
  await b.put('/api/admin/banners/site/homeWomen', { image: { url: a.data.url, alt: 'Better alt text' }, active: true });
  assert.equal((await app.browser().get('/api/banners')).data.site.homeWomen.alt, 'Better alt text');
});

test('reset: deletes the record and the stored image, the storefront falls back, and repeating it is harmless', { skip: SKIP }, async () => {
  const b = await staffBrowser(); const a = await upload(b, jpeg()); const id = publicIdOf(a.data.url);
  await b.put('/api/admin/banners/site/pageWomen', { image: { url: a.data.url, alt: 'Women page banner' } }); assert.ok((await app.browser().get('/api/banners')).data.site.pageWomen);
  const r = await b.del('/api/admin/banners/site/pageWomen'); assert.equal(r.status, 200); assert.deepEqual(r.data, { reset: true, hadBanner: true });
  assert.equal((await app.browser().get('/api/banners')).data.site.pageWomen, undefined);
  assert.equal(await (await model('SiteContent')).findOne({ key: 'banner:pageWomen' }), null); assert.ok(cloud.destroyed.includes(id)); assert.equal(cloud.files.has(id), false); assert.equal(await (await model('MediaAsset')).findOne({ publicId: id }), null);
  assert.deepEqual((await b.del('/api/admin/banners/site/pageWomen')).data, { reset: true, hadBanner: false });
  assert.ok(await (await model('AdminAuditLog')).findOne({ action: 'banner.reset', resourceId: 'site:pageWomen' }));
});

test('collection and category banners: saved on the document, public only while active, removed with the document, never leaked by catalog endpoints', { skip: SKIP }, async () => {
  const b = await staffBrowser('admin'); const Collection = await model('Collection'); const Category = await model('Category');
  const col = await Collection.create({ name: 'Autumn Edit', slug: 'autumn-edit', featured: true }); const cat = await Category.create({ name: 'Coats', slug: 'coats' });
  const u1 = await upload(b, jpeg(1200)); const u2 = await upload(b, jpeg(1300));
  assert.equal((await b.put(`/api/admin/banners/collection/${col._id}`, { image: { url: u1.data.url, alt: 'Autumn edit banner' } })).status, 200);
  assert.equal((await b.put(`/api/admin/banners/category/${cat._id}`, { image: { url: u2.data.url, alt: 'Coats banner' } })).status, 200);
  let pub = (await app.browser().get('/api/banners')).data; assert.equal(pub.collections['autumn-edit'].alt, 'Autumn edit banner'); assert.equal(pub.categories.coats.alt, 'Coats banner');
  const stored = await Collection.findById(col._id).lean(); assert.equal(stored.banner.url, u1.data.url); assert.ok(stored.banner.publicId);
  const one = await app.browser().get('/api/collections/autumn-edit'); assert.equal(one.status, 200); assert.equal('banner' in one.data, false, 'no storage internals via the catalog endpoint');
  const list = (await b.get('/api/admin/banners')).data; assert.equal(list.collections.find((c) => c.id === String(col._id)).banner.alt, 'Autumn edit banner'); assert.equal(list.collections.find((c) => c.id === String(col._id)).featured, true);
  await Collection.updateOne({ _id: col._id }, { active: false }); pub = (await app.browser().get('/api/banners')).data; assert.equal(pub.collections['autumn-edit'], undefined, 'inactive collections show no banner'); await Collection.updateOne({ _id: col._id }, { active: true });
  assert.equal((await b.put(`/api/admin/banners/collection/${'f'.repeat(24)}`, { image: { url: u1.data.url, alt: 'Nobody home' } })).status, 404);
  assert.equal((await b.put('/api/admin/banners/collection/not-an-id', { image: { url: u1.data.url, alt: 'Bad id here' } })).status, 400);
  assert.equal((await b.put('/api/admin/banners/site/notASlot', { image: { url: u1.data.url, alt: 'Bad slot' } })).status, 400);
  assert.equal((await b.del(`/api/admin/banners/category/${cat._id}`)).data.hadBanner, true); assert.equal((await Category.findById(cat._id).lean()).banner, undefined);
  assert.equal((await app.browser().get('/api/banners')).data.categories.coats, undefined); assert.ok(cloud.destroyed.includes(publicIdOf(u2.data.url)));
  const del = await b.del(`/api/admin/collections/${col._id}`); assert.equal(del.status, 200, 'deleting the collection');
  assert.ok(cloud.destroyed.includes(publicIdOf(u1.data.url)), 'a deleted collection takes its banner image with it');
});

test('the reconciler never deletes an image that a banner still uses, even if it was left "pending"', { skip: SKIP }, async () => {
  const b = await staffBrowser(); const MediaAsset = await model('MediaAsset'); const { media } = await import('../src/services/mediaService.js');
  const a = await upload(b, jpeg()); const id = publicIdOf(a.data.url);
  await b.put('/api/admin/banners/site/pageNewArrivals', { image: { url: a.data.url, alt: 'New in banner' } });
  await MediaAsset.collection.updateOne({ publicId: id }, { $set: { status: 'pending', updatedAt: new Date(Date.now() - 3 * 864e5) } });
  const summary = await media.reconcile(); assert.ok(summary.repaired >= 1);
  assert.equal(cloud.files.has(id), true, 'still in storage'); assert.equal((await MediaAsset.findOne({ publicId: id }).lean()).status, 'active');
  assert.ok((await app.browser().get('/api/banners')).data.site.pageNewArrivals);
});

test('an upload that is never saved is discardable by its uploader and stays out of the storefront', { skip: SKIP }, async () => {
  const b = await staffBrowser(); const other = await staffBrowser(); const up = await upload(b, jpeg()); const id = publicIdOf(up.data.url);
  assert.equal((await other.del(`/api/admin/uploads/${up.data.assetId}`)).status, 403, 'only the uploader can discard');
  assert.equal((await b.del(`/api/admin/uploads/${up.data.assetId}`)).status, 200); assert.ok(cloud.destroyed.includes(id)); assert.equal(cloud.files.has(id), false);
  const r = await b.put('/api/admin/banners/site/homeHero', { image: { url: up.data.url, alt: 'Discarded image' } }); assert.equal(r.status, 400, 'a discarded upload cannot be saved');
});
