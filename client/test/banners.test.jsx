import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from '../src/App.jsx';
import Banners from '../src/admin/pages/Banners.jsx';
import { ToastProvider } from '../src/admin/ui.jsx';
import { AuthProvider } from '../src/context/AuthContext.jsx';
import { CartProvider } from '../src/context/CartContext.jsx';
import { SettingsProvider } from '../src/context/SettingsContext.jsx';

const ok = (data, status = 200, meta) => ({ status, body: { success: true, data, ...(meta ? { meta } : {}) } });
const fail = (status, code, message) => ({ status, body: { success: false, code, message } });
const json = (r) => new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
const CDN = 'https://res.cloudinary.com/democloud/image/upload/v1/nessence/banners';
const pub = (name, alt) => ({ url: `${CDN}/${name}.jpg`, srcSet: `${CDN}/${name}.jpg 640w, ${CDN}/${name}.jpg 1280w`, alt, width: 1600, height: 900 });

// ============================ storefront ============================
const emptyCart = { items: [], saved: [], coupon: null, couponError: null, canCheckout: false, totals: { subtotal: 0, discount: 0, shipping: 0, tax: 0, total: 0, itemCount: 0 } };
const card = (n) => ({ id: `p-${n}`, slug: n, name: `Piece ${n}`, gender: 'women', category: { name: 'Coats', slug: 'coats' }, price: 1200000, salePrice: null, images: [{ id: `i${n}`, url: `/img/${n}.svg`, alt: `Piece ${n}` }], colors: [], sizes: [], inStock: true });
const pg = { pagination: { page: 1, limit: 8, total: 5, pages: 1 }, facets: {} };
const cats = [{ name: 'Shirts', slug: 'shirts', genders: ['men'] }, { name: 'Dresses', slug: 'dresses', genders: ['women'] }];
const collections = [{ name: 'Autumn Edit', slug: 'autumn-edit', description: 'Layers for the season.', season: 'AW26', genders: ['men', 'women'], featured: true }];
let banners, bannersStatus, calls;
const store = (path, search = '') => {
  if (path === '/api/banners') return bannersStatus === 200 ? ok(banners) : fail(bannersStatus, 'BOOM', 'down');
  if (path === '/api/auth/me' || path === '/api/auth/refresh') return fail(401, 'UNAUTHORIZED', 'x');
  if (path === '/api/cart') return ok(emptyCart);
  if (path === '/api/settings/public') return ok({ storeName: 'Nessence', social: {} });
  if (path === '/api/categories') return ok(cats);
  if (path === '/api/collections') return ok(collections);
  if (path === '/api/collections/autumn-edit') return ok(collections[0]);
  if (path === '/api/products') return ok(['one', 'two', 'three', 'four', 'five'].map(card), 200, pg);
  if (path === '/api/journal') return ok([], 200, { pagination: { page: 1, limit: 3, total: 0, pages: 1 } });
  return fail(404, 'NOT_FOUND', `no stub for ${path}`);
};
const mount = (path = '/') => render(<MemoryRouter initialEntries={[path]}><SettingsProvider><AuthProvider><CartProvider><App /></CartProvider></AuthProvider></SettingsProvider></MemoryRouter>);
const stubStore = () => { globalThis.fetch = vi.fn(async (url) => { const u = new URL(String(url), 'http://x'); calls.push(u.pathname); return json(store(u.pathname, u.search)); }); };
const imgsWithSrc = (part) => [...document.querySelectorAll('img')].filter((i) => (i.getAttribute('src') ?? '').includes(part));

describe('storefront banners', () => {
  beforeEach(() => { banners = { site: {}, collections: {}, categories: {} }; bannersStatus = 200; calls = []; window.scrollTo = () => {}; vi.spyOn(console, 'error').mockImplementation(() => {}); stubStore(); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('home: hero, both department tiles and the featured collection show their saved banners', async () => {
    banners = { site: { homeHero: pub('hero', 'Hero banner alt'), homeMen: pub('men', 'Men tile alt'), homeWomen: pub('women', 'Women tile alt') }, collections: { 'autumn-edit': pub('autumn', 'Autumn banner alt') }, categories: {} };
    mount();
    const hero = await screen.findByAltText('Hero banner alt'); expect(hero.getAttribute('src')).toBe(`${CDN}/hero.jpg`); expect(hero.getAttribute('srcset')).toContain('1280w');
    expect((await screen.findByAltText('Men tile alt')).closest('a').getAttribute('href')).toBe('/men');
    expect((await screen.findByAltText('Women tile alt')).closest('a').getAttribute('href')).toBe('/women');
    expect(await screen.findByAltText('Autumn banner alt')).toBeTruthy();
    expect(screen.queryByText(/^New · Piece one/)).toBeNull(); // the product caption belongs to the fallback image only
  });

  it('home fallback: with nothing configured the existing layout and latest-arrival image are used', async () => {
    mount(); await screen.findByRole('heading', { name: /in-between/, level: 1 });
    await waitFor(() => expect(calls).toContain('/api/banners'));
    await waitFor(() => expect(imgsWithSrc('/img/one.svg').length).toBeGreaterThan(0));
    expect(imgsWithSrc('cloudinary').length).toBe(0); expect(screen.getByText(/New · Piece one/)).toBeTruthy();
    expect(screen.getByRole('link', { name: /Menswear/ })).toBeTruthy(); expect(screen.getByRole('link', { name: /Womenswear/ })).toBeTruthy();
  });

  it('a failing banner service never breaks the page: the default layout renders', async () => {
    bannersStatus = 500; mount(); await screen.findByRole('heading', { name: /in-between/, level: 1 });
    await waitFor(() => expect(calls).toContain('/api/banners')); await waitFor(() => expect(imgsWithSrc('/img/one.svg').length).toBeGreaterThan(0)); expect(imgsWithSrc('cloudinary').length).toBe(0);
  });

  it('shop pages: each page shows its own banner; a selected category banner wins; no banner means none', async () => {
    banners = { site: { pageMen: pub('men-page', 'Men page alt'), pageSale: pub('sale-page', 'Sale page alt') }, collections: {}, categories: { shirts: pub('shirts', 'Shirts banner alt') } };
    const a = mount('/men'); expect(await screen.findByAltText('Men page alt')).toBeTruthy(); expect(screen.queryByAltText('Sale page alt')).toBeNull(); a.unmount();
    const b = mount('/sale'); expect(await screen.findByAltText('Sale page alt')).toBeTruthy(); expect(screen.queryByAltText('Men page alt')).toBeNull(); b.unmount();
    const c = mount('/men?category=shirts'); expect(await screen.findByAltText('Shirts banner alt')).toBeTruthy(); expect(screen.queryByAltText('Men page alt')).toBeNull(); c.unmount();
    mount('/women'); await screen.findByRole('heading', { level: 1 }); await waitFor(() => expect(calls.filter((p) => p === '/api/banners').length).toBeGreaterThan(3)); expect(imgsWithSrc('cloudinary').length).toBe(0);
  });

  it('collections list and collection page show the collection banner', async () => {
    banners = { site: {}, collections: { 'autumn-edit': pub('autumn', 'Autumn banner alt') }, categories: {} };
    const a = mount('/collections'); expect(await screen.findByAltText('Autumn banner alt')).toBeTruthy(); a.unmount();
    mount('/collections/autumn-edit'); expect(await screen.findByAltText('Autumn banner alt')).toBeTruthy();
  });

  it('collections without a banner render as before', async () => {
    mount('/collections'); await screen.findByText('Autumn Edit'); await waitFor(() => expect(calls).toContain('/api/banners')); expect(imgsWithSrc('cloudinary').length).toBe(0);
  });
});

// ============================ admin ============================
let srv;
const slot = (key, label) => ({ key, label, where: `Where ${key} shows`, hint: 'Wide image', banner: null, updatedAt: null });
const adminBanner = (url, alt, active = true) => ({ url, preview: `${url}?w=640`, alt, active, width: 1600, height: 900 });
const collection = { id: 'c'.repeat(24), name: 'Autumn Edit', slug: 'autumn-edit', active: true, featured: true, banner: null };
const startAdmin = () => {
  srv = { site: [slot('homeHero', 'Home: hero'), slot('pageSale', 'Sale page banner')], collections: [{ ...collection }], categories: [], calls: [], uploads: 0, uploadError: null };
  globalThis.fetch = vi.fn(async (url, init = {}) => {
    const u = new URL(String(url), 'http://x'); const method = init.method ?? 'GET'; const p = u.pathname.replace('/api/admin', '');
    const body = init.body && typeof init.body === 'string' ? JSON.parse(init.body) : init.body; srv.calls.push({ method, path: p, body });
    if (method === 'GET' && p === '/banners') return json(ok({ site: srv.site, collections: srv.collections, categories: srv.categories }));
    if (method === 'POST' && p === '/uploads/product-image') { if (srv.uploadError) return json(fail(...srv.uploadError)); srv.uploads += 1; return json(ok({ url: `${CDN}/new${srv.uploads}.jpg`, assetId: `asset${srv.uploads}` }, 201)); }
    if (method === 'DELETE' && p.startsWith('/uploads/')) return json(ok({ discarded: true }));
    const m = p.match(/^\/banners\/(site|collection|category)\/(.+)$/);
    if (m) {
      const rows = m[1] === 'site' ? srv.site : m[1] === 'collection' ? srv.collections : srv.categories; const row = rows.find((r) => (r.key ?? r.id) === m[2]);
      if (method === 'PUT') { row.banner = adminBanner(body.image.url, body.image.alt, body.active); return json(ok(row.banner)); }
      if (method === 'DELETE') { const had = Boolean(row.banner); row.banner = null; return json(ok({ reset: true, hadBanner: had })); }
    }
    return json(fail(404, 'NOT_FOUND', `no stub ${method} ${p}`));
  });
};
const mountAdmin = () => render(<ToastProvider><Banners /></ToastProvider>);
const cardOf = async (title) => within((await screen.findByRole('heading', { name: title, level: 2 })).closest('section'));
const png = (name = 'new.png', type = 'image/png') => new File([new Uint8Array([137, 80, 78, 71, 1, 2, 3])], name, { type });
const choose = (title, file) => fireEvent.change(screen.getByLabelText(`${title} image file`), { target: { files: [file] } });
const puts = () => srv.calls.filter((c) => c.method === 'PUT'); const dels = () => srv.calls.filter((c) => c.method === 'DELETE' && c.path.startsWith('/banners'));

describe('admin banner controls', () => {
  beforeEach(() => { startAdmin(); vi.spyOn(console, 'error').mockImplementation(() => {}); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('lists every site slot, collection and category with its default state', async () => {
    mountAdmin(); const hero = await cardOf('Home: hero'); expect(hero.getByText('Using the default NESSENCE image')).toBeTruthy(); expect(hero.getByText(/Where homeHero shows/)).toBeTruthy();
    expect(await cardOf('Sale page banner')).toBeTruthy(); const col = await cardOf('Autumn Edit'); expect(col.getByText(/featured on the home page/)).toBeTruthy();
    expect(hero.queryByRole('button', { name: 'Reset to default' })).toBeNull(); expect(hero.getByRole('button', { name: 'Save' }).disabled).toBe(true);
    expect(screen.getByText('No categories yet.')).toBeTruthy();
  });

  it('upload → preview → save sends the uploaded URL and alt text, then shows the saved state', async () => {
    mountAdmin(); let hero = await cardOf('Home: hero'); choose('Home: hero', png());
    await waitFor(() => expect(srv.uploads).toBe(1)); expect(srv.calls.find((c) => c.method === 'POST').path).toBe('/uploads/product-image'); // purpose=banner is in the query string
    expect(String(globalThis.fetch.mock.calls.find(([u]) => String(u).includes('product-image'))[0])).toContain('purpose=banner');
    await waitFor(() => expect(hero.getByText(/not live until you save/)).toBeTruthy()); expect(within(screen.getAllByTestId('banner-preview')[0]).getByRole('presentation').getAttribute('src')).toBe(`${CDN}/new1.jpg`);
    fireEvent.change(hero.getByLabelText('Alt text'), { target: { value: 'Model in an oxblood coat' } }); fireEvent.click(hero.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(puts().length).toBe(1)); expect(puts()[0]).toMatchObject({ path: '/banners/site/homeHero', body: { image: { url: `${CDN}/new1.jpg`, alt: 'Model in an oxblood coat' }, active: true } });
    await waitFor(async () => expect((await cardOf('Home: hero')).getByRole('button', { name: 'Reset to default' })).toBeTruthy()); hero = await cardOf('Home: hero'); // the card remounts with the server's saved state
    expect(hero.getByRole('button', { name: 'Replace image' })).toBeTruthy(); expect(hero.queryByText(/not live until you save/)).toBeNull(); expect(srv.calls.filter((c) => c.method === 'GET' && c.path === '/banners').length).toBeGreaterThan(1); // reloaded from the server
  });

  it('collection banners save to the collection endpoint', async () => {
    mountAdmin(); const col = await cardOf('Autumn Edit'); choose('Autumn Edit', png());
    await waitFor(() => expect(col.getByText(/not live until you save/)).toBeTruthy()); fireEvent.click(col.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(puts()[0]?.path).toBe(`/banners/collection/${collection.id}`)); expect(puts()[0].body.image.alt).toBe('Autumn Edit banner');
  });

  it('replace: a new upload on an existing banner saves the new URL', async () => {
    srv.site[0].banner = adminBanner(`${CDN}/old.jpg`, 'Old alt'); mountAdmin(); const hero = await cardOf('Home: hero');
    expect(hero.getByRole('button', { name: 'Replace image' })).toBeTruthy(); choose('Home: hero', png('b.webp', 'image/webp')); await waitFor(() => expect(srv.uploads).toBe(1));
    await waitFor(() => expect(hero.getByRole('button', { name: 'Save' }).disabled).toBe(false)); fireEvent.click(hero.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(puts()[0]?.body.image).toEqual({ url: `${CDN}/new1.jpg`, alt: 'Old alt' }));
  });

  it('alt text and show/hide save without re-uploading; the existing image URL is kept', async () => {
    srv.site[0].banner = adminBanner(`${CDN}/old.jpg`, 'Old alt'); mountAdmin(); const hero = await cardOf('Home: hero');
    fireEvent.change(hero.getByLabelText('Alt text'), { target: { value: 'Sharper alt text' } }); fireEvent.click(hero.getByLabelText('Show this banner on the storefront')); fireEvent.click(hero.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(puts().length).toBe(1)); expect(puts()[0].body).toEqual({ image: { url: `${CDN}/old.jpg`, alt: 'Sharper alt text' }, active: false }); expect(srv.uploads).toBe(0);
    await waitFor(async () => expect((await cardOf('Home: hero')).getByText(/saved but hidden/)).toBeTruthy());
  });

  it('reset asks for confirmation, then deletes and returns to the default image', async () => {
    srv.site[0].banner = adminBanner(`${CDN}/old.jpg`, 'Old alt'); mountAdmin(); const hero = await cardOf('Home: hero');
    fireEvent.click(hero.getByRole('button', { name: 'Reset to default' })); expect(dels().length).toBe(0); // not until confirmed
    const dialog = within(await screen.findByRole('dialog')); fireEvent.click(dialog.getByRole('button', { name: 'Reset' }));
    await waitFor(() => expect(dels().map((c) => c.path)).toEqual(['/banners/site/homeHero']));
    await waitFor(async () => expect((await cardOf('Home: hero')).getByText('Using the default NESSENCE image')).toBeTruthy());
  });

  it('cancelling the reset confirmation changes nothing', async () => {
    srv.site[0].banner = adminBanner(`${CDN}/old.jpg`, 'Old alt'); mountAdmin(); const hero = await cardOf('Home: hero');
    fireEvent.click(hero.getByRole('button', { name: 'Reset to default' })); fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' })); expect(dels().length).toBe(0);
  });

  it('discarding a staged upload deletes it from storage and restores the previous preview', async () => {
    mountAdmin(); const hero = await cardOf('Home: hero'); choose('Home: hero', png()); await waitFor(() => expect(hero.getByRole('button', { name: 'Discard upload' })).toBeTruthy());
    fireEvent.click(hero.getByRole('button', { name: 'Discard upload' })); await waitFor(() => expect(srv.calls.some((c) => c.method === 'DELETE' && c.path === '/uploads/asset1')).toBe(true));
    expect(hero.getByText('Using the default NESSENCE image')).toBeTruthy(); expect(puts().length).toBe(0);
  });

  it('rejects a wrong file type in the browser (no upload) and shows server upload errors', async () => {
    mountAdmin(); const hero = await cardOf('Home: hero');
    choose('Home: hero', new File(['GIF89a'], 'a.gif', { type: 'image/gif' })); expect(await hero.findByText('Choose a JPEG, PNG or WebP image.')).toBeTruthy(); expect(srv.uploads).toBe(0);
    srv.uploadError = [413, 'FILE_TOO_LARGE', 'Image is too large (max 5 MB).']; choose('Home: hero', png()); expect(await hero.findByText('Image is too large (max 5 MB).')).toBeTruthy(); expect(hero.queryByText(/not live until you save/)).toBeNull();
  });

  it('save is blocked without an image or a meaningful alt text, and server save errors are shown', async () => {
    mountAdmin(); const hero = await cardOf('Home: hero'); choose('Home: hero', png()); await waitFor(() => expect(srv.uploads).toBe(1));
    fireEvent.change(hero.getByLabelText('Alt text'), { target: { value: 'ab' } }); fireEvent.click(hero.getByRole('button', { name: 'Save' }));
    expect(await hero.findByText(/at least 3 characters/)).toBeTruthy(); expect(puts().length).toBe(0);
    const orig = globalThis.fetch; globalThis.fetch = vi.fn(async (u, i) => (i?.method === 'PUT' ? json(fail(400, 'INVALID_IMAGE', 'That image is not valid.')) : orig(u, i)));
    fireEvent.change(hero.getByLabelText('Alt text'), { target: { value: 'A proper description' } }); fireEvent.click(hero.getByRole('button', { name: 'Save' }));
    expect(await hero.findByText('That image is not valid.')).toBeTruthy();
  });
});
