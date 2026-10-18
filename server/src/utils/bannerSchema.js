import mongoose from "mongoose";

// One banner image + its display settings. Embedded in Category / Collection; the same field set is stored in
// SiteContent.data for site-wide slots (see services/engage/bannerService.js; lives outside models/ because it is not a model).
export const bannerSchema = new mongoose.Schema(
  {
    url: { type: String, required: true },
    alt: { type: String, required: true, trim: true, maxlength: 140 },
    active: { type: Boolean, default: true },
    publicId: String,
    width: Number,
    height: Number,
    bytes: Number,
    format: String,
  },
  { _id: false },
);
