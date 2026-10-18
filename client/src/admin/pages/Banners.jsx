import { useRef, useState } from "react";
import { useAsync } from "../../hooks/useAsync.js";
import { api } from "../api.js";
import {
  Badge,
  Btn,
  Card,
  Confirm,
  ErrorBox,
  Field,
  Loading,
  Note,
  PageHead,
  useToast,
} from "../ui.jsx";

const TYPES = ["image/jpeg", "image/png", "image/webp"];

// One banner: current image (or "default"), staged upload, alt text, show/hide, Save / Discard / Reset.
// `target` is the API path suffix: site/<slot>, collection/<id> or category/<id>.
function BannerCard({ title, where, hint, badge, banner, target, onChanged }) {
  const toast = useToast();
  const file = useRef(null);
  const [staged, setStaged] = useState(null); // uploaded, not yet saved: { url, assetId }
  const [alt, setAlt] = useState(banner?.alt ?? "");
  const [active, setActive] = useState(banner?.active ?? true);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");

  const shownUrl = staged?.url ?? banner?.preview ?? null;
  const imageUrl = staged?.url ?? banner?.url ?? null;
  const dirty =
    Boolean(staged) ||
    alt !== (banner?.alt ?? "") ||
    active !== (banner?.active ?? true);

  const discardStaged = async () => {
    if (!staged) return;
    const { assetId } = staged;
    setStaged(null);
    try {
      await api(`/uploads/${assetId}`, { method: "DELETE" });
    } catch {
      /* an unsaved upload is also swept by the server's reconciler */
    }
  };

  const pick = async (e) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    setErr("");
    if (!TYPES.includes(f.type)) {
      setErr("Choose a JPEG, PNG or WebP image.");
      return;
    }
    setBusy("upload");
    try {
      const form = new FormData();
      form.append("file", f);
      const r = await api("/uploads/product-image?purpose=banner", {
        method: "POST",
        form,
      });
      await discardStaged();
      setStaged({ url: r.data.url, assetId: r.data.assetId });
      if (!alt.trim()) setAlt(`${title} banner`);
    } catch (x) {
      setErr(x.message);
    } finally {
      setBusy("");
    }
  };

  const save = async () => {
    setErr("");
    if (!imageUrl) return setErr("Upload an image first.");
    if (alt.trim().length < 3)
      return setErr("Describe the image (at least 3 characters).");
    setBusy("save");
    try {
      await api(`/banners/${target}`, {
        method: "PUT",
        body: { image: { url: imageUrl, alt: alt.trim() }, active },
      });
      setStaged(null);
      toast("Banner saved");
      await onChanged();
    } catch (x) {
      setErr(x.message);
    } finally {
      setBusy("");
    }
  };

  const reset = async () => {
    await api(`/banners/${target}`, { method: "DELETE" });
    await discardStaged();
    toast("Banner reset to the default");
    await onChanged();
  };

  return (
    <Card title={title} actions={badge}>
      <p style={{ fontSize: 12, color: "var(--a-muted)", marginTop: 0 }}>
        {where}
        {hint ? ` · ${hint}` : ""}
      </p>
      <div
        data-testid="banner-preview"
        style={{
          aspectRatio: "16 / 6",
          background: "var(--a-bg, #f4f4f2)",
          border: "1px solid var(--a-line, #ddd)",
          display: "grid",
          placeItems: "center",
          overflow: "hidden",
          marginBottom: 12,
        }}
      >
        {shownUrl ? (
          <img
            src={shownUrl}
            alt=""
            style={{ width: "100%", height: "100%", objectFit: "cover" }}
          />
        ) : (
          <span style={{ fontSize: 12, color: "var(--a-muted)" }}>
            Using the default NESSENCE image
          </span>
        )}
      </div>
      {staged && (
        <Note tone="warn">
          New image uploaded. It is not live until you save.
        </Note>
      )}
      {banner && !banner.active && !staged && (
        <Note>This banner is saved but hidden; the storefront shows the default.</Note>
      )}
      {err && <Note tone="bad">{err}</Note>}
      <Field
        label="Alt text"
        value={alt}
        maxLength={140}
        onChange={(e) => setAlt(e.target.value)}
        hint="Describes the image for screen readers."
      />
      <label style={{ display: "flex", gap: 8, fontSize: 13, margin: "8px 0" }}>
        <input
          type="checkbox"
          checked={active}
          onChange={(e) => setActive(e.target.checked)}
        />
        Show this banner on the storefront
      </label>
      <input
        ref={file}
        type="file"
        accept={TYPES.join(",")}
        onChange={pick}
        hidden
        aria-label={`${title} image file`}
      />
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Btn
          size="sm"
          disabled={Boolean(busy)}
          onClick={() => file.current?.click()}
        >
          {busy === "upload" ? "Uploading…" : banner || staged ? "Replace image" : "Upload image"}
        </Btn>
        <Btn
          kind="primary"
          size="sm"
          disabled={Boolean(busy) || !dirty}
          onClick={save}
        >
          {busy === "save" ? "Saving…" : "Save"}
        </Btn>
        {staged && (
          <Btn size="sm" disabled={Boolean(busy)} onClick={discardStaged}>
            Discard upload
          </Btn>
        )}
        {banner && (
          <Confirm
            trigger="Reset to default"
            title="Reset banner?"
            message="This removes the custom image. The storefront goes back to its default."
            confirmLabel="Reset"
            danger
            onConfirm={reset}
          />
        )}
      </div>
    </Card>
  );
}

const Grid = ({ children }) => (
  <div className="a-grid a-g2" style={{ marginBottom: 24 }}>
    {children}
  </div>
);

export default function Banners() {
  const { data, error, loading, reload } = useAsync(
    (s) => api("/banners", { signal: s }).then((r) => r.data),
    [],
  );
  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  const entity = (kind) => (e) => (
    <BannerCard
      key={`${kind}:${e.id}:${e.banner?.url ?? ""}:${e.banner?.alt ?? ""}:${e.banner?.active}`}
      title={e.name}
      where={
        kind === "collection"
          ? `Collection page and collections list${e.featured ? " · featured on the home page" : ""}`
          : "Top of the shop page when this category is selected"
      }
      badge={e.active ? null : <Badge value="inactive" />}
      banner={e.banner}
      target={`${kind}/${e.id}`}
      onChanged={reload}
    />
  );
  return (
    <>
      <PageHead
        title="Banners"
        sub="Upload, replace or reset the images shown on the storefront. Without a custom image each spot keeps its default."
      />
      <h2 style={{ fontSize: 15 }}>Site banners</h2>
      <Grid>
        {data.site.map((s) => (
          <BannerCard
            key={`${s.key}:${s.banner?.url ?? ""}:${s.banner?.alt ?? ""}:${s.banner?.active}`}
            title={s.label}
            where={s.where}
            hint={s.hint}
            banner={s.banner}
            target={`site/${s.key}`}
            onChanged={reload}
          />
        ))}
      </Grid>
      <h2 style={{ fontSize: 15 }}>Collections</h2>
      {data.collections.length ? (
        <Grid>{data.collections.map(entity("collection"))}</Grid>
      ) : (
        <p className="a-empty">No collections yet.</p>
      )}
      <h2 style={{ fontSize: 15 }}>Categories</h2>
      {data.categories.length ? (
        <Grid>{data.categories.map(entity("category"))}</Grid>
      ) : (
        <p className="a-empty">No categories yet.</p>
      )}
    </>
  );
}
