import { vi } from 'vitest';

// A small stateful stand-in for the Nessence API: one product, admin endpoints for its images (the same routes and
// validation rules the real server exposes) and the public catalogue endpoints serving whatever the admin saved.
// Because the admin and the storefront read the SAME state, tests can edit in the admin and then render the storefront.
export const PID = 'a'.repeat(24);
const CLOUD = 'https://res.cloudinary.com/demo/image/upload/v1/nessence/products';
export const cdn = (name) => `${CLOUD}/${name}.jpg`;
const thumbOf = (url) => url.replace('/upload/', '/upload/w_240,c_limit/');

export function createShop({ status = 'published' } = {}) {
  let n = 0; let imgSeq = 0;
  const mkImg = (name, alt, color, order) => ({ id: `img-${++imgSeq}`, url: cdn(name), thumb: thumbOf(cdn(name)), alt, color, order });
  const shop = {
    calls: [], discarded: [], uploads: new Map(), failUploads: 0, failPatch: null, uploadDelay: 0,
    product: {
      id: PID, _id: PID, name: 'Bias Slip Dress', slug: 'bias-slip-dress-women', description: 'A bias-cut slip dress in matte satin.', gender: 'women', category: 'c'.repeat(24), collections: [],
      price: 940000, salePrice: null, tags: ['satin'], care: [], details: [], status, featured: false, ratingAvg: 0, ratingCount: 0,
      images: [], variants: [
        { id: 'v1', sku: 'NS-BIAS-INK-M', color: { name: 'Ink', hex: '#181510' }, size: 'M', active: true, stock: 5, reserved: 0, lowStockThreshold: 5 },
        { id: 'v2', sku: 'NS-BIAS-OXB-M', color: { name: 'Oxblood', hex: '#5a1a1f' }, size: 'M', active: true, stock: 5, reserved: 0, lowStockThreshold: 5 },
      ],
    },
    seedImages(list) { shop.product.images = list.map(([name, alt, color], i) => mkImg(name, alt, color, i)); },
    last(method, path) { return shop.calls.filter((c) => c.method === method && c.path === path).at(-1); },
    all(method, path) { return shop.calls.filter((c) => c.method === method && c.path === path); },
    // ---- public catalogue ----
    publicCard() {
      const p = shop.product; const imgs = [...p.images].sort((a, b) => a.order - b.order);
      return { id: p.id, slug: p.slug, name: p.name, gender: p.gender, category: { name: 'Dresses', slug: 'dresses' }, price: p.price, salePrice: null, images: imgs.slice(0, 4).map((i) => ({ url: i.url, alt: i.alt, color: i.color })),
        colors: [...new Map(p.variants.map((v) => [v.color.name, v.color])).values()], sizes: ['M'], inStock: true, isNew: false, ratingAvg: 0, ratingCount: 0 };
    },
    publicDetail() {
      const p = shop.product; const imgs = [...p.images].sort((a, b) => a.order - b.order);
      return { ...shop.publicCard(), description: p.description, materials: 'Satin', care: [], details: [], seo: {}, collections: [], images: imgs.map((i) => ({ id: i.id, url: i.url, alt: i.alt, color: i.color })), related: [],
        variants: p.variants.map((v) => ({ id: v.id, sku: v.sku, color: v.color, size: v.size, available: 5, status: 'in_stock' })) };
    },
    // ---- the router ----
    handle(method, path, search, body) {
      const ok = (data, status = 200, meta) => ({ status, body: { success: true, data, ...(meta ? { meta } : {}) } });
      const fail = (status, code, message, details) => ({ status, body: { success: false, code, message, ...(details ? { details } : {}) } });
      const p = shop.product;
      if (path === '/api/admin/categories') return ok([{ _id: p.category, name: 'Dresses', slug: 'dresses', genders: ['women'] }]);
      if (path === '/api/admin/collections') return ok([]);
      if (path === `/api/admin/products/${PID}` && method === 'GET') return ok({ ...p, images: shop.adminImages() });
      if (path === `/api/admin/products/${PID}` && method === 'PATCH') {
        if (shop.failPatch) { const f = shop.failPatch; shop.failPatch = null; return fail(f.status ?? 502, f.code ?? 'STORAGE_UNAVAILABLE', f.message ?? 'Image storage is unavailable right now. Please try again.', f.details); }
        if (body.images) {
          const details = []; const seen = new Set();
          body.images.forEach((im, i) => { if ((im.alt ?? '').trim().length < 3) details.push({ field: `images.${i}.alt`, message: 'Describe the image in at least 3 characters' }); if (seen.has(im.url)) details.push({ field: `images.${i}.url`, message: 'This image is already in the gallery' }); seen.add(im.url); });
          if (details.length) return fail(400, 'VALIDATION_ERROR', 'Please check the highlighted fields', details);
          if (!body.images.length && (body.status ?? p.status) === 'published') return fail(400, 'LAST_IMAGE', 'A published product needs at least one image. Archive or unpublish it first.');
          p.images = body.images.map((im, order) => ({ id: `img-${++imgSeq}`, url: im.url, thumb: thumbOf(im.url), alt: im.alt, color: im.color, order }));
          for (const im of p.images) for (const u of shop.uploads.values()) if (u.url === im.url) u.attached = true;
        }
        for (const k of ['name', 'description', 'status', 'featured']) if (body[k] !== undefined) p[k] = body[k];
        return ok({ ...p, images: shop.adminImages() });
      }
      if (path === '/api/admin/uploads/product-image' && method === 'POST') {
        const file = body?.get?.('file');
        if (!file) return fail(400, 'NO_FILE', 'Choose an image to upload');
        if (shop.failUploads > 0) { shop.failUploads--; return fail(502, 'STORAGE_UNAVAILABLE', 'Image storage is unavailable right now. Please try again.'); }
        const id = ++n; const url = cdn(`upload-${id}`); shop.uploads.set(`asset-${id}`, { url, name: file.name, attached: false });
        return ok({ url, assetId: `asset-${id}`, width: 1200, height: 1500, bytes: file.size }, 201);
      }
      const del = /^\/api\/admin\/uploads\/(asset-\d+)$/.exec(path);
      if (del && method === 'DELETE') { shop.discarded.push(del[1]); shop.uploads.delete(del[1]); return ok({ discarded: true }); }
      if (path === '/api/admin/products' && method === 'POST') { shop.created = body; return ok({ ...p, id: PID, _id: PID, images: [] }, 201); }
      // ---- public ----
      if (path === `/api/products/${p.slug}`) return ok(shop.publicDetail());
      if (path === '/api/products') return ok([shop.publicCard(), { ...shop.publicCard(), id: 'p2', slug: 'two', name: 'Two' }, { ...shop.publicCard(), id: 'p3', slug: 'three', name: 'Three' }], 200, { pagination: { page: 1, limit: 12, total: 3, pages: 1 }, facets: { sizes: [], colors: [], price: { min: 0, max: 1 } } });
      return null;
    },
    adminImages() { return [...shop.product.images].sort((a, b) => a.order - b.order).map((i) => ({ ...i })); },
    install(extra = () => null) {
      globalThis.fetch = vi.fn(async (url, init = {}) => {
        const u = new URL(String(url), 'http://x'); const method = init.method ?? 'GET';
        const body = init.body instanceof FormData ? init.body : init.body ? JSON.parse(init.body) : undefined;
        shop.calls.push({ method, path: u.pathname, search: u.search, body });
        if (shop.uploadDelay && u.pathname.endsWith('/uploads/product-image')) await new Promise((r) => setTimeout(r, shop.uploadDelay));
        const r = shop.handle(method, u.pathname, u.search, body) ?? extra(method, u.pathname, u.search, body)
          ?? { status: 404, body: { success: false, code: 'NOT_FOUND', message: `no stub for ${method} ${u.pathname}` } };
        return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
      });
    },
  };
  return shop;
}
