import { useEffect, useRef, useState } from "react";
import { api } from "./api.js";
import { Btn, Confirm, Modal, Note } from "./ui.jsx";

// Admin gallery for one product. It reuses the existing upload endpoint (POST /api/admin/uploads/product-image) and the
// existing product PATCH; nothing here talks to a storage provider. The list is a controlled value owned by the product
// form so the form's own Save and this card's "Save images" share one source of truth.
//
// An item is { key, id?, url, thumb?, alt, color, status, previewUrl?, assetId?, original?, file?, error?, replacing? }
//   status "saved"     – exactly what the server has
//   status "uploading" – bytes on their way (previewUrl is a local blob so the picture shows immediately)
//   status "ready"     – uploaded to storage, attached to nothing until the product is saved (new image or a replacement)
//   status "error"     – the upload failed; `file` is kept so it can be retried

export const ACCEPTED_TYPES = ["image/jpeg", "image/png", "image/webp"];
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGES = 20;
const mb = (n) => `${Math.round((n / 1024 / 1024) * 10) / 10} MB`;
let seq = 0;
const newKey = () => `new-${Date.now().toString(36)}-${++seq}`;

export function fromServer(list = []) {
  return [...list]
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map((i, n) => ({
      key: i.id ?? i._id ?? `saved-${n}-${i.url}`,
      id: i.id ?? i._id,
      url: i.url,
      thumb: i.thumb ?? i.url,
      alt: i.alt ?? "",
      color: i.color ?? "",
      status: "saved",
    }));
}
export const isSendable = (i) =>
  (i.status === "saved" || i.status === "ready") && Boolean(i.url);
export const serialize = (items) =>
  items
    .filter(isSendable)
    .map(({ url, alt, color }) => ({
      url,
      alt: (alt ?? "").trim(),
      ...(color ? { color } : {}),
    }));
export const imagesDirty = (items, baseline) =>
  items.some((i) => !isSendable(i)) ||
  JSON.stringify(serialize(items)) !== JSON.stringify(serialize(baseline));

export function fileProblem(file) {
  if (!ACCEPTED_TYPES.includes(file.type))
    return `${file.name}: only JPEG, PNG or WebP images are accepted.`;
  if (file.size > MAX_IMAGE_BYTES)
    return `${file.name} is ${mb(file.size)}. Images must be ${mb(MAX_IMAGE_BYTES)} or smaller.`;
  if (file.size === 0) return `${file.name} is empty.`;
  return null;
}

// Returns { ok, summary, errors: { [item.key]: message } }; nothing is sent to the server unless ok.
export function validateImages(items, { published = false } = {}) {
  const errors = {};
  let summary = "";
  if (items.some((i) => i.status === "uploading" || i.replacing))
    summary = "Wait for the uploads to finish.";
  else if (items.some((i) => i.status === "error"))
    summary = "Retry or remove the images that failed to upload.";
  for (const i of items) {
    if (!isSendable(i)) continue;
    const alt = (i.alt ?? "").trim();
    if (alt.length < 3)
      errors[i.key] = "Describe the image in at least 3 characters.";
    else if (alt.length > 140)
      errors[i.key] = "Keep the description under 140 characters.";
  }
  if (!summary && Object.keys(errors).length)
    summary = "Add a short description (alt text) to every image.";
  if (!summary && items.length > MAX_IMAGES)
    summary = `A product can have at most ${MAX_IMAGES} images.`;
  if (!summary && published && items.filter(isSendable).length === 0)
    summary = "A published product needs at least one image.";
  return { ok: !summary, summary, errors };
}

export function ProductImages({
  images,
  setImages,
  baseline = [],
  colors = [],
  productName = "",
  mode = "edit",
  errors = {},
  summary = "",
  saving = false,
  onSave,
}) {
  const [preview, setPreview] = useState(null);
  const [dragKey, setDragKey] = useState(null);
  const [live, setLive] = useState("");
  const [notice, setNotice] = useState("");
  const [over, setOver] = useState(false);
  const blobs = useRef(new Set());
  useEffect(
    () => () => blobs.current.forEach((u) => URL.revokeObjectURL?.(u)),
    [],
  );

  const patch = (key, change) =>
    setImages((list) =>
      list.map((i) => (i.key === key ? { ...i, ...change } : i)),
    );
  const blob = (file) => {
    try {
      const u = URL.createObjectURL(file);
      blobs.current.add(u);
      return u;
    } catch {
      return undefined;
    }
  };
  const discardPending = (item) => {
    if (item.status === "ready" && item.assetId)
      api(`/uploads/${item.assetId}`, { method: "DELETE" }).catch(() => {}); // best effort; the nightly reconciler removes strays
  };
  const uploadFile = async (file) => {
    const form = new FormData();
    form.append("file", file);
    return (await api("/uploads/product-image", { method: "POST", form })).data;
  };
  const run = async (key, file) => {
    try {
      const d = await uploadFile(file);
      patch(key, {
        status: "ready",
        url: d.url,
        assetId: d.assetId ?? undefined,
        error: undefined,
      });
    } catch (e) {
      patch(key, { status: "error", error: e.message });
    }
  };

  const addFiles = async (fileList) => {
    const files = [...fileList];
    if (!files.length) return;
    const problems = [];
    const accepted = [];
    const room = MAX_IMAGES - images.length;
    for (const f of files) {
      const bad = fileProblem(f);
      if (bad) problems.push(bad);
      else if (accepted.length < room) accepted.push(f);
      else
        problems.push(
          `${f.name}: the gallery is full (at most ${MAX_IMAGES} images).`,
        );
    }
    setNotice(problems.join(" "));
    if (!accepted.length) return;
    const name = productName.trim();
    const stubs = accepted.map((file, n) => ({
      key: newKey(),
      url: "",
      alt: name ? `${name} – view ${images.length + n + 1}` : "",
      color: "",
      status: "uploading",
      previewUrl: blob(file),
      file,
    }));
    setImages((list) => [...list, ...stubs]);
    for (const s of stubs) await run(s.key, s.file);
  };
  const retry = (item) => {
    patch(item.key, { status: "uploading", error: undefined });
    run(item.key, item.file);
  };
  const replace = async (item, file) => {
    const bad = fileProblem(file);
    if (bad) return patch(item.key, { error: bad });
    const preview = blob(file);
    patch(item.key, { replacing: true, error: undefined });
    try {
      const d = await uploadFile(file);
      if (item.status === "ready") discardPending(item); // an unsaved upload that is replaced again
      patch(item.key, {
        replacing: false,
        status: "ready",
        url: d.url,
        thumb: undefined,
        previewUrl: preview,
        assetId: d.assetId ?? undefined,
        original:
          item.original ??
          (item.status === "saved"
            ? { url: item.url, thumb: item.thumb, id: item.id }
            : undefined),
      });
    } catch (e) {
      patch(item.key, {
        replacing: false,
        error: `Could not replace the image: ${e.message}`,
      });
    }
  };
  const undoReplace = (item) => {
    discardPending(item);
    patch(item.key, {
      status: "saved",
      url: item.original.url,
      thumb: item.original.thumb,
      id: item.original.id,
      previewUrl: undefined,
      assetId: undefined,
      original: undefined,
      error: undefined,
    });
  };
  const remove = (item) => {
    discardPending(item);
    setImages((list) => list.filter((i) => i.key !== item.key));
    setLive(`Image removed. ${images.length - 1} remaining.`);
  };
  const moveTo = (key, to) => {
    const from = images.findIndex((i) => i.key === key);
    if (from < 0 || to < 0 || to >= images.length || from === to) return;
    setImages((list) => {
      const a = [...list];
      const [it] = a.splice(
        a.findIndex((i) => i.key === key),
        1,
      );
      a.splice(to, 0, it);
      return a;
    });
    setLive(
      to === 0
        ? "Image is now the primary image."
        : `Image moved to position ${to + 1} of ${images.length}.`,
    );
  };
  const discardAll = async () => {
    const keep = new Set(baseline.map((b) => b.url));
    images
      .filter((i) => i.status === "ready" && !keep.has(i.url))
      .forEach(discardPending);
    setImages(baseline);
    setNotice("");
  };

  const dirty = imagesDirty(images, baseline);
  const busy = images.some((i) => i.status === "uploading" || i.replacing);
  const colorOptions = [...colors];
  const full = images.length >= MAX_IMAGES;

  const onZoneDrop = (e) => {
    e.preventDefault();
    setOver(false);
    if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
  };

  return (
    <div>
      <div
        className={`a-drop ${over ? "over" : ""}`}
        onDragOver={(e) => {
          if (e.dataTransfer?.types?.includes?.("Files")) {
            e.preventDefault();
            setOver(true);
          }
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onZoneDrop}
      >
        <div>
          <b>Drag images here</b> or choose files. JPEG, PNG or WebP, up to{" "}
          {mb(MAX_IMAGE_BYTES)} each, {MAX_IMAGES} images at most. The first
          image is the primary one shown on product cards.
        </div>
        <label
          className={`a-btn sm ${full ? "disabled" : ""}`}
          style={{ cursor: full ? "not-allowed" : "pointer" }}
        >
          Upload images
          <input
            type="file"
            aria-label="Upload images"
            accept={ACCEPTED_TYPES.join(",")}
            multiple
            hidden
            disabled={full}
            onChange={(e) => {
              addFiles(e.target.files);
              e.target.value = "";
            }}
          />
        </label>
      </div>

      <Note tone="bad">{notice}</Note>
      <Note tone="bad">{summary}</Note>

      {images.length === 0 ? (
        <div className="a-empty">
          No images yet. Upload at least one before publishing.
        </div>
      ) : (
        <ol className="a-gallery" aria-label="Product images">
          {images.map((im, i) => {
            const n = i + 1;
            const working = im.status === "uploading" || im.replacing;
            const err = errors[im.key];
            const isNew = im.status === "ready" && !im.original;
            return (
              <li
                key={im.key}
                className={`a-tile ${dragKey === im.key ? "dragging" : ""} ${im.status === "error" ? "failed" : ""}`}
                draggable={!working}
                onDragStart={(e) => {
                  setDragKey(im.key);
                  e.dataTransfer?.setData?.("text/plain", im.key);
                }}
                onDragEnd={() => setDragKey(null)}
                onDragOver={(e) => dragKey && e.preventDefault()}
                onDrop={(e) => {
                  if (!dragKey) return;
                  e.preventDefault();
                  e.stopPropagation();
                  moveTo(dragKey, i);
                  setDragKey(null);
                }}
              >
                <div className="a-tile-media">
                  <button
                    type="button"
                    className="a-tile-img"
                    aria-label={`Preview image ${n}`}
                    onClick={() => setPreview(im)}
                  >
                    {(im.previewUrl || im.thumb || im.url) && (
                      <img
                        src={im.previewUrl ?? im.thumb ?? im.url}
                        alt=""
                        draggable={false}
                      />
                    )}
                  </button>
                  {working && (
                    <div className="a-tile-busy" role="status">
                      <span className="a-spin" aria-hidden="true" />
                      {im.replacing ? "Replacing…" : "Uploading…"}
                    </div>
                  )}
                  <div className="a-tile-badges">
                    {i === 0 && <span className="a-badge ok">Primary</span>}
                    {isNew && (
                      <span className="a-badge warn">New · not saved</span>
                    )}
                    {im.original && (
                      <span className="a-badge info">Replaced · not saved</span>
                    )}
                  </div>
                </div>

                {im.error && (
                  <div role="alert" className="a-err">
                    {im.error}
                  </div>
                )}

                {im.status !== "error" && (
                  <>
                    <input
                      className="a-input"
                      aria-label={`Alt text for image ${n}`}
                      aria-invalid={Boolean(err)}
                      placeholder="Describe the image"
                      maxLength={140}
                      value={im.alt}
                      onChange={(e) => patch(im.key, { alt: e.target.value })}
                    />
                    {err && (
                      <div role="alert" className="a-err">
                        {err}
                      </div>
                    )}
                    <select
                      className="a-select"
                      aria-label={`Colour for image ${n}`}
                      value={im.color}
                      onChange={(e) => patch(im.key, { color: e.target.value })}
                    >
                      <option value="">All colours</option>
                      {colorOptions.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                      {im.color && !colorOptions.includes(im.color) && (
                        <option value={im.color}>
                          {im.color} (not a product colour)
                        </option>
                      )}
                    </select>
                  </>
                )}

                <div className="a-actions a-tile-actions">
                  {im.status === "error" ? (
                    <>
                      <Btn size="sm" onClick={() => retry(im)}>
                        Retry upload
                      </Btn>
                      <Btn
                        size="sm"
                        kind="danger"
                        aria-label={`Remove failed image ${n}`}
                        onClick={() => remove(im)}
                      >
                        Remove
                      </Btn>
                    </>
                  ) : (
                    <>
                      <Btn
                        size="sm"
                        disabled={working || i === 0}
                        aria-label={`Move image ${n} earlier`}
                        onClick={() => moveTo(im.key, i - 1)}
                      >
                        ←
                      </Btn>
                      <Btn
                        size="sm"
                        disabled={working || i === images.length - 1}
                        aria-label={`Move image ${n} later`}
                        onClick={() => moveTo(im.key, i + 1)}
                      >
                        →
                      </Btn>
                      {i > 0 && (
                        <Btn
                          size="sm"
                          disabled={working}
                          aria-label={`Make image ${n} the primary image`}
                          onClick={() => moveTo(im.key, 0)}
                        >
                          Make primary
                        </Btn>
                      )}
                      <label
                        className={`a-btn sm ${working ? "disabled" : ""}`}
                        style={{ cursor: working ? "not-allowed" : "pointer" }}
                      >
                        Replace
                        <input
                          type="file"
                          hidden
                          aria-label={`Replace image ${n}`}
                          accept={ACCEPTED_TYPES.join(",")}
                          disabled={working}
                          onChange={(e) => {
                            const f = e.target.files?.[0];
                            e.target.value = "";
                            if (f) replace(im, f);
                          }}
                        />
                      </label>
                      {im.original && (
                        <Btn
                          size="sm"
                          disabled={working}
                          aria-label={`Undo replacing image ${n}`}
                          onClick={() => undoReplace(im)}
                        >
                          Undo replace
                        </Btn>
                      )}
                      <Confirm
                        danger
                        disabled={working}
                        trigger="Delete"
                        triggerLabel={`Delete image ${n}`}
                        title="Delete this image?"
                        message={
                          im.status === "saved" || im.original
                            ? "The image is removed from this product and, once you save, deleted from storage. Customers will stop seeing it."
                            : "This upload has not been saved yet. It will be discarded."
                        }
                        confirmLabel="Delete image"
                        onConfirm={() => remove(im)}
                      />
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}

      <div className="a-gallery-foot">
        <span className="a-muted" role="status">
          {images.length} of {MAX_IMAGES} images
          {dirty && !busy ? " · unsaved changes" : ""}
          {busy ? " · uploading…" : ""}
        </span>
        <div className="a-actions">
          {dirty && (
            <Confirm
              trigger="Discard changes"
              title="Discard image changes?"
              message="New uploads are discarded and removed, replaced and deleted images come back, and the order returns to the saved one."
              confirmLabel="Discard changes"
              danger
              onConfirm={discardAll}
            />
          )}
          {mode === "edit" && onSave && (
            <Btn
              kind="primary"
              size="sm"
              disabled={!dirty || busy || saving}
              onClick={onSave}
            >
              {saving ? "Saving images…" : "Save images"}
            </Btn>
          )}
        </div>
      </div>
      {mode === "create" && (
        <p className="a-muted" style={{ fontSize: 12 }}>
          Images are saved together with the product when you click Save.
        </p>
      )}
      <div className="a-sr" aria-live="polite">
        {live}
      </div>

      {preview && (
        <Modal title="Image preview" onClose={() => setPreview(null)}>
          <img
            src={preview.previewUrl ?? preview.url ?? preview.thumb}
            alt={preview.alt || "Product image preview"}
            style={{ width: "100%", borderRadius: 6 }}
          />
          <p className="a-muted" style={{ fontSize: 12 }}>
            {preview.status === "ready"
              ? "Uploaded but not saved yet."
              : "Saved image."}
          </p>
        </Modal>
      )}
    </div>
  );
}
