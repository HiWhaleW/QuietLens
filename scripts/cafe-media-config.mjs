export const CAFE_MEDIA_VERSION = "v4";

export const CAFE_MEDIA_SOURCES = Object.freeze([
  { cafeId: "hp-naive", key: "naive-watercolor", source: "naive-watercolor- v1.png", legacyPath: "/assets/cafes/naive-watercolor-v3.webp" },
  { cafeId: "hp-omnibus", key: "omnibus-watercolor", source: "omnibus-watercolor-v1.png", legacyPath: "/assets/cafes/omnibus-watercolor-v3.webp" },
  { cafeId: "hp-cafe-on-air", key: "cafe-on-air-watercolor", source: "cafe-on-air-watercolor-v1.png", legacyPath: "/assets/cafes/cafe-on-air-watercolor-v3.webp" },
  { cafeId: "hp-blue-house", key: "blue-house-watercolor", source: "blue-house-watercolor-v1.png", legacyPath: "/assets/cafes/blue-house-watercolor-v3.webp" },
  { cafeId: "hp-metal-hands", key: "metal-hands-yongjia-watercolor", source: "metal-hands-yongjia-watercolor-v1.png", legacyPath: "/assets/cafes/metal-hands-yongjia-watercolor-v3.webp" },
  { cafeId: "hp-antique", key: "antique-garden-watercolor", source: "antique-garden-watercolor-v1.png", legacyPath: "/assets/cafes/antique-garden-watercolor-v3.webp" },
  { cafeId: "hp-one-tenth", key: "one-tenth-jiujiang-watercolor", source: "one-tenth-jiujiang-watercolor-v1.png", legacyPath: "/assets/cafes/one-tenth-jiujiang-watercolor-v3.webp" },
  { cafeId: "hp-shiteng", key: "shiteng-people-square-watercolor", source: "shiteng-people-square-watercolor-v1.png", legacyPath: "/assets/cafes/shiteng-people-square-watercolor-v3.webp" },
  { cafeId: "hp-naive-tree", key: "naive-tree-changle-watercolor", source: "naive-tree-changle-watercolor-v1.png", legacyPath: "/assets/cafes/naive-tree-changle-watercolor-v3.webp" },
  { cafeId: "hp-east-sea", key: "east-sea-dianchi-watercolor", source: "east-sea-dianchi-watercolor-v1.png.png", legacyPath: "/assets/cafes/east-sea-dianchi-watercolor-v3.webp" },
]);

export const MAP_MEDIA_SOURCES = Object.freeze([
  { regionId: "overview", source: "overview-watercolor-board.png" },
  { regionId: "central", source: "central-watercolor-board.png" },
  { regionId: "huangpu", source: "huangpu-watercolor-board.png" },
]);

export function cafeMediaObjectPath(cafeId, role, contentHash) {
  return `media/cafes/${cafeId}/${role}-${contentHash.slice(0, 12)}.webp`;
}

export function mapMediaObjectPath(regionId, contentHash) {
  return `media/maps/${regionId}/board-${contentHash.slice(0, 12)}.webp`;
}
