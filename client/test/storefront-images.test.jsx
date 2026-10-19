import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import App from '../src/App.jsx';
import { AuthProvider } from '../src/context/AuthContext.jsx';
import { CartProvider } from '../src/context/CartContext.jsx';
import { SettingsProvider } from '../src/context/SettingsContext.jsx';
import { ProductForm } from '../src/admin/pages/Products.jsx';
import { ToastProvider } from '../src/admin/ui.jsx';
import { createShop, cdn, PID } from './helpers/fakeShop.js';

// Storefront rendering of the images the admin manages. The admin tests and these tests share one fake server, so a
// change made in the admin editor is what the storefront renders on the next load.

let shop;
const ok = (data, meta) => ({ status: 200, body: { success: true, data, ...(meta ? { meta } : {}) } });
const fail = (status, code) => ({ status, body: { success: false, code, message: code } });
const extra = (method, path) => {
  if (path === '/api/auth/me' || path === '/api/auth/refresh') return fail(401, 'UNAUTHORIZED');
  if (path === '/api/cart') return ok({ items: [], saved: [], coupon: null, couponError: null, canCheckout: false, totals: { subtotal: 0, discount: 0, shipping: 0, tax: 0, total: 0, itemCount: 0 } });
  if (path === '/api/wishlist') return ok([]);
  if (path === '/api/settings/public') return ok({ storeName: 'Nessence', social: {} });
  if (path.endsWith('/reviews')) return ok({ items: [], summary: { average: 0, count: 0, distribution: {} }, viewer: null }, { pagination: { page: 1, limit: 6, total: 0, pages: 1 } });
  if (['/api/categories', '/api/collections', '/api/journal'].includes(path)) return ok([], { pagination: { page: 1, limit: 3, total: 0, pages: 1 } });
  if (path.startsWith('/api/content/')) return fail(404, 'PAGE_NOT_FOUND');
  if (path === '/api/banners') return ok({ site: {}, collections: {}, categories: {} });
  return null;
};
const store = (path) => render(<MemoryRouter initialEntries={[path]}><SettingsProvider><AuthProvider><CartProvider><App /></CartProvider></AuthProvider></SettingsProvider></MemoryRouter>);
const admin = () => render(<ToastProvider><MemoryRouter initialEntries={[`/admin/products/${PID}/edit`]}><Routes><Route path="/admin/products/:id/edit" element={<ProductForm />} /></Routes></MemoryRouter></ToastProvider>);
const thumbs = () => within(document.querySelector('div.order-2')).getAllByRole('button').map((b) => b.querySelector('img').getAttribute('src'));
const mainSrc = () => screen.getByRole('button', { name: /Zoom in on image/ }).querySelector('img').getAttribute('src');

beforeEach(() => {
  shop = createShop(); shop.seedImages([['front', 'Front', 'Ink'], ['detail', 'Detail', ''], ['back', 'Back', 'Oxblood']]); shop.install(extra);
  window.scrollTo = () => {}; URL.createObjectURL = vi.fn(() => 'blob:x'); URL.revokeObjectURL = vi.fn(); vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('product page gallery', () => {
  it('shows the saved images in the saved order for the selected colour, plus the shared ones', async () => {
    store('/products/bias-slip-dress-women'); await screen.findByRole('heading', { name: 'Bias Slip Dress', level: 1 });
    expect(thumbs()).toEqual([cdn('front'), cdn('detail')]); expect(mainSrc()).toBe(cdn('front')); // Ink + shared
    fireEvent.click(screen.getByRole('button', { name: /Oxblood/ })); await waitFor(() => expect(thumbs()).toEqual([cdn('detail'), cdn('back')]));
    fireEvent.click(screen.getByRole('button', { name: 'View image 2' })); expect(mainSrc()).toBe(cdn('back'));
  });
  it('falls back to the whole gallery instead of a blank frame when the colour has no images', async () => {
    shop.seedImages([['only-oxblood', 'Only', 'Oxblood']]); store('/products/bias-slip-dress-women');
    await screen.findByRole('heading', { name: 'Bias Slip Dress', level: 1 }); expect(thumbs()).toEqual([cdn('only-oxblood')]); expect(mainSrc()).toBe(cdn('only-oxblood'));
  });
});

describe('product cards and Home lookbook', () => {
  it('a card shows the primary image, with the second as its hover image', async () => {
    store('/women'); await screen.findAllByRole('heading', { name: 'Bias Slip Dress' });
    const card = screen.getAllByRole('heading', { name: 'Bias Slip Dress' })[0].closest('article'); const imgs = [...card.querySelectorAll('a img')];
    expect(imgs[0].getAttribute('src')).toBe(cdn('front')); expect(imgs[0].getAttribute('alt')).toBe('Front'); expect(imgs[1].getAttribute('src')).toBe(cdn('detail'));
  });
  it('the Home lookbook uses each product’s primary image', async () => {
    store('/'); const lb = await screen.findByRole('heading', { name: 'Worn together', level: 2 }); const sec = lb.closest('section');
    expect(sec.querySelector('img').getAttribute('src')).toBe(cdn('front'));
  });
});

describe('admin edit → storefront (after a refresh)', () => {
  it('a new primary image, replaced picture and deletion are what customers see on the next load', async () => {
    // before
    store('/'); let sec = (await screen.findByRole('heading', { name: 'Worn together', level: 2 })).closest('section'); expect(sec.querySelector('img').getAttribute('src')).toBe(cdn('front')); cleanup();
    // admin: replace the primary photo (e.g. one with a baked-in watermark), make "Back" second, delete "Detail"
    admin(); await screen.findByRole('list', { name: 'Product images' });
    fireEvent.change(screen.getByLabelText('Replace image 1'), { target: { files: [new File(['x'], 'clean.png', { type: 'image/png' })] } }); await screen.findByText('Replaced · not saved');
    fireEvent.click(screen.getByLabelText('Move image 3 earlier'));
    fireEvent.click(screen.getByRole('button', { name: 'Delete image 3' })); const dlg = await screen.findByRole('dialog'); fireEvent.click(within(dlg).getByRole('button', { name: 'Delete image' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save images' })); await waitFor(() => expect(shop.all('PATCH', `/api/admin/products/${PID}`)).toHaveLength(1)); await waitFor(() => expect(screen.getByRole('button', { name: 'Save images' }).disabled).toBe(true));
    cleanup();
    // storefront, fresh load
    store('/'); sec = (await screen.findByRole('heading', { name: 'Worn together', level: 2 })).closest('section'); expect(sec.querySelector('img').getAttribute('src')).toBe(cdn('upload-1')); cleanup();
    store('/products/bias-slip-dress-women'); await screen.findByRole('heading', { name: 'Bias Slip Dress', level: 1 });
    expect(mainSrc()).toBe(cdn('upload-1')); expect(thumbs()).toEqual([cdn('upload-1')]); // detail (shared) deleted; back belongs to Oxblood
    fireEvent.click(screen.getByRole('button', { name: /Oxblood/ })); await waitFor(() => expect(thumbs()).toEqual([cdn('back')])); // the replaced photo kept its Ink colour
    expect(JSON.stringify(shop.publicDetail().images)).not.toContain('detail'); expect(JSON.stringify(shop.publicDetail().images)).not.toContain(cdn('front'));
  });
});
