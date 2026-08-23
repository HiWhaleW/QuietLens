import { useEffect, useMemo, useRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import L from "leaflet";
import { Coffee, Minus, Plus } from "lucide-react";
import {
  ImageOverlay,
  MapContainer,
  Marker,
  useMap,
  useMapEvents,
} from "react-leaflet";
import { getMapBoardMedia } from "./ai-native/media/mediaDelivery.js";
import { projectCafeToHuangpu } from "./mapProjection.js";

const MAP_BOUNDS = [
  [0, 0],
  [1024, 1536],
];

const CAFE_CENTER = [535, 830];
const HUANGPU_LEVEL = 2;
const BOARD_CENTER = [512, 768];
// Keep the selected-cafe atlas cluster visible beside the wider editorial sheet.
// The previous east-biased center only looked correct during the transition and
// pushed two markers (plus the connector origin) off-screen at the final frame.
const STORE_DETAIL_BOARD_CENTER = [512, 426];
const VIEWPORT_TRANSITION_MS = 620;

const MAP_BOARDS = [
  {
    id: "overview",
    region: "shanghai",
    label: "上海全域",
    caption: "上海全域高清层",
    image: getMapBoardMedia("overview")?.board.src,
  },
  {
    id: "central",
    region: "central",
    label: "中心城区",
    caption: "中心城区高清层",
    image: getMapBoardMedia("central")?.board.src,
  },
  {
    id: "huangpu",
    region: "huangpu",
    label: "黄浦区街区",
    caption: "黄浦区街区高清层",
    image: getMapBoardMedia("huangpu")?.board.src,
  },
];

const REGION_LEVELS = Object.fromEntries(MAP_BOARDS.map((board, index) => [board.region, index]));

function toCentralPosition([lat, lng]) {
  return [((lat - 200) / 600) * 1024, ((lng - 350) / 900) * 1536];
}

function markerIcon(cafe, selected) {
  const markerLabel = cafe.markerLabel ?? cafe.matchScore ?? "";
  const roleClass = cafe.role ? ` is-${cafe.role}` : " is-context";
  const placeId = encodeURIComponent(cafe.id);
  return L.divIcon({
    className: "quiet-marker-host",
    html: `<span class="quiet-marker${roleClass}${selected ? " is-selected" : ""}" data-place-id="${placeId}" aria-hidden="true"><span>${markerLabel}</span></span>`,
    iconSize: [46, 46],
    iconAnchor: [23, 23],
  });
}

function overviewIcon(count) {
  const icon = renderToStaticMarkup(<Coffee size={21} strokeWidth={1.8} aria-hidden="true" />);
  return L.divIcon({
    className: "cafe-overview-host",
    html: `<div class="cafe-overview" aria-hidden="true">${icon}<span><strong>${count}</strong> 家</span><small>黄浦区</small></div>`,
    iconSize: [100, 64],
    iconAnchor: [50, 32],
  });
}

function FixedBoardViewport({ boardLevel, railOpen, requestPanelOpen, resultPublished }) {
  const map = useMap();
  const viewMode = requestPanelOpen
    ? "request-panel"
    : railOpen
      ? "store-detail"
      : resultPublished
        ? "map-first"
        : "base";
  const previousViewMode = useRef(viewMode);
  const hasMounted = useRef(false);

  useEffect(() => {
    const targetCenter = viewMode === "store-detail"
        ? STORE_DETAIL_BOARD_CENTER
        : BOARD_CENTER;
    const targetBounds = MAP_BOUNDS;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const shouldAnimateViewChange = hasMounted.current
      && previousViewMode.current !== viewMode
      && !reducedMotion;
    previousViewMode.current = viewMode;
    hasMounted.current = true;

    function getTargetZoom() {
      map.setMinZoom(-5);
      map.setMaxZoom(5);
      return map.getBoundsZoom(MAP_BOUNDS, true);
    }

    function lockViewport(center = targetCenter, zoom = getTargetZoom()) {
      map.setMinZoom(-5);
      map.setMaxZoom(5);
      map.setMaxBounds(targetBounds);
      map.setView(center, zoom, { animate: false });
      map.setMinZoom(zoom);
      map.setMaxZoom(zoom);
    }

    let frame = 0;
    let transitionActive = shouldAnimateViewChange;
    function syncViewport() {
      if (transitionActive) return;
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        map.invalidateSize({ animate: false, pan: false });
        lockViewport();
      });
    }

    if (shouldAnimateViewChange) {
      const startCenter = map.getCenter();
      const startZoom = map.getZoom();
      const startedAt = window.performance.now();
      const animateViewport = (now) => {
        map.invalidateSize({ animate: false, pan: false });
        const progress = Math.min(1, (now - startedAt) / VIEWPORT_TRANSITION_MS);
        const eased = 1 - ((1 - progress) ** 3);
        const targetZoom = getTargetZoom();
        lockViewport([
          startCenter.lat + ((targetCenter[0] - startCenter.lat) * eased),
          startCenter.lng + ((targetCenter[1] - startCenter.lng) * eased),
        ], startZoom + ((targetZoom - startZoom) * eased));
        if (progress < 1) {
          frame = window.requestAnimationFrame(animateViewport);
          return;
        }
        transitionActive = false;
        syncViewport();
      };
      frame = window.requestAnimationFrame(animateViewport);
    } else {
      syncViewport();
    }

    const observer = typeof ResizeObserver === "function"
      ? new ResizeObserver(syncViewport)
      : null;
    observer?.observe(map.getContainer());
    return () => {
      window.cancelAnimationFrame(frame);
      observer?.disconnect();
    };
  }, [boardLevel, map, viewMode]);

  return null;
}

function WatercolorBoards({ level }) {
  return MAP_BOARDS.map((board, boardLevel) => (
    <ImageOverlay
      key={board.id}
      url={board.image}
      bounds={MAP_BOUNDS}
      className={`watercolor-board watercolor-board-${board.id} ${boardLevel === level ? "is-active" : "is-inactive"}`}
      opacity={boardLevel === level ? 1 : 0}
      zIndex={100 + boardLevel}
      interactive={false}
    />
  ));
}

function CafeMarkers({ cafes, selectedCafe, boardLevel, onBoardLevel, onSelect, onPrefetch }) {
  const overview = useMemo(() => overviewIcon(cafes.length), [cafes.length]);

  if (cafes.length === 0) return null;

  if (boardLevel < HUANGPU_LEVEL) {
    return (
      <Marker
        position={boardLevel === 0 ? [510, 845] : toCentralPosition(CAFE_CENTER)}
        icon={overview}
        bubblingMouseEvents={false}
        title={`放大查看黄浦区 ${cafes.length} 家咖啡店`}
        alt={`放大查看黄浦区 ${cafes.length} 家咖啡店`}
        zIndexOffset={500}
        eventHandlers={{
          click: (event) => {
            L.DomEvent.stopPropagation(event.originalEvent);
            onBoardLevel(HUANGPU_LEVEL, "cluster");
          },
        }}
      />
    );
  }

  return cafes.map((cafe) => {
    const markerDescription = cafe.role
      ? cafe.name
      : cafe.matchScore === null
        ? `${cafe.name}，综合参考待补充，可自主查看`
        : `${cafe.name}，综合参考 ${cafe.matchScore} 分，可自主查看`;
    return (
      <Marker
      key={`${cafe.id}-${cafe.matchScore}`}
      position={projectCafeToHuangpu(cafe)}
      icon={markerIcon(cafe, cafe.id === selectedCafe?.id)}
      bubblingMouseEvents={false}
      title={markerDescription}
      alt={markerDescription}
      zIndexOffset={cafe.id === selectedCafe?.id ? 900 : cafe.role ? 300 : 100}
      opacity={cafe.selectable === false ? 0.45 : 1}
      interactive={cafe.selectable !== false}
      eventHandlers={{
        mouseover: () => onPrefetch?.(cafe.id, "marker_hover"),
        focus: () => onPrefetch?.(cafe.id, "marker_focus"),
        touchstart: () => onPrefetch?.(cafe.id, "marker_touch"),
        click: (event) => {
          L.DomEvent.stopPropagation(event.originalEvent);
          if (cafe.selectable !== false) onSelect(cafe.id);
        },
      }}
    />
    );
  });
}

function ClearSelectionOnMapClick({ selectedCafe, onClearSelection }) {
  useMapEvents({
    click: () => {
      if (!selectedCafe) return;
      onClearSelection();
    },
  });
  return null;
}

function BoardControls({ level, onChange }) {
  return (
    <div className="board-controls" aria-label="地图分镜层级">
      <button
        type="button"
        aria-label="放大至更详细地图"
        title="放大至更详细地图"
        disabled={level === MAP_BOARDS.length - 1}
        onClick={() => onChange(Math.min(MAP_BOARDS.length - 1, level + 1), "zoom_in")}
      >
        <Plus aria-hidden="true" />
      </button>
      <button
        type="button"
        aria-label="缩小至更广域地图"
        title="缩小至更广域地图"
        disabled={level === 0}
        onClick={() => onChange(Math.max(0, level - 1), "zoom_out")}
      >
        <Minus aria-hidden="true" />
      </button>
    </div>
  );
}

export function MapStage({ cafes, region, drawerOpen, requestPanelOpen, resultPublished, selectedCafe, onSelect, onPrefetch, onClearSelection, onRegionChange }) {
  const boardLevel = REGION_LEVELS[region] ?? 0;
  const activeBoard = MAP_BOARDS[boardLevel];

  function changeBoardLevel(nextLevel, source) {
    onRegionChange(MAP_BOARDS[nextLevel].region, source);
  }

  return (
    <div className="map-stage" aria-label={`${activeBoard.label}咖啡店感官适配地图`}>
      <MapContainer
        crs={L.CRS.Simple}
        bounds={MAP_BOUNDS}
        minZoom={-5}
        maxZoom={5}
        maxBounds={MAP_BOUNDS}
        maxBoundsViscosity={1}
        zoomSnap={0}
        zoomControl={false}
        dragging={false}
        scrollWheelZoom={false}
        doubleClickZoom={false}
        touchZoom={false}
        boxZoom={false}
        keyboard={false}
        attributionControl={false}
        className="quiet-map watercolor-map"
      >
        <WatercolorBoards level={boardLevel} />
        <FixedBoardViewport
          boardLevel={boardLevel}
          railOpen={drawerOpen}
          requestPanelOpen={requestPanelOpen}
          resultPublished={resultPublished}
        />
        <ClearSelectionOnMapClick
          selectedCafe={selectedCafe}
          onClearSelection={onClearSelection}
        />

        <CafeMarkers
          cafes={cafes}
          selectedCafe={selectedCafe}
          boardLevel={boardLevel}
          onBoardLevel={changeBoardLevel}
          onSelect={onSelect}
          onPrefetch={onPrefetch}
        />
      </MapContainer>
      <div className={drawerOpen ? "board-controls-wrap with-drawer" : "board-controls-wrap"}>
        <BoardControls level={boardLevel} onChange={changeBoardLevel} />
      </div>
    </div>
  );
}
