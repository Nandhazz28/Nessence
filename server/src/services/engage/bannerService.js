import { z } from "zod";
import { SiteContent } from "../../models/SiteContent.js";
import { Category } from "../../models/Category.js";
import { Collection } from "../../models/Collection.js";
import { ApiError } from "../../utils/ApiError.js";
import { media as defaultMedia } from "../mediaService.js";
import { deliveryUrl, isAllowedImageUrl, presentBanner } from "../imageUrls.js";

// Site-wide banner slots. The key is the contract between this API and the storefront; add a line here and a render
// spot in the client to introduce a new one. Collection and category banners live on the documents themselves.
export const SITE_SLOTS = {
  homeHero: {
    label: "Home: hero",
    where: "Large image beside the headline at the top of the home page",
    hint: "Portrait or square, at least 1200 px wide",
  },
  homeMen: {
    label: "Home: Menswear tile",
    where: "Background of the Menswear tile on the home page",
    hint: "Landscape, at least 1200 px wide",
  },
  homeWomen: {
    label: "Home: Womenswear tile",
    where: "Background of the Womenswear tile on the home page",
    hint: "Landscape, at least 1200 px wide",
  },
  pageMen: {
    label: "Men page banner",
    where: "Top of the Men shop page",
    hint: "Wide, about 16:5, at least 1600 px wide",
  },
  pageWomen: {
    label: "Women page banner",
    where: "Top of the Women shop page",
    hint: "Wide, about 16:5, at least 1600 px wide",
  },
  pageNewArrivals: {
    label: "New arrivals page banner",
    where: "Top of the New arrivals page",
    hint: "Wide, about 16:5, at least 1600 px wide",
  },
  pageSale: {
    label: "Sale page banner",
    where: "Top of the Sale page",
    hint: "Wide, about 16:5, at least 1600 px wide",
  },
};
export const SLOT_KEYS = Object.keys(SITE_SLOTS);
export const SCOPES = ["site", "collection", "category"];

const KEY_PREFIX = "banner:";
const keyOf = (slot) => `${KEY_PREFIX}${slot}`;
const STORED = [
  "url",
  "alt",
  "active",
  "publicId",
  "width",
  "height",
  "bytes",
  "format",
];
const OID = /^[a-f0-9]{24}$/;

export const bannerBody = z
  .object({
    image: z
      .object({
        url: z
          .string()
          .max(600)
          .refine(isAllowedImageUrl, "Upload the image with the banner uploader"),
        alt: z.string().trim().min(3, "Describe the image (3+ characters)").max(140),
      })
      .strict(),
    active: z.boolean().default(true),
  })
  .strict();

export const bannerParams = z
  .object({ scope: z.enum(SCOPES), ref: z.string().max(60) })
  .superRefine((p, ctx) => {
    const good = p.scope === "site" ? SLOT_KEYS.includes(p.ref) : OID.test(p.ref);
    if (!good)
      ctx.addIssue({
        code: "custom",
        path: ["ref"],
        message: p.scope === "site" ? "Unknown banner slot" : "Invalid id",
      });
  });

// Admin view: `url` is the stored address (what a save must send back), `preview` is a resized delivery URL.
const adminView = (b) =>
  b?.url
    ? {
        url: b.url,
        preview: deliveryUrl(b, "banner"),
        alt: b.alt ?? "",
        active: b.active !== false,
        width: b.width ?? null,
        height: b.height ?? null,
      }
    : null;

const stored = (img, active) => ({
  ...Object.fromEntries(
    STORED.filter((k) => img[k] != null && k !== "active").map((k) => [k, img[k]]),
  ),
  active,
});

export function createBannerService({ media = defaultMedia } = {}) {
  // One adapter per scope so save/reset share a single code path.
  async function adapter(scope, ref) {
    if (scope === "site") {
      const key = keyOf(ref);
      return {
        read: async () => (await SiteContent.findOne({ key }).lean())?.data ?? null,
        write: (banner, staff) =>
          SiteContent.findOneAndUpdate(
            { key },
            { $set: { title: SITE_SLOTS[ref].label, data: banner, updatedBy: staff?._id } },
            { upsert: true, new: true, runValidators: true },
          ),
        clear: () => SiteContent.deleteOne({ key }),
        label: SITE_SLOTS[ref].label,
      };
    }
    const Model = scope === "collection" ? Collection : Category;
    const doc = await Model.findById(ref).select("name banner").lean();
    if (!doc)
      throw ApiError.notFound("NOT_FOUND", `${scope} not found`);
    return {
      read: async () => doc.banner?.url ? doc.banner : null,
      write: (banner) =>
        Model.updateOne({ _id: ref }, { $set: { banner } }, { runValidators: true }),
      clear: () => Model.updateOne({ _id: ref }, { $unset: { banner: 1 } }),
      label: doc.name,
    };
  }

  async function list() {
    const [slotDocs, collections, categories] = await Promise.all([
      SiteContent.find({ key: { $in: SLOT_KEYS.map(keyOf) } }).lean(),
      Collection.find().sort({ sortOrder: 1, name: 1 }).lean(),
      Category.find().sort({ sortOrder: 1, name: 1 }).lean(),
    ]);
    const bySlot = new Map(slotDocs.map((d) => [d.key.slice(KEY_PREFIX.length), d]));
    const entity = (e) => ({
      id: String(e._id),
      name: e.name,
      slug: e.slug,
      active: e.active,
      ...(e.featured !== undefined ? { featured: Boolean(e.featured) } : {}),
      banner: adminView(e.banner),
    });
    return {
      site: SLOT_KEYS.map((key) => ({
        key,
        ...SITE_SLOTS[key],
        banner: adminView(bySlot.get(key)?.data),
        updatedAt: bySlot.get(key)?.updatedAt ?? null,
      })),
      collections: collections.map(entity),
      categories: categories.map(entity),
    };
  }

  async function save(scope, ref, body, staff) {
    const t = await adapter(scope, ref);
    const before = await t.read();
    const [img] = await media.resolveImages([body.image], {
      existing: before ? [before] : [],
    });
    const next = stored({ ...img, alt: body.image.alt }, body.active);
    await t.write(next, staff);
    await media.markAttached([next]);
    // The previous image is released only after the new one is safely saved; an image that was not replaced is kept.
    if (before) await media.release(media.removedBetween([before], [next]));
    return { label: t.label, replaced: Boolean(before), banner: adminView(next) };
  }

  async function reset(scope, ref) {
    const t = await adapter(scope, ref);
    const before = await t.read();
    if (!before) return { label: t.label, hadBanner: false };
    await t.clear();
    await media.release([before]);
    return { label: t.label, hadBanner: true };
  }

  // Public payload: delivery URLs only. Inactive banners and inactive collections/categories are omitted so the
  // storefront falls back to its built-in layout.
  async function publicBanners() {
    const has = { "banner.url": { $exists: true } };
    const [slotDocs, collections, categories] = await Promise.all([
      SiteContent.find({ key: { $in: SLOT_KEYS.map(keyOf) } }).lean(),
      Collection.find({ active: true, ...has }).select("slug banner").lean(),
      Category.find({ active: true, ...has }).select("slug banner").lean(),
    ]);
    const bySlug = (rows) =>
      Object.fromEntries(
        rows
          .map((r) => [r.slug, presentBanner(r.banner)])
          .filter(([, v]) => v),
      );
    return {
      site: Object.fromEntries(
        slotDocs
          .map((d) => [d.key.slice(KEY_PREFIX.length), presentBanner(d.data)])
          .filter(([, v]) => v),
      ),
      collections: bySlug(collections),
      categories: bySlug(categories),
    };
  }

  return { list, save, reset, publicBanners };
}

export const banners = createBannerService();
