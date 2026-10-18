import { useAsync } from "./useAsync.js";
import { bannersApi } from "../services/engage.js";

const NONE = { site: {}, collections: {}, categories: {} };

// Banner images are decoration: if the request fails (or nothing is configured) pages quietly use their built-in layout.
export function useBanners() {
  const { data } = useAsync(
    (s) =>
      bannersApi.all(s).catch((e) => {
        if (e?.name === "AbortError") throw e;
        return NONE;
      }),
    [],
  );
  const b = data ?? NONE;
  return {
    site: b.site ?? {},
    collections: b.collections ?? {},
    categories: b.categories ?? {},
  };
}
