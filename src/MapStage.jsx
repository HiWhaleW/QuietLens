import { useEffect, useMemo, useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import L from "leaflet";
import { ArrowDownLeft, Coffee, Minus, Plus } from "lucide-react";
import {
  ImageOverlay,
  MapContainer,
  Marker,
  Pane,
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
const SCENE_CLOSE_MS = 480;
const HUANGPU_LEVEL = 2;

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

function markerIcon(cafe) {
  const markerLabel = cafe.markerLabel ?? cafe.matchScore ?? "";
  const roleClass = cafe.role ? ` is-${cafe.role}` : " is-context";
  return L.divIcon({
    className: "quiet-marker-host",
    html: `<span class="quiet-marker${roleClass}" aria-hidden="true"><span>${markerLabel}</span></span>`,
    iconSize: [46, 46],
    iconAnchor: [23, 23],
  });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function sceneIcon(cafe, closing) {
  const arrow = renderToStaticMarkup(<ArrowDownLeft size={34} strokeWidth={1.6} aria-hidden="true" />);
  const sceneStatus = cafe.sceneStatus ?? (cafe.scene ? "ready" : "failed");
  const sceneMedia = sceneStatus === "ready" && cafe.scene
    ? `<img class="cafe-scene-illustration cafe-scene-full" src="${escapeHtml(cafe.scene)}" alt="" aria-hidden="true" decoding="sync" />`
    : sceneStatus === "failed"
      ? `<div class="cafe-scene-placeholder is-failed"><span>门店水彩图</span><strong>图片暂不可用</strong></div>`
      : `<div class="cafe-scene-placeholder is-loading" aria-label="门店图片加载中"><span>门店水彩图</span><strong>正在准备清晰图片</strong></div>`;
  const notice = cafe.notice
    ? `<div class="scene-conflict-note is-${escapeHtml(cafe.notice.kind)}"><strong>${escapeHtml(cafe.notice.label)}</strong><span>${escapeHtml(cafe.notice.text)}</span><i aria-hidden="true">${arrow}</i></div>`
    : "";

  return L.divIcon({
    className: "cafe-scene-host",
    html: `<div class="cafe-scene ${closing ? "is-closing" : "is-opening"}"><div class="paper-break" aria-hidden="true"><span class="paper-seal"></span><span class="torn-paper torn-paper-top"></span><span class="torn-paper torn-paper-right"></span><span class="torn-paper torn-paper-bottom"></span><span class="torn-paper torn-paper-left"></span>${sceneMedia}</div>${notice}</div>`,
    iconSize: [550, 340],
    iconAnchor: [310, 312],
  });
}

function SafeSceneMarker({ cafe, closing, drawerOpen }) {
  const map = useMap();
  const targetPosition = useMemo(() => projectCafeToHuangpu(cafe), [cafe]);
  const [position, setPosition] = useState(targetPosition);

  useEffect(() => {
    function placeSceneInsideViewport() {
      const mapSize = map.getSize();
      const targetPoint = map.latLngToContainerPoint(targetPosition);
      const drawerWidth = drawerOpen
        ? document.querySelector(".details-drawer.is-open")?.getBoundingClientRect().width || 400
        : 0;
      const sceneAnchor = { x: 310, y: 312 };
      const sceneSize = { x: 550, y: 340 };
      const safeGap = 22;
      const minX = sceneAnchor.x + safeGap;
      const maxX = Math.max(minX, mapSize.x - drawerWidth - (sceneSize.x - sceneAnchor.x) - safeGap);
      const minY = sceneAnchor.y + safeGap;
      const maxY = Math.max(minY, mapSize.y - (sceneSize.y - sceneAnchor.y) - safeGap);
      const safePoint = L.point(
        Math.min(Math.max(targetPoint.x, minX), maxX),
        Math.min(Math.max(targetPoint.y, minY), maxY),
      );
      setPosition(map.containerPointToLatLng(safePoint));
    }

    placeSceneInsideViewport();
    map.on("resize", placeSceneInsideViewport);
    return () => map.off("resize", placeSceneInsideViewport);
  }, [drawerOpen, map, targetPosition]);

  return (
    <Marker
      key={`${cafe.id}-${closing ? "closing" : "opening"}`}
      position={position}
      icon={sceneIcon(cafe, closing)}
      interactive={false}
      keyboard={false}
    />
  );
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

function FixedBoardViewport() {
  const map = useMap();

  useEffect(() => {
    function lockViewport() {
      map.setMinZoom(-5);
      map.setMaxZoom(5);
      const coverZoom = map.getBoundsZoom(MAP_BOUNDS, true);
      map.setView([512, 768], coverZoom, { animate: false });
      map.setMinZoom(coverZoom);
      map.setMaxZoom(coverZoom);
      map.setMaxBounds(MAP_BOUNDS);
    }

    lockViewport();
    map.on("resize", lockViewport);
    return () => map.off("resize", lockViewport);
  }, [map]);

  return null;
}

function WatercolorBoards({ level }) {
  const board = MAP_BOARDS[level];
  return (
    <ImageOverlay
      key={board.id}
      url={board.image}
      bounds={MAP_BOUNDS}
      className={`watercolor-board watercolor-board-${board.id} is-active`}
      opacity={1}
      zIndex={100 + level}
      interactive={false}
    />
  );
}

function CafeMarkers({ cafes, selectedCafe, boardLevel, onBoardLevel, onSelect, onPrefetch }) {
  const overview = useMemo(() => overviewIcon(cafes.length), [cafes.length]);

  if (selectedCafe) return null;
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
      icon={markerIcon(cafe)}
      bubblingMouseEvents={false}
      title={markerDescription}
      alt={markerDescription}
      zIndexOffset={cafe.role ? 300 : 100}
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

export function MapStage({ cafes, region, drawerOpen, selectedCafe, onSelect, onPrefetch, onClearSelection, onRegionChange }) {
  const [sceneCafe, setSceneCafe] = useState(null);
  const [sceneClosing, setSceneClosing] = useState(false);
  const boardLevel = REGION_LEVELS[region] ?? 0;

  useEffect(() => {
    if (selectedCafe) {
      setSceneCafe(selectedCafe);
      setSceneClosing(false);
      return undefined;
    }

    if (!sceneCafe || sceneClosing) return undefined;

    setSceneClosing(true);
    const closeDelay = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : SCENE_CLOSE_MS;
    const closeTimer = window.setTimeout(() => {
      setSceneCafe(null);
      setSceneClosing(false);
    }, closeDelay);

    return () => window.clearTimeout(closeTimer);
  }, [selectedCafe]);

  useEffect(() => {
    if (boardLevel === HUANGPU_LEVEL) return;
    setSceneCafe(null);
    setSceneClosing(false);
  }, [boardLevel]);

  const sceneVisible = Boolean(selectedCafe || sceneCafe);
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
        <FixedBoardViewport />
        <ClearSelectionOnMapClick
          selectedCafe={selectedCafe}
          onClearSelection={onClearSelection}
        />

        <Pane name="quietlens-scenes" style={{ zIndex: 450, pointerEvents: "none" }}>
          {sceneCafe && (sceneCafe.scene || sceneCafe.notice) && (
            <SafeSceneMarker cafe={sceneCafe} closing={sceneClosing} drawerOpen={drawerOpen} />
          )}
        </Pane>

        <CafeMarkers
          cafes={cafes}
          selectedCafe={sceneVisible ? (selectedCafe || sceneCafe) : null}
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
