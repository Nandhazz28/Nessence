import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import AdminApp from '../src/admin/AdminApp.jsx';

const ALL = ['dashboard:read', 'products:read', 'products:write', 'inventory:read', 'inventory:write', 'orders:read', 'orders:write', 'customers:read', 'customers:manage', 'coupons:write', 'reviews:moderate', 'content:write', 'newsletter:read', 'messages:read', 'staff:manage', 'settings:manage', 'audit:read'];
const pag = { page: 1, limit: 20, total: 1, pages: 1 };
const list = (rows, meta = {}) => ({ success: true, data: rows, meta: { pagination: pag, ...meta } });
const one = (data) => ({ success: true, data });
const now = new Date().toISOString();
const oid = (n) => String(n).padStart(24, 'a');
const trend = Array.from({ length: 14 }, (_, i) => ({ date: `2026-10-${String(i + 1).padStart(2, '0')}`, revenue: i * 100000, orders: i }));
const product = { _id: oid(1), id: oid(1), name: 'Bias Slip Dress', slug: 'bias-slip-dress-women', description: 'A bias-cut slip dress in matte satin.', gender: 'women', category: oid(2), collectionIds: [oid(3)], price: 940000, salePrice: null, materials: 'Silk blend', care: ['Cold wash'], details: ['Bias-cut'], tags: ['dress'], status: 'published', featured: true, newArrivalUntil: null, seo: { title: 'Bias Slip Dress', description: 'Soft matte satin dress.' }, images: [{ url: '/media/seed/x.svg', alt: 'Front', color: 'Ink' }], variants: [{ id: oid(4), sku: 'NS-BIAS-INK-M', color: { name: 'Ink' }, size: 'M', stock: 5, reserved: 1, active: true }] };
const order = { id: oid(5), orderNumber: 'NS-2610-ABC123', status: 'confirmed', paymentStatus: 'captured', total: 940000, itemCount: 1, customer: { id: oid(6), name: 'Ananya Raghavan', email: 'a@x.com' }, items: [{ _id: oid(7), name: 'Bias Slip Dress', color: 'Ink', size: 'M', sku: 'NS-BIAS-INK-M', qty: 1, unitPrice: 940000, lineTotal: 940000, image: { url: '/media/seed/x.svg' } }], shippingAddress: { fullName: 'Ananya Raghavan', line1: '1 Palm Lane', city: 'Chennai', state: 'TN', pincode: '600001', phone: '9876543210' }, delivery: { label: 'Standard delivery' }, totals: { subtotal: 940000, discount: 0, shipping: 29900, tax: 47000, total: 1016900 }, statusHistory: [{ status: 'confirmed', at: now }], payments: [{ method: 'card', amount: 1016900, status: 'captured' }] };
const ret = { id: oid(9), returnNumber: 'RT-AB12CD', status: 'requested', orderNumber: 'NS-2610-ABC123', orderId: oid(5), customer: { name: 'Ananya', email: 'a@x.com' }, estimatedRefund: 940000, createdAt: now };

const ROUTES = [
  ['/permissions', one({ role: 'super_admin', permissions: ALL, staff: { id: oid(20), name: 'Store Admin', email: 'admin@x.com', role: 'super_admin', mustChangePassword: false } })],
  ['/dashboard', one({ periodDays: 30, kpis: { revenue: { value: 1842300, change: 12.4 }, orders: { value: 31, change: null }, newCustomers: { value: 8, change: -2 }, averageOrderValue: { value: 5, change: null } }, recentOrders: [{ id: oid(5), orderNumber: 'NS-2610-ABC123', customer: 'Ananya Raghavan', total: 1016900, status: 'confirmed', createdAt: now }] })],
  ['/analytics', one({ summary: { revenue: 100000, orders: 2, averageOrderValue: 50000, discountsGiven: 0, refunded: 0, refundCount: 0 }, sales: trend.map((t) => ({ period: t.date, revenue: t.revenue, orders: t.orders })), categories: [{ category: 'Dresses', revenue: 75000 }], paymentMethods: [{ method: 'card', amount: 90000 }], customerAcquisition: [{ period: '2026-10-01', customers: 1 }], traffic: { message: 'Google Ads' } })],
  ['/products/' + oid(1), one(product)],
  ['/products', list([{ id: oid(1), name: 'Bias Slip Dress', slug: 'bias-slip-dress-women', status: 'published', gender: 'women', category: 'Dresses', price: 940000, salePrice: null, image: '/media/seed/x.svg', available: 4 }])],
  ['/categories', one([{ _id: oid(2), name: 'Dresses', slug: 'dresses', genders: ['women'], sortOrder: 0, active: true }])],
  ['/collections', one([{ _id: oid(3), name: 'Quiet Evening', slug: 'quiet-evening', genders: ['women'], sortOrder: 0, active: true, season: 'AW26' }])],
  ['/inventory', list([{ variantId: oid(4), sku: 'NS-BIAS-INK-M', product: 'Bias Slip Dress', productId: oid(1), color: 'Ink', size: 'M', stock: 5, reserved: 1, available: 4, lowStockThreshold: 5 }])],
  ['/orders/' + oid(5), one(order)], ['/orders', list([order])],
  ['/returns/' + oid(9), one(ret)], ['/returns', list([ret])],
  ['/refunds', list([{ id: oid(10), orderId: oid(5), orderNumber: 'NS-2610-ABC123', customer: { name: 'Ananya' }, amount: 940000, reason: 'customer_cancelled', status: 'pending', createdAt: now }])],
  ['/customers/' + oid(6), one({ id: oid(6), name: 'Ananya Raghavan', email: 'a@x.com', status: 'active', emailVerified: true, registeredAt: now, orders: 1, totalSpend: 940000, locations: ['Chennai'] })],
  ['/customers', list([{ id: oid(6), name: 'Ananya Raghavan', email: 'a@x.com', status: 'active', emailVerified: true, registeredAt: now, orders: 1, totalSpend: 940000, lastOrder: now }])],
  ['/coupons', one([{ _id: oid(11), code: 'NESSENCE10', type: 'percent', value: 10, minOrder: 200000, maxDiscount: 300000, usedCount: 2, active: true }])],
  ['/review-reports', list([{ id: oid(12), reason: 'spam', status: 'open', reporter: 'Priya', review: { id: oid(13), rating: 2, body: 'Buy cheap watches here', status: 'approved', product: 'Bias Slip Dress' } }])],
  ['/reviews', list([{ id: oid(13), rating: 4, title: 'Lovely', body: 'Beautiful drape and weight.', status: 'pending', reportCount: 0, createdAt: now, product: { id: oid(1), name: 'Bias Slip Dress' } }])],
  ['/newsletter', list([{ id: oid(14), email: 'sub@x.com', status: 'subscribed', source: 'footer', subscribedAt: now }], { counts: { subscribed: 1, pending: 2 } })],
  ['/contact-messages/' + oid(15), one({ id: oid(15), name: 'Asha', email: 'asha@x.com', subject: 'Sizing question', message: 'Does it run small?', category: 'product', status: 'new', createdAt: now })],
  ['/contact-messages', list([{ id: oid(15), name: 'Asha', email: 'asha@x.com', category: 'product', subject: 'Sizing question', status: 'new', replies: 0, createdAt: now }], { newCount: 1 })],
  ['/journal/' + oid(16), one({ id: oid(16), title: 'On wool', slug: 'on-wool', excerpt: 'Weight matters a great deal.', author: 'Studio', tags: ['materials'], status: 'published', content: 'Body text' })],
  ['/journal', list([{ id: oid(16), title: 'On wool', slug: 'on-wool', author: 'Studio', status: 'published', publishedAt: now, updatedAt: now }])],
  ['/content', one([{ key: 'about', title: 'About Nessence', body: 'Hello', updatedAt: now }, { key: 'faq', title: 'FAQ', body: '', data: { items: [{ q: 'How long?', a: 'Four days.' }] }, updatedAt: now }, { key: 'cookie-policy', title: 'Cookie policy', body: 'We store cookies', updatedAt: now }])],
  ['/banners', one({ site: [{ key: 'home', label: 'Home', where: 'Top of the home page', banner: null }], collections: [], categories: [] })],
  ['/settings', one({ storeName: 'Nessence', supportEmail: '', supportPhone: '', social: {} })],
  ['/staff', one([{ id: oid(20), name: 'Store Admin', email: 'admin@x.com', role: 'super_admin', active: true, mustChangePassword: false, lastLoginAt: now }, { id: oid(21), name: 'Sam Support', email: 'sam@x.com', role: 'support', active: true, mustChangePassword: false, lastLoginAt: now }])],
  ['/audit-logs', list([{ id: oid(17), actor: 'admin@x.com', action: 'order.status_changed', resource: 'Order', resourceId: oid(5), metadata: { from: 'confirmed', to: 'processing' }, ip: '::1', at: now }])],
];
const respond = (url) => { const path = new URL(url, 'http://x').pathname.replace('/api/admin', ''); const hit = ROUTES.find(([p]) => path === p); return hit ? hit[1] : { success: false, code: 'NOT_FOUND', message: 'Missing mock route' }; };

let errors;
beforeEach(() => {
  errors = []; vi.spyOn(console, 'error').mockImplementation((...a) => errors.push(a.map(String).join(' ')));
  globalThis.fetch = vi.fn(async (url) => { const body = respond(String(url)); return new Response(JSON.stringify(body), { status: body.success ? 200 : 404, headers: { 'content-type': 'application/json' } }); });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const mount = (path) => render(<MemoryRouter initialEntries={[path]}><Routes><Route path="/admin/*" element={<AdminApp />} /></Routes></MemoryRouter>);
const realErrors = () => errors.filter((e) => !/not wrapped in act|ReactDOMTestUtils/.test(e));

const PAGES = [
  ['/admin', 'Recent orders'], ['/admin/analytics', 'Sales by category'], ['/admin/products', 'Search name or slug', 'placeholder'], ['/admin/products/new', 'Pricing'], ['/admin/products/' + oid(1) + '/edit', 'Variants & stock'], ['/admin/categories', 'Dresses'], ['/admin/collections', 'Quiet Evening'], ['/admin/inventory', 'NS-BIAS-INK-M'], ['/admin/orders', 'Ananya Raghavan'], ['/admin/orders/' + oid(5), 'Payments & refunds'], ['/admin/returns', 'RT-AB12CD'], ['/admin/refunds', 'Money owed to customers', 'sub'], ['/admin/customers', 'a@x.com'], ['/admin/customers/' + oid(6), 'Recent orders'], ['/admin/coupons', 'NESSENCE10'], ['/admin/reviews', 'Beautiful drape and weight.'], ['/admin/newsletter', 'Export subscribers (CSV)'], ['/admin/contact-messages', 'Sizing question'], ['/admin/journal', 'On wool'], ['/admin/journal/' + oid(16), 'Publishing'], ['/admin/banners', 'Site banners'], ['/admin/content', 'Cookie policy'], ['/admin/settings', 'Social links'], ['/admin/staff', 'Sam Support'], ['/admin/audit-logs', 'order.status_changed'],
];

describe('admin screens render against the API contract', () => {
  it.each(PAGES)('%s', async (path, text, mode) => {
    mount(path);
    if (mode === 'placeholder') await screen.findByPlaceholderText(text); else await screen.findAllByText(new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), {}, { timeout: 8000 });
    expect(realErrors()).toEqual([]);
  });

  it('Banners route resolves the default-exported admin page without crashing', async () => {
    mount('/admin/banners');
    await screen.findByText('Site banners');
    expect(realErrors()).toEqual([]);
  });
});
