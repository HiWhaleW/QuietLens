const HUANGPU_GEO_BOUNDS = {
  south: 31.202,
  north: 31.245,
  west: 121.457,
  east: 121.487,
};

// Leaflet's simple CRS measures vertical pixels upward from the image bottom.
const HUANGPU_LAND_FRAME = {
  bottom: 220,
  top: 720,
  left: 340,
  right: 650,
};

const MARKER_NUDGES = {
  "hp-naive": [8, -15],
  "hp-east-sea": [-8, 15],
  "hp-cafe-on-air": [5, 10],
  "hp-antique": [-14, -4],
  "hp-naive-tree": [0, 0],
};

function normalize(value, min, max) {
  return Math.min(1, Math.max(0, (value - min) / (max - min)));
}

export function projectCafeToHuangpu(cafe) {
  const [latitude, longitude] = cafe.position;
  const northing = normalize(latitude, HUANGPU_GEO_BOUNDS.south, HUANGPU_GEO_BOUNDS.north);
  const easting = normalize(longitude, HUANGPU_GEO_BOUNDS.west, HUANGPU_GEO_BOUNDS.east);
  const [verticalNudge = 0, horizontalNudge = 0] = MARKER_NUDGES[cafe.id] || [];

  return [
    HUANGPU_LAND_FRAME.bottom
      + (northing * (HUANGPU_LAND_FRAME.top - HUANGPU_LAND_FRAME.bottom))
      + verticalNudge,
    HUANGPU_LAND_FRAME.left
      + (easting * (HUANGPU_LAND_FRAME.right - HUANGPU_LAND_FRAME.left))
      + horizontalNudge,
  ];
}

export { HUANGPU_LAND_FRAME };
