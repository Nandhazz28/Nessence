import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ProductForm } from '../src/admin/pages/Products.jsx';
import { ToastProvider } from '../src/admin/ui.jsx';
import { createShop, cdn, PID } from './helpers/fakeShop.js';

// The product editor against a stateful fake of the admin API: every assertion about "saved" is checked in the
// request the editor actually sent and in the state the fake server ended up with.

let shop; let blobN;
const SEED = [['front', 'Front view', 'Ink'], ['back', 'Back view', 'Oxblood']];
const PATCH = `/api/admin/products/${PID}`;
const file = (name = 'look.png', type = 'image/png', size = 2048) => { const f = new File([new Uint8Array(8)], name, { type }); Object.defineProperty(f, 'size', { value: size }); return f; };
const mount = (path = `/admin/products/${PID}/edit`) => render(
  <ToastProvider><MemoryRouter initialEntries={[path]}><Routes>
    <Route path="/admin/products/:id/edit" element={<ProductForm />} /><Route path="/admin/products/new" element={<ProductForm />} />
  </Routes></MemoryRouter></ToastProvider>);
const ready = async () => { await screen.findByRole('list', { name: 'Product images' }); };
const pick = (label, f) => fireEvent.change(screen.getByLabelText(label), { target: { files: [f] } });
const alts = () => screen.getAllByLabelText(/^Alt text for image/).map((i) => i.value);
const tiles = () => [...document.querySelectorAll('.a-tile')];
const saveBtn = () => screen.getByRole('button', { name: /Save images|Saving images/ });
const confirmDelete = async (n) => { fireEvent.click(screen.getByRole('button', { name: `Delete image ${n}` })); const dlg = await screen.findByRole('dialog', { name: 'Delete this image?' }); fireEvent.click(within(dlg).getByRole('button', { name: 'Delete image' })); await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull()); };

beforeEach(() => {
  blobN = 0; shop = createShop(); shop.seedImages(SEED); shop.install();
  URL.createObjectURL = vi.fn(() => `blob:preview-${++blobN}`); URL.revokeObjectURL = vi.fn();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('existing images', () => {
  it('lists the saved images in order with the primary badge, alt text and colour', async () => {
    mount(); await ready();
    expect(alts()).toEqual(['Front view', 'Back view']);
    expect(screen.getByLabelText('Colour for image 1').value).toBe('Ink'); expect(screen.getByLabelText('Colour for image 2').value).toBe('Oxblood');
    expect(within(tiles()[0]).getByText('Primary')).toBeTruthy(); expect(within(tiles()[1]).queryByText('Primary')).toBeNull();
    expect(tiles()[0].querySelector('img').getAttribute('src')).toContain('w_240'); // the admin shows small delivery thumbnails, not the full original
    expect(saveBtn().disabled).toBe(true); // nothing changed yet
  });
});

describe('upload + preview', () => {
  it('shows a preview and a loading state immediately, uploads through the existing endpoint, and only saves on "Save images"', async () => {
    shop.uploadDelay = 40;
    mount(); await ready();
    pick('Upload images', file('satin.png'));
    expect(tiles()).toHaveLength(3);
    expect(tiles()[2].querySelector('img').getAttribute('src')).toBe('blob:preview-1'); // instant local preview, before the network answers
    expect(within(tiles()[2]).getByText('Uploading…')).toBeTruthy(); expect(saveBtn().disabled).toBe(true);
    await within(tiles()[2]).findByText('New · not saved');
    const up = shop.all('POST', '/api/admin/uploads/product-image'); expect(up).toHaveLength(1); expect(up[0].body.get('file').name).toBe('satin.png');
    expect(shop.all('PATCH', PATCH)).toHaveLength(0); // previewing is not saving
    expect(shop.product.images).toHaveLength(2);
    expect(alts()[2]).toBe('Bias Slip Dress – view 3'); // sensible default alt text from the product name
    expect(saveBtn().disabled).toBe(false);
    fireEvent.click(saveBtn());
    await waitFor(() => expect(screen.queryByText('New · not saved')).toBeNull());
    const sent = shop.last('PATCH', PATCH).body; expect(Object.keys(sent)).toEqual(['images']); // an image save never touches other fields
    expect(sent.images).toEqual([{ url: cdn('front'), alt: 'Front view', color: 'Ink' }, { url: cdn('back'), alt: 'Back view', color: 'Oxblood' }, { url: cdn('upload-1'), alt: 'Bias Slip Dress – view 3' }]);
    expect(shop.product.images.map((i) => i.url)).toEqual([cdn('front'), cdn('back'), cdn('upload-1')]);
    expect(saveBtn().disabled).toBe(true);
  });
  it('uploads several files in one go and keeps them in selection order', async () => {
    mount(); await ready();
    fireEvent.change(screen.getByLabelText('Upload images'), { target: { files: [file('a.png'), file('b.webp', 'image/webp'), file('c.jpg', 'image/jpeg')] } });
    await waitFor(() => expect(screen.getAllByText('New · not saved')).toHaveLength(3));
    expect(shop.all('POST', '/api/admin/uploads/product-image').map((c) => c.body.get('file').name)).toEqual(['a.png', 'b.webp', 'c.jpg']);
    fireEvent.click(saveBtn()); await waitFor(() => expect(shop.product.images).toHaveLength(5));
    expect(shop.product.images.slice(2).map((i) => i.url)).toEqual([cdn('upload-1'), cdn('upload-2'), cdn('upload-3')]);
  });
  it('accepts files dropped onto the drop zone', async () => {
    mount(); await ready();
    fireEvent.drop(document.querySelector('.a-drop'), { dataTransfer: { files: [file('dropped.png')], types: ['Files'] } });
    await screen.findByText('New · not saved'); expect(shop.last('POST', '/api/admin/uploads/product-image').body.get('file').name).toBe('dropped.png');
  });
  it('rejects unsupported types and oversize files on the client, without calling the API', async () => {
    mount(); await ready();
    pick('Upload images', file('anim.gif', 'image/gif')); expect(await screen.findByText(/anim\.gif: only JPEG, PNG or WebP/)).toBeTruthy();
    pick('Upload images', file('huge.jpg', 'image/jpeg', 6 * 1024 * 1024)); expect(await screen.findByText(/huge\.jpg is 6 MB\. Images must be 5 MB or smaller/)).toBeTruthy();
    expect(shop.all('POST', '/api/admin/uploads/product-image')).toHaveLength(0); expect(tiles()).toHaveLength(2);
  });
  it('stops at 20 images', async () => {
    shop.seedImages(Array.from({ length: 20 }, (_, i) => [`s${i}`, `Shot ${i + 1}`, 'Ink'])); mount(); await ready();
    expect(screen.getByLabelText('Upload images').disabled).toBe(true); expect(screen.getByText('20 of 20 images')).toBeTruthy();
  });
  it('shows an upload failure on the tile, blocks saving, and lets you retry', async () => {
    shop.failUploads = 1; mount(); await ready();
    pick('Upload images', file('flaky.png'));
    expect(await within(tiles()[2]).findByText('Image storage is unavailable right now. Please try again.')).toBeTruthy();
    fireEvent.click(saveBtn()); expect(await screen.findByText('Retry or remove the images that failed to upload.')).toBeTruthy(); expect(shop.all('PATCH', PATCH)).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Retry upload' }));
    await within(tiles()[2]).findByText('New · not saved'); expect(shop.all('POST', '/api/admin/uploads/product-image')).toHaveLength(2);
    expect(alts()).toHaveLength(3);
  });
});

describe('validation', () => {
  it('will not save an image without alt text and points at the field', async () => {
    mount(); await ready();
    fireEvent.change(screen.getByLabelText('Alt text for image 2'), { target: { value: ' ' } });
    fireEvent.click(saveBtn());
    expect(await screen.findByText('Add a short description (alt text) to every image.')).toBeTruthy(); expect(within(tiles()[1]).getByText('Describe the image in at least 3 characters.')).toBeTruthy();
    expect(shop.all('PATCH', PATCH)).toHaveLength(0);
    fireEvent.change(screen.getByLabelText('Alt text for image 2'), { target: { value: 'Back view, from the side' } }); fireEvent.click(saveBtn());
    await waitFor(() => expect(shop.all('PATCH', PATCH)).toHaveLength(1)); expect(shop.last('PATCH', PATCH).body.images[1].alt).toBe('Back view, from the side');
  });
  it('will not let a published product end up with no images', async () => {
    mount(); await ready(); await confirmDelete(1); await confirmDelete(1);
    fireEvent.click(saveBtn()); expect(await screen.findByText('A published product needs at least one image.')).toBeTruthy(); expect(shop.all('PATCH', PATCH)).toHaveLength(0);
  });
  it('shows server-side field errors on the right tile (and keeps the user’s edits)', async () => {
    mount(); await ready();
    shop.failPatch = { status: 400, code: 'VALIDATION_ERROR', message: 'Please check the highlighted fields', details: [{ field: 'images.1.color', message: '"Chartreuse" is not one of this product\'s colours (Ink, Oxblood)' }] };
    fireEvent.change(screen.getByLabelText('Alt text for image 1'), { target: { value: 'Front, edited' } }); fireEvent.click(saveBtn());
    expect(await screen.findByText('Please fix the highlighted images.')).toBeTruthy(); expect(within(tiles()[1]).getByText(/Chartreuse/)).toBeTruthy(); expect(alts()[0]).toBe('Front, edited');
  });
});

describe('replace', () => {
  it('keeps position, alt text and colour, shows a badge, and saves the new picture in place', async () => {
    mount(); await ready();
    pick('Replace image 1', file('better.jpg', 'image/jpeg'));
    await within(tiles()[0]).findByText('Replaced · not saved');
    expect(alts()).toEqual(['Front view', 'Back view']); expect(screen.getByLabelText('Colour for image 1').value).toBe('Ink'); expect(within(tiles()[0]).getByText('Primary')).toBeTruthy();
    expect(tiles()[0].querySelector('img').getAttribute('src')).toBe('blob:preview-1'); expect(shop.all('PATCH', PATCH)).toHaveLength(0);
    fireEvent.click(saveBtn()); await waitFor(() => expect(shop.all('PATCH', PATCH)).toHaveLength(1));
    expect(shop.last('PATCH', PATCH).body.images).toEqual([{ url: cdn('upload-1'), alt: 'Front view', color: 'Ink' }, { url: cdn('back'), alt: 'Back view', color: 'Oxblood' }]); // the old url is simply absent: the server releases it
    await waitFor(() => expect(screen.queryByText('Replaced · not saved')).toBeNull());
  });
  it('can be undone, which discards the unsaved upload', async () => {
    mount(); await ready(); pick('Replace image 2', file('oops.png'));
    await within(tiles()[1]).findByText('Replaced · not saved'); fireEvent.click(screen.getByRole('button', { name: 'Undo replacing image 2' }));
    await waitFor(() => expect(screen.queryByText('Replaced · not saved')).toBeNull()); expect(tiles()[1].querySelector('img').getAttribute('src')).toContain('back');
    await waitFor(() => expect(shop.discarded).toEqual(['asset-1'])); expect(saveBtn().disabled).toBe(true);
  });
  it('shows a loading state while replacing and keeps the old image if the upload fails', async () => {
    shop.uploadDelay = 40; shop.failUploads = 1; mount(); await ready();
    pick('Replace image 1', file('x.png')); expect(within(tiles()[0]).getByText('Replacing…')).toBeTruthy(); expect(screen.getByLabelText('Replace image 1').disabled).toBe(true);
    expect(await within(tiles()[0]).findByText(/Could not replace the image: Image storage is unavailable/)).toBeTruthy();
    expect(tiles()[0].querySelector('img').getAttribute('src')).toContain('front'); expect(within(tiles()[0]).queryByText('Replaced · not saved')).toBeNull(); expect(saveBtn().disabled).toBe(true);
  });
  it('rejects an unsuitable replacement file locally', async () => {
    mount(); await ready(); pick('Replace image 1', file('doc.pdf', 'application/pdf'));
    expect(await within(tiles()[0]).findByText(/only JPEG, PNG or WebP/)).toBeTruthy(); expect(shop.all('POST', '/api/admin/uploads/product-image')).toHaveLength(0);
  });
});

describe('order and primary image', () => {
  it('moves images with the arrow buttons; the first one becomes the primary image', async () => {
    mount(); await ready();
    expect(screen.getByLabelText('Move image 1 earlier').disabled).toBe(true); expect(screen.getByLabelText('Move image 2 later').disabled).toBe(true);
    fireEvent.click(screen.getByLabelText('Move image 1 later'));
    expect(alts()).toEqual(['Back view', 'Front view']); expect(within(tiles()[0]).getByText('Primary')).toBeTruthy(); expect(screen.getByLabelText('Colour for image 1').value).toBe('Oxblood'); // colour travels with its image
    fireEvent.click(saveBtn()); await waitFor(() => expect(shop.all('PATCH', PATCH)).toHaveLength(1));
    expect(shop.last('PATCH', PATCH).body.images.map((i) => i.alt)).toEqual(['Back view', 'Front view']); expect(shop.product.images.map((i) => i.order)).toEqual([0, 1]);
    expect(shop.publicCard().images[0].alt).toBe('Back view');
  });
  it('"Make primary" moves any image to the front', async () => {
    shop.seedImages([['a', 'Image A', 'Ink'], ['b', 'Image B', 'Ink'], ['c', 'Image C', 'Oxblood']]); mount(); await ready();
    expect(screen.queryByLabelText('Make image 1 the primary image')).toBeNull();
    fireEvent.click(screen.getByLabelText('Make image 3 the primary image')); expect(alts()).toEqual(['Image C', 'Image A', 'Image B']);
    fireEvent.click(saveBtn()); await waitFor(() => expect(shop.product.images.map((i) => i.alt)).toEqual(['Image C', 'Image A', 'Image B']));
  });
  it('reorders by drag and drop', async () => {
    shop.seedImages([['a', 'Image A', 'Ink'], ['b', 'Image B', 'Ink'], ['c', 'Image C', 'Oxblood']]); mount(); await ready();
    const dt = { setData: vi.fn(), types: [], files: [] };
    fireEvent.dragStart(tiles()[2], { dataTransfer: dt }); fireEvent.dragOver(tiles()[0], { dataTransfer: dt }); fireEvent.drop(tiles()[0], { dataTransfer: dt });
    expect(alts()).toEqual(['Image C', 'Image A', 'Image B']);
  });
});

describe('delete', () => {
  it('asks for confirmation; cancelling keeps the image, confirming removes it and the save omits it', async () => {
    mount(); await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Delete image 1' })); let dlg = await screen.findByRole('dialog', { name: 'Delete this image?' });
    expect(within(dlg).getByText(/deleted from storage/)).toBeTruthy(); fireEvent.click(within(dlg).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull()); expect(alts()).toEqual(['Front view', 'Back view']);
    await confirmDelete(1);
    expect(alts()).toEqual(['Back view']); expect(within(tiles()[0]).getByText('Primary')).toBeTruthy(); // the next image is promoted
    expect(shop.product.images).toHaveLength(2); // nothing is destroyed until Save
    fireEvent.click(saveBtn()); await waitFor(() => expect(shop.product.images).toHaveLength(1));
    expect(shop.last('PATCH', PATCH).body.images).toEqual([{ url: cdn('back'), alt: 'Back view', color: 'Oxblood' }]);
  });
  it('removing an unsaved upload discards it from storage', async () => {
    mount(); await ready(); pick('Upload images', file('mistake.png')); await screen.findByText('New · not saved');
    await confirmDelete(3); expect(tiles()).toHaveLength(2); await waitFor(() => expect(shop.discarded).toEqual(['asset-1']));
    expect(saveBtn().disabled).toBe(true);
  });
  it('"Discard changes" (confirmed) puts everything back and discards pending uploads', async () => {
    mount(); await ready(); pick('Upload images', file('extra.png')); await screen.findByText('New · not saved');
    fireEvent.click(screen.getByLabelText('Move image 1 later')); await confirmDelete(1);
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' })); const dlg = await screen.findByRole('dialog', { name: 'Discard image changes?' });
    fireEvent.click(within(dlg).getByRole('button', { name: 'Discard changes' }));
    await waitFor(() => expect(alts()).toEqual(['Front view', 'Back view'])); await waitFor(() => expect(shop.discarded).toEqual(['asset-1']));
    expect(shop.all('PATCH', PATCH)).toHaveLength(0); expect(screen.queryByText(/unsaved changes/)).toBeNull();
  });
});

describe('colour / variant association', () => {
  it('offers the product’s colours, saves the chosen one, and leaves variants untouched', async () => {
    mount(); await ready();
    const sel = screen.getByLabelText('Colour for image 2'); expect([...sel.options].map((o) => o.textContent)).toEqual(['All colours', 'Ink', 'Oxblood']);
    fireEvent.change(sel, { target: { value: '' } }); fireEvent.change(screen.getByLabelText('Colour for image 1'), { target: { value: 'Oxblood' } });
    fireEvent.click(saveBtn()); await waitFor(() => expect(shop.all('PATCH', PATCH)).toHaveLength(1));
    expect(shop.last('PATCH', PATCH).body.images).toEqual([{ url: cdn('front'), alt: 'Front view', color: 'Oxblood' }, { url: cdn('back'), alt: 'Back view' }]);
    expect(shop.product.variants.map((v) => v.color.name)).toEqual(['Ink', 'Oxblood']); expect(shop.all('POST', `${PATCH}/variants`)).toHaveLength(0);
  });
  it('keeps a legacy colour that is no longer a product colour visible instead of silently dropping it', async () => {
    shop.seedImages([['a', 'Image A', 'Retired']]); mount(); await ready();
    expect(screen.getByLabelText('Colour for image 1').value).toBe('Retired'); expect(screen.getByRole('option', { name: 'Retired (not a product colour)' })).toBeTruthy();
  });
});

describe('save failures and persistence', () => {
  it('keeps the edits and shows the server message when the save fails; a retry then works', async () => {
    mount(); await ready(); fireEvent.click(screen.getByLabelText('Move image 1 later'));
    shop.failPatch = { status: 502, code: 'STORAGE_UNAVAILABLE', message: 'Image storage is unavailable right now. Please try again.' };
    fireEvent.click(saveBtn()); expect(await screen.findByText('Image storage is unavailable right now. Please try again.')).toBeTruthy();
    expect(alts()).toEqual(['Back view', 'Front view']); expect(saveBtn().disabled).toBe(false); expect(shop.product.images[0].alt).toBe('Front view');
    fireEvent.click(saveBtn()); await waitFor(() => expect(shop.product.images[0].alt).toBe('Back view')); await waitFor(() => expect(screen.queryByText(/Image storage is unavailable/)).toBeNull());
  });
  it('shows "Saving images…" and prevents double submits while the request is in flight', async () => {
    mount(); await ready(); fireEvent.click(screen.getByLabelText('Move image 1 later'));
    fireEvent.click(saveBtn()); expect(screen.getByRole('button', { name: 'Saving images…' }).disabled).toBe(true);
    await waitFor(() => expect(saveBtn().textContent).toBe('Save images')); expect(shop.all('PATCH', PATCH)).toHaveLength(1);
  });
  it('what was saved is what the editor shows after a reload', async () => {
    mount(); await ready(); pick('Upload images', file('new.png')); await screen.findByText('New · not saved');
    fireEvent.click(screen.getByLabelText('Move image 3 earlier')); fireEvent.click(screen.getByLabelText('Move image 2 earlier'));
    fireEvent.change(screen.getByLabelText('Alt text for image 1'), { target: { value: 'The new lead shot' } });
    fireEvent.click(saveBtn()); await waitFor(() => expect(shop.all('PATCH', PATCH)).toHaveLength(1)); await waitFor(() => expect(saveBtn().disabled).toBe(true));
    cleanup(); mount(); await ready(); // a fresh page load
    expect(alts()).toEqual(['The new lead shot', 'Front view', 'Back view']); expect(tiles()[0].querySelector('img').getAttribute('src')).toContain('upload-1'); expect(within(tiles()[0]).getByText('Primary')).toBeTruthy();
    expect(screen.queryByText('New · not saved')).toBeNull();
  });
  it('warns before the tab is closed while there are unsaved image changes', async () => {
    mount(); await ready(); const clean = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(clean); expect(clean.defaultPrevented).toBe(false);
    fireEvent.click(screen.getByLabelText('Move image 1 later')); const dirty = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(dirty); expect(dirty.defaultPrevented).toBe(true);
  });
});

describe('new product', () => {
  it('uploads before the product exists and sends the images (with a colour matching the new variants) in the create request', async () => {
    mount('/admin/products/new'); await screen.findByRole('heading', { name: 'New product' });
    expect(screen.getByText(/saved together with the product/)).toBeTruthy(); expect(screen.queryByRole('button', { name: 'Save images' })).toBeNull();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Satin Slip' } }); fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'A satin slip dress.' } });
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'c'.repeat(24) } }); fireEvent.change(screen.getByLabelText('Price (₹)'), { target: { value: '8900' } });
    fireEvent.change(screen.getByLabelText('Colour name'), { target: { value: 'Ink' } });
    pick('Upload images', file('hero.png')); await screen.findByText('New · not saved'); expect(alts()).toEqual(['Satin Slip – view 1']);
    await waitFor(() => expect([...screen.getByLabelText('Colour for image 1').options].map((o) => o.textContent)).toEqual(['All colours', 'Ink']));
    fireEvent.change(screen.getByLabelText('Colour for image 1'), { target: { value: 'Ink' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(shop.created).toBeTruthy());
    expect(shop.created.images).toEqual([{ url: cdn('upload-1'), alt: 'Satin Slip – view 1', color: 'Ink' }]); expect(shop.created.variants.colors[0].name).toBe('Ink');
  });
  it('blocks creating a published product with no image', async () => {
    mount('/admin/products/new'); await screen.findByRole('heading', { name: 'New product' });
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'published' } }); fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('A published product needs at least one image.')).toBeTruthy(); expect(shop.created).toBeUndefined();
  });
});
