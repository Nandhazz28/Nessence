import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { SKIP, integrationEnabled, configureEnv, bootApp, makeStaff, makeProduct } from './helpers/integration.js';

// Admin product image management, end to end: the real Express app, real Mongoose models, the real media registry and the
// real Cloudinary provider. Only the Cloudinary SDK network calls are replaced (in memory, below). Tests that need a
// database are skipped, not passed, when TEST_MONGODB_URI is not set.
configureEnv({ LOG_LEVEL: process.env.TEST_LOG ?? 'silent', STORAGE_PROVIDER: 'cloudinary', CLOUDINARY_CLOUD_NAME: 'democloud', CLOUDINARY_API_KEY: 'k', CLOUDINARY_API_SECRET: 's', IMAGE_MAX_BYTES: '60000' });

const { v2: cloudinary } = await import('cloudinary');
const { createBody, updateBody, MAX_IMAGES } = await import('../src/services/admin/productAdmin.js');
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
        cb(null, { public_id: opts.public_id, secure_url: `https://res.cloudinary.com/democloud/image/upload/v1/${opts.public_id}.jpg`, bytes: bytes.length, width: 1200, height: 1500, format: 'jpg', version: 1 });
      }
      done();
    },
  });
};
cloudinary.uploader.destroy = async (id) => { cloud.destroyed.push(id); return { result: cloud.files.delete(id) ? 'ok' : 'not found' }; };

const jpeg = (n = 2000, fill = 7) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(n, fill)]);
const here = path.dirname(fileURLToPath(import.meta.url));
const localUploads = path.join(here, '..', 'uploads', 'products');
const listLocal = () => (fs.existsSync(localUploads) ? fs.readdirSync(localUploads).sort() : []);
const cookieHeader = (b) => [...b.jar.values()].map((c) => `${c.name}=${c.value}`).join('; ');
const publicIdOf = (url) => new URL(url).pathname.replace(/^\/democloud\/image\/upload\/v1\//, '').replace(/\.jpg$/, '');
const model = async (n) => (await import(`../src/models/${n}.js`))[n];

let app;
before(async () => { if (integrationEnabled) app = await bootApp(); });
after(async () => { await app?.stop(); });

async function upload(b, bytes, { name = 'photo.jpg', type = 'image/jpeg' } = {}) {
  const form = new FormData(); if (bytes) form.append('file', new Blob([bytes], { type }), name);
  const res = await fetch(`${app.base}/api/admin/uploads/product-image`, { method: 'POST', headers: { 'x-requested-with': 'nessence', cookie: cookieHeader(b) }, body: form });
  const json = await res.json().catch(() => null); return { status: res.status, code: json?.code, data: json?.data };
}
async function staffBrowser(role = 'admin') {
  const s = await makeStaff({ role }); const b = app.browser(); const r = await b.post('/api/admin/auth/login', { email: s.email, password: s.password });
  assert.equal(r.status, 200); return b;
}
// uploads n distinct images and returns the {url, alt} entries the admin form would send
async function uploads(b, n, alt = 'Satin cowl slip') {
  const out = [];
  for (let i = 0; i < n; i++) { const r = await upload(b, jpeg(2000, i + 1)); assert.equal(r.status, 201, r.code); out.push({ url: r.data.url, alt: `${alt} ${i + 1}`, assetId: r.data.assetId }); }
  return out;
}
const strip = (list) => list.map(({ url, alt, color }) => ({ url, alt, ...(color ? { color } : {}) }));
const storefront = async (slug) => (await app.browser().get(`/api/products/${slug}`)).data;
// The card shape served by GET /api/products. The development stand-in database (FerretDB) lacks the $facet stage the list
// endpoint's filter sidebar needs; there we run the very same serializer (toListItem) over the stored document instead.
async function storefrontList(slug) {
  const r = await app.browser().get(`/api/products?slugs=${slug}`);
  if (r.status === 200) return r.data;
  assert.match(String(r.json?.debug ?? ''), /\$facet/, `list endpoint failed for a reason other than the stand-in database: ${r.status} ${r.code}`);
  const { toListItem } = await import('../src/services/catalogService.js');
  return [toListItem(await (await model('Product')).findOne({ slug }).populate('category', 'name slug').lean())];
}
const diskIds = (urls) => urls.map(publicIdOf);

// =============== always run (no database) ===============

test('product body: duplicate gallery images, short alt text, foreign hosts, smuggled storage ids and >20 images are refused', () => {
  const good = (n) => `https://res.cloudinary.com/democloud/image/upload/v1/nessence/products/img-${n}.jpg`;
  const base = { name: 'Satin Cowl Slip', description: 'A cowl-neck slip dress.', gender: 'women', categoryId: 'a'.repeat(24), price: 890000 };
  const ok = (images) => updateBody.safeParse({ images }).success;
  assert.equal(ok([{ url: good(1), alt: 'Front view' }, { url: good(2), alt: 'Back view', color: 'Oxblood' }]), true);
  assert.equal(ok([]), true, 'an empty gallery is syntactically valid (the service decides whether it is allowed)');
  const dup = updateBody.safeParse({ images: [{ url: good(1), alt: 'Front view' }, { url: good(1), alt: 'Front again' }] });
  assert.equal(dup.success, false); assert.deepEqual(dup.error.issues[0].path, ['images', 1, 'url']); assert.match(dup.error.issues[0].message, /already in the gallery/);
  assert.equal(ok([{ url: good(1), alt: 'ab' }]), false, 'alt text needs at least 3 characters');
  assert.equal(ok([{ url: good(1), alt: 'x'.repeat(141) }]), false);
  assert.equal(ok([{ url: 'https://evil.example/x.jpg', alt: 'Front view' }]), false);
  assert.equal(ok(Array.from({ length: MAX_IMAGES + 1 }, (_, i) => ({ url: good(i), alt: 'Front view' }))), false);
  assert.equal(ok(Array.from({ length: MAX_IMAGES }, (_, i) => ({ url: good(i), alt: 'Front view' }))), true);
  const smuggled = updateBody.parse({ images: [{ url: good(1), alt: 'Front view', publicId: 'nessence/products/other', order: 9 }] });
  assert.deepEqual(smuggled.images[0], { url: good(1), alt: 'Front view' }, 'storage metadata can never come from the client');
  assert.equal(createBody.safeParse({ ...base, images: [{ url: good(1), alt: 'Front' }, { url: good(1), alt: 'Front again' }] }).success, false, 'create enforces the same rules');
});

// =============== need a MongoDB-compatible server ===============

test('UPLOAD + PREVIEW: an upload is stored remotely and registered as pending; it is not live until the product is saved', { skip: SKIP }, async () => {
  const b = await staffBrowser(); const { product } = await makeProduct({ name: 'Upload Dress' }); const filesBefore = listLocal();
  const [one] = await uploads(b, 1);
  assert.match(one.url, /^https:\/\/res\.cloudinary\.com\/democloud\/image\/upload\/.*nessence\/products\//); assert.ok(one.assetId);
  assert.deepEqual(listLocal(), filesBefore, 'nothing was written to the server disk');
  const MediaAsset = await model('MediaAsset'); const row = await MediaAsset.findById(one.assetId).lean();
  assert.equal(row.status, 'pending'); assert.equal(row.purpose, 'product'); assert.equal(row.url, one.url);
  assert.deepEqual((await storefront(product.slug)).images.map((i) => i.url), ['/media/test.jpg'], 'an unsaved upload is invisible on the storefront (only the existing image shows)');
  const saved = await b.patch(`/api/admin/products/${product._id}`, { images: strip([one]) });
  assert.equal(saved.status, 200); assert.equal(saved.data.images.length, 1); assert.equal(saved.data.images[0].url, one.url, 'the new image replaced the seeded one');
  assert.equal((await MediaAsset.findById(one.assetId).lean()).status, 'active', 'saving attaches the asset');
  assert.ok(saved.data.images[0].id && saved.data.images[0].thumb.includes(publicIdOf(one.url)), 'the admin response carries a stable id and a thumbnail');
  for (const k of ['publicId', 'bytes', 'format', 'width', 'height']) assert.equal(k in saved.data.images[0], false, `${k} is not exposed to the browser`);
});

test('UPLOAD validation: wrong type, oversize, empty and storage failure are refused and nothing is registered', { skip: SKIP }, async () => {
  const b = await staffBrowser(); const MediaAsset = await model('MediaAsset'); cloud.files.clear(); const rows = await MediaAsset.countDocuments();
  assert.equal((await upload(b, Buffer.from('<?php echo 1; ?>'), { name: 'evil.jpg' })).code, 'INVALID_IMAGE');
  assert.equal((await upload(b, Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(100)]), { name: 'x.gif', type: 'image/gif' })).status, 400);
  const big = await upload(b, jpeg(70_000)); assert.equal(big.status, 413); assert.equal(big.code, 'FILE_TOO_LARGE');
  assert.equal((await upload(b, null)).code, 'NO_FILE');
  assert.equal(cloud.files.size, 0); assert.equal(await MediaAsset.countDocuments(), rows);
  cloud.failUpload = true;
  try { const r = await upload(b, jpeg()); assert.equal(r.status, 502); assert.equal(r.code, 'STORAGE_UNAVAILABLE'); } finally { cloud.failUpload = false; }
});

test('UPLOAD authorization: only staff with product (or content) permission can upload; anonymous and support cannot', { skip: SKIP }, async () => {
  const anon = await fetch(`${app.base}/api/admin/uploads/product-image`, { method: 'POST', headers: { 'x-requested-with': 'nessence' } }); assert.equal(anon.status, 401);
  assert.equal((await upload(await staffBrowser('support'), jpeg())).status, 403);
  assert.equal((await upload(await staffBrowser('admin'), jpeg())).status, 201);
});

test('REGRESSION: a PATCH only changes the fields it sends (an image-only save keeps status/tags/collections; a status-only save keeps the gallery)', { skip: SKIP }, async () => {
  const b = await staffBrowser(); const { product } = await makeProduct({ name: 'Partial Dress', status: 'published' }); const [a, c] = await uploads(b, 2);
  const Product = await model('Product'); await Product.updateOne({ _id: product._id }, { $set: { tags: ['silk', 'evening'], care: ['Dry clean'], featured: true } });
  const imgs = await b.patch(`/api/admin/products/${product._id}`, { images: strip([a, c]) }); assert.equal(imgs.status, 200);
  const after = await Product.findById(product._id).lean();
  assert.equal(after.status, 'published', 'saving images must not un-publish the product'); assert.deepEqual(after.tags, ['silk', 'evening']); assert.deepEqual(after.care, ['Dry clean']); assert.equal(after.featured, true);
  assert.equal(after.images.length, 2);
  const st = await b.patch(`/api/admin/products/${product._id}`, { featured: false }); assert.equal(st.status, 200);
  const again = await Product.findById(product._id).lean(); assert.equal(again.images.length, 2, 'a patch without images must not wipe the gallery'); assert.equal(again.status, 'published'); assert.equal(again.featured, false);
});

test('MULTIPLE + ORDER: several images save in the submitted order, the first is the primary one on cards and the gallery', { skip: SKIP }, async () => {
  const b = await staffBrowser(); const { product } = await makeProduct({ name: 'Order Dress' });
  const [a, c, d] = await uploads(b, 3);
  const first = await b.patch(`/api/admin/products/${product._id}`, { images: strip([a, c, d]) });
  assert.deepEqual(first.data.images.map((i) => i.url), [a.url, c.url, d.url]); assert.deepEqual(first.data.images.map((i) => i.order), [0, 1, 2]);
  let sf = await storefront(product.slug); assert.deepEqual(sf.images.map((i) => i.alt), [a.alt, c.alt, d.alt]);
  assert.match((await storefrontList(product.slug))[0].images[0].url, new RegExp(publicIdOf(a.url)), 'primary = first image');

  // "Make primary" on the last image + swap the other two
  const reordered = await b.patch(`/api/admin/products/${product._id}`, { images: strip([d, c, a]) });
  assert.deepEqual(reordered.data.images.map((i) => i.url), [d.url, c.url, a.url]);
  sf = await storefront(product.slug); assert.deepEqual(sf.images.map((i) => i.alt), [d.alt, c.alt, a.alt]);
  const card = (await storefrontList(product.slug))[0]; assert.equal(card.images[0].alt, d.alt); assert.equal(card.images[1].alt, c.alt, 'second image is the hover image');
  assert.match(card.images[0].url, new RegExp(publicIdOf(d.url)));
  const adminRead = await b.get(`/api/admin/products/${product._id}`); assert.deepEqual(adminRead.data.images.map((i) => i.alt), [d.alt, c.alt, a.alt], 'admin reads back the same order');
  assert.deepEqual(cloud.destroyed.filter((id) => diskIds([a.url, c.url, d.url]).includes(id)), [], 'reordering never destroys assets');
});

test('REPLACE: swapping an image keeps its position, alt text and colour; the old asset is destroyed only after the save', { skip: SKIP }, async () => {
  const b = await staffBrowser(); const { product } = await makeProduct({ name: 'Replace Dress', color: { name: 'Oxblood', hex: '#5a1a1f' } });
  const [a, c] = await uploads(b, 2);
  await b.patch(`/api/admin/products/${product._id}`, { images: [{ url: a.url, alt: 'Front view', color: 'Oxblood' }, { url: c.url, alt: 'Back view' }] });
  const [fresh] = await uploads(b, 1); const MediaAsset = await model('MediaAsset');
  cloud.destroyed.length = 0;
  assert.equal(cloud.files.has(publicIdOf(a.url)), true, 'before saving, the old file is still stored (the uploaded replacement is only pending)');
  assert.equal((await MediaAsset.findById(fresh.assetId).lean()).status, 'pending');
  const r = await b.patch(`/api/admin/products/${product._id}`, { images: [{ url: fresh.url, alt: 'Front view', color: 'Oxblood' }, { url: c.url, alt: 'Back view' }] });
  assert.equal(r.status, 200); assert.deepEqual(r.data.images.map((i) => [i.url, i.alt, i.color ?? null]), [[fresh.url, 'Front view', 'Oxblood'], [c.url, 'Back view', null]]);
  assert.deepEqual(cloud.destroyed, [publicIdOf(a.url)], 'exactly the replaced asset was destroyed'); assert.equal(await MediaAsset.findOne({ publicId: publicIdOf(a.url) }), null, 'and its registry row is gone');
  assert.equal((await MediaAsset.findById(fresh.assetId).lean()).status, 'active');
  const sf = await storefront(product.slug); assert.equal(sf.images[0].alt, 'Front view'); assert.match(sf.images[0].url, new RegExp(publicIdOf(fresh.url))); assert.doesNotMatch(JSON.stringify(sf.images), new RegExp(publicIdOf(a.url)));
});

test('REPLACE failure safety: a save that fails validation leaves the old image, the database and the storage untouched', { skip: SKIP }, async () => {
  const b = await staffBrowser(); const { product } = await makeProduct({ name: 'Safe Dress' }); const [a] = await uploads(b, 1); const [fresh] = await uploads(b, 1);
  await b.patch(`/api/admin/products/${product._id}`, { images: strip([a]) }); cloud.destroyed.length = 0;
  const bad = await b.patch(`/api/admin/products/${product._id}`, { images: [{ url: fresh.url, alt: 'x' }] });
  assert.equal(bad.status, 400); assert.equal(bad.code, 'VALIDATION_ERROR'); assert.equal(bad.json.details[0].field, 'images.0.alt');
  assert.deepEqual(cloud.destroyed, []); assert.equal((await storefront(product.slug)).images[0].alt, a.alt);
});

test('DELETE: removing one image keeps the others, destroys only that asset, and an image used on an order is kept in storage', { skip: SKIP }, async () => {
  const b = await staffBrowser(); const { product } = await makeProduct({ name: 'Delete Dress' }); const [a, c, d] = await uploads(b, 3); const MediaAsset = await model('MediaAsset');
  await b.patch(`/api/admin/products/${product._id}`, { images: strip([a, c, d]) }); cloud.destroyed.length = 0;
  const r = await b.patch(`/api/admin/products/${product._id}`, { images: strip([a, d]) });
  assert.equal(r.status, 200); assert.deepEqual(r.data.images.map((i) => i.url), [a.url, d.url]); assert.deepEqual(r.data.images.map((i) => i.order), [0, 1], 'order is re-numbered without gaps');
  assert.deepEqual(cloud.destroyed, [publicIdOf(c.url)]); assert.equal(await MediaAsset.findOne({ publicId: publicIdOf(c.url) }), null);
  assert.equal((await storefront(product.slug)).images.length, 2);
  // deleting the primary promotes the next image
  const p2 = await b.patch(`/api/admin/products/${product._id}`, { images: strip([d]) }); assert.equal(p2.data.images[0].url, d.url);
  assert.equal((await storefrontList(product.slug))[0].images[0].alt, d.alt);

  // an image that an existing order still references is detached from the product but NOT destroyed
  const Order = await model('Order'); const [kept, other] = await uploads(b, 2);
  await b.patch(`/api/admin/products/${product._id}`, { images: strip([kept, other]) });
  await Order.collection.insertOne({ orderNumber: 'NS-TEST-KEEP', items: [{ product: product._id, image: { url: kept.url, publicId: publicIdOf(kept.url) } }] });
  cloud.destroyed.length = 0;
  await b.patch(`/api/admin/products/${product._id}`, { images: strip([other]) });
  assert.deepEqual(cloud.destroyed, [], 'the order still needs it'); assert.equal((await MediaAsset.findOne({ publicId: publicIdOf(kept.url) })).status, 'active');
});

test('DELETE guard: a published product cannot be left without an image; a draft can', { skip: SKIP }, async () => {
  const b = await staffBrowser(); const pub = await makeProduct({ name: 'Guard Dress', status: 'published' }); const [a] = await uploads(b, 1);
  await b.patch(`/api/admin/products/${pub.product._id}`, { images: strip([a]) });
  const r = await b.patch(`/api/admin/products/${pub.product._id}`, { images: [] });
  assert.equal(r.status, 400); assert.equal(r.code, 'LAST_IMAGE'); assert.equal((await storefront(pub.product.slug)).images.length, 1, 'still has its image');
  const draft = await makeProduct({ name: 'Draft Guard', status: 'draft' }); const [d] = await uploads(b, 1);
  await b.patch(`/api/admin/products/${draft.product._id}`, { images: strip([d]) });
  assert.equal((await b.patch(`/api/admin/products/${draft.product._id}`, { images: [] })).status, 200);
});

test('DISCARD: an uploaded-but-never-saved image can be discarded by its uploader (and only by them); attached images cannot', { skip: SKIP }, async () => {
  const b = await staffBrowser(); const other = await staffBrowser(); const { product } = await makeProduct({ name: 'Discard Dress' });
  const [pending, attached] = await uploads(b, 2); await b.patch(`/api/admin/products/${product._id}`, { images: strip([attached]) });
  assert.equal((await other.del(`/api/admin/uploads/${pending.assetId}`)).status, 403);
  cloud.destroyed.length = 0; assert.equal((await b.del(`/api/admin/uploads/${pending.assetId}`)).status, 200);
  assert.deepEqual(cloud.destroyed, [publicIdOf(pending.url)]); assert.equal(await (await model('MediaAsset')).findById(pending.assetId), null);
  const refused = await b.del(`/api/admin/uploads/${attached.assetId}`); assert.equal(refused.status, 409); assert.equal(refused.code, 'IMAGE_IN_USE');
});

test('COLOUR / VARIANT association: images can be tied to a real colour; unknown colours are refused; unchanged legacy colours still save', { skip: SKIP }, async () => {
  const b = await staffBrowser(); const { product } = await makeProduct({ name: 'Colour Dress', color: { name: 'Oxblood', hex: '#5a1a1f' } });
  const [a, c] = await uploads(b, 2);
  const bad = await b.patch(`/api/admin/products/${product._id}`, { images: [{ url: a.url, alt: 'Front view', color: 'Chartreuse' }] });
  assert.equal(bad.status, 400); assert.equal(bad.code, 'INVALID_IMAGE_COLOR'); assert.equal(bad.json.details[0].field, 'images.0.color');
  const good = await b.patch(`/api/admin/products/${product._id}`, { images: [{ url: a.url, alt: 'Front view', color: 'Oxblood' }, { url: c.url, alt: 'Shared detail' }] });
  assert.equal(good.status, 200); assert.deepEqual(good.data.images.map((i) => i.color ?? null), ['Oxblood', null]);
  const sf = await storefront(product.slug); assert.deepEqual(sf.images.map((i) => i.color ?? null), ['Oxblood', null]);
  // reorder keeps the colour with its image
  const swapped = await b.patch(`/api/admin/products/${product._id}`, { images: [{ url: c.url, alt: 'Shared detail' }, { url: a.url, alt: 'Front view', color: 'Oxblood' }] });
  assert.deepEqual(swapped.data.images.map((i) => [i.alt, i.color ?? null]), [['Shared detail', null], ['Front view', 'Oxblood']]);
  // legacy data: an image that already carries a colour the product no longer has can still be saved unchanged (e.g. a variant colour was retired)
  const Product = await model('Product'); const stored = await Product.findById(product._id); stored.images.find((i) => i.url === a.url).color = 'Retired'; await stored.save();
  const legacy = await b.patch(`/api/admin/products/${product._id}`, { images: [{ url: c.url, alt: 'Shared detail' }, { url: a.url, alt: 'Front view (updated)', color: 'Retired' }] });
  assert.equal(legacy.status, 200, 'unchanged legacy colour is accepted');
  // variants are untouched by image edits
  const variants = await (await model('ProductVariant')).find({ product: product._id }).lean(); assert.equal(variants.length, 1); assert.equal(variants[0].color.name, 'Oxblood');
});

test('LIMITS + DUPLICATES: the API refuses duplicates and more than 20 images with field-level errors', { skip: SKIP }, async () => {
  const b = await staffBrowser(); const { product } = await makeProduct({ name: 'Limit Dress' }); const [a] = await uploads(b, 1);
  const dup = await b.patch(`/api/admin/products/${product._id}`, { images: [{ url: a.url, alt: 'Front view' }, { url: a.url, alt: 'Front again' }] });
  assert.equal(dup.status, 400); assert.equal(dup.json.details[0].field, 'images.1.url');
  const many = await b.patch(`/api/admin/products/${product._id}`, { images: Array.from({ length: 21 }, (_, i) => ({ url: `${a.url}?${i}`, alt: 'Front view' })) });
  assert.equal(many.status, 400);
  const foreign = await b.patch(`/api/admin/products/${product._id}`, { images: [{ url: 'https://evil.example/x.jpg', alt: 'Front view' }] }); assert.equal(foreign.status, 400);
  const notUploaded = await b.patch(`/api/admin/products/${product._id}`, { images: [{ url: 'https://res.cloudinary.com/democloud/image/upload/v1/nessence/products/never-uploaded.jpg', alt: 'Front view' }] });
  assert.equal(notUploaded.status, 400); assert.equal(notUploaded.code, 'INVALID_IMAGE');
});

test('CREATE: a new product can be created with uploaded images in the chosen order and an image colour matching its variants', { skip: SKIP }, async () => {
  const b = await staffBrowser(); const { category } = await makeProduct({ name: 'Seed Category' }); const [a, c] = await uploads(b, 2);
  const body = { name: 'Created With Images', description: 'A product created with a full gallery.', gender: 'women', categoryId: String(category._id), price: 990000, status: 'published',
    images: [{ url: c.url, alt: 'Front view', color: 'Ink' }, { url: a.url, alt: 'Detail view' }], variants: { colors: [{ name: 'Ink', hex: '#181510' }], sizes: ['M'], stock: 3, lowStockThreshold: 1 } };
  const wrong = await b.post('/api/admin/products', { ...body, images: [{ url: c.url, alt: 'Front view', color: 'Pink' }, body.images[1]] }); assert.equal(wrong.status, 400); assert.equal(wrong.code, 'INVALID_IMAGE_COLOR');
  const r = await b.post('/api/admin/products', body); assert.equal(r.status, 201, JSON.stringify(r.json));
  const sf = await storefront(r.data.slug); assert.deepEqual(sf.images.map((i) => i.alt), ['Front view', 'Detail view']); assert.equal(sf.images[0].color, 'Ink');
  assert.equal((await (await model('MediaAsset')).findById(c.assetId).lean()).status, 'active');
});

test('PERSISTENCE / REDEPLOY: images live in the database + remote storage, so a brand-new server process serves exactly the same gallery', { skip: SKIP }, async () => {
  const b = await staffBrowser(); const { product } = await makeProduct({ name: 'Persist Dress' }); const filesBefore = listLocal();
  const [a, c] = await uploads(b, 2);
  await b.patch(`/api/admin/products/${product._id}`, { images: [{ url: c.url, alt: 'Front view' }, { url: a.url, alt: 'Back view' }] });
  const Product = await model('Product'); const doc = await Product.findById(product._id).lean();
  assert.deepEqual(doc.images.map((i) => [i.url, i.alt, i.order, i.publicId]), [[c.url, 'Front view', 0, publicIdOf(c.url)], [a.url, 'Back view', 1, publicIdOf(a.url)]], 'url, alt, order and storage id are stored on the product');
  assert.ok(doc.images.every((i) => i.width && i.height && i.bytes && i.format), 'storage metadata is kept for delivery URLs');
  assert.deepEqual(listLocal(), filesBefore, 'no image bytes live on the app server disk, so a redeploy (which wipes it) cannot lose them');
  // "redeploy": a second, freshly created app instance (no shared in-memory state) over the same database
  const { once } = await import('node:events'); const fresh = createApp().listen(0, '127.0.0.1'); await once(fresh, 'listening');
  try {
    const base = `http://127.0.0.1:${fresh.address().port}`;
    const r = await (await fetch(`${base}/api/products/${product.slug}`)).json();
    assert.deepEqual(r.data.images.map((i) => i.alt), ['Front view', 'Back view']);
    assert.match(r.data.images[0].url, /^https:\/\/res\.cloudinary\.com\/democloud\/image\/upload\/.*nessence\/products\//);
  } finally { fresh.close(); }
  assert.equal((await storefrontList(product.slug))[0].images[0].alt, 'Front view', 'cards show the same primary image');
});

test('STOREFRONT rendering contract: detail images carry id/url/alt/colour, card images carry responsive srcset, and no storage internals leak', { skip: SKIP }, async () => {
  const b = await staffBrowser(); const { product } = await makeProduct({ name: 'Contract Dress', color: { name: 'Ink', hex: '#181510' } }); const [a, c] = await uploads(b, 2);
  await b.patch(`/api/admin/products/${product._id}`, { images: [{ url: a.url, alt: 'Front view', color: 'Ink' }, { url: c.url, alt: 'Detail view' }] });
  const sf = await storefront(product.slug);
  for (const im of sf.images) { assert.ok(im.id); assert.match(im.url, /res\.cloudinary\.com\/democloud\/image\/upload\/.*w_1600/, 'detail preset'); for (const k of ['publicId', 'bytes', 'format', 'width', 'height', 'order']) assert.equal(k in im, false, k); }
  const card = (await storefrontList(product.slug))[0]; assert.match(card.images[0].url, /w_720/); assert.match(card.images[0].srcSet, /360w, .* 720w$/);
  assert.equal(card.images.length, 2);
  const m = await app.browser().get(`/api/products/${product.slug}`); assert.match(m.headers.get('cache-control'), /max-age=30/, 'catalogue responses are cached for at most 30s, so edits show up on the next refresh after that');
});

test('AUDIT: image changes are recorded against the product', { skip: SKIP }, async () => {
  const b = await staffBrowser(); const { product } = await makeProduct({ name: 'Audit Dress' }); const [a] = await uploads(b, 1);
  await b.patch(`/api/admin/products/${product._id}`, { images: strip([a]) });
  const Audit = await model('AdminAuditLog'); const row = await Audit.findOne({ action: 'product.updated', resourceId: String(product._id) }).lean();
  assert.ok(row); assert.deepEqual(row.metadata.fields, ['images']);
  assert.ok(await Audit.findOne({ action: 'image.uploaded', resourceId: a.assetId }));
});
