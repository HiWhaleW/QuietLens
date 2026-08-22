import { MEDIA_MANIFEST } from "./mediaManifest.generated.js";

function cleanReference(value) {
  return String(value ?? "").trim().replace(/^\.\//, "");
}

export function normalizeMediaBaseUrl(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("VITE_MEDIA_CDN_BASE_URL must be an absolute HTTPS URL");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("VITE_MEDIA_CDN_BASE_URL must be a credential-free HTTPS origin or path without query/hash");
  }
  return url.href.replace(/\/$/, "");
}

const configuredMediaBaseUrl = normalizeMediaBaseUrl(import.meta.env?.VITE_MEDIA_CDN_BASE_URL);

export function resolveMediaUrl(objectPath, baseUrl = configuredMediaBaseUrl) {
  const path = cleanReference(objectPath).replace(/^\/+/, "");
  if (!path) return null;
  const base = normalizeMediaBaseUrl(baseUrl);
  return base ? `${base}/${path}` : `/${path}`;
}

function resolvedAsset(asset, baseUrl) {
  return asset ? { ...asset, src: resolveMediaUrl(asset.path, baseUrl) } : null;
}

const cafeLookup = new Map();
for (const item of Object.values(MEDIA_MANIFEST.cafes)) {
  for (const reference of [item.cafe_id, item.key, ...item.legacy_paths]) {
    cafeLookup.set(cleanReference(reference), item);
    cafeLookup.set(cleanReference(reference).replace(/^\/+/, ""), item);
  }
}

export function getCafeSceneMedia(reference, { baseUrl = configuredMediaBaseUrl } = {}) {
  const cleaned = cleanReference(reference);
  const item = cafeLookup.get(cleaned) ?? cafeLookup.get(cleaned.replace(/^\/+/, ""));
  if (!item) return null;
  return {
    cafe_id: item.cafe_id,
    key: item.key,
    thumbnail: resolvedAsset(item.thumbnail, baseUrl),
    scene: resolvedAsset(item.scene, baseUrl),
  };
}

export function getMapBoardMedia(regionId, { baseUrl = configuredMediaBaseUrl } = {}) {
  const item = MEDIA_MANIFEST.maps[regionId];
  return item ? { region_id: item.region_id, board: resolvedAsset(item.board, baseUrl) } : null;
}

export function selectScenePrefetchUrls(places, placeIds, { limit = 3, baseUrl = configuredMediaBaseUrl } = {}) {
  const placeById = new Map(places.map((place) => [place.place_id, place]));
  return [...new Set(placeIds.slice(0, limit).map((placeId) => {
    const place = placeById.get(placeId);
    return getCafeSceneMedia(place?.asset, { baseUrl })?.scene?.src ?? null;
  }).filter(Boolean))];
}

export function mediaUsesCdn() {
  return Boolean(configuredMediaBaseUrl);
}
