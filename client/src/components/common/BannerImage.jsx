// One admin-managed banner image. `banner` is the public shape from /api/banners: { url, srcSet?, alt, width?, height? }.
export function BannerImage({
  banner,
  className = "",
  sizes = "100vw",
  priority = false,
  ...rest
}) {
  if (!banner?.url) return null;
  return (
    <img
      src={banner.url}
      {...(banner.srcSet ? { srcSet: banner.srcSet, sizes } : {})}
      alt={banner.alt ?? ""}
      {...(banner.width && banner.height
        ? { width: banner.width, height: banner.height }
        : {})}
      {...(priority ? { fetchpriority: "high" } : { loading: "lazy" })}
      className={className}
      {...rest}
    />
  );
}
