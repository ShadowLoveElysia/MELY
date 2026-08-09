import {
  Box,
  Boxes,
  ChevronLeft,
  ChevronRight,
  Layers3,
  PackageOpen,
  Scan,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import type { ProjectionAxis, ProjectionBlockState, ProjectionDocument } from "../types";
import {
  createLayerGuideProgress,
  createLayerGuideSlice,
  getAdjacentLayerCoordinate,
  isLayerCompleted,
  listOccupiedLayerCoordinates,
  serializeLayerGuideProgress,
  setLayerCompleted,
  summarizeLayerGuideProgress,
  type LayerGuidePixel,
  type LayerGuideProgress,
  type LayerGuideSource,
  type LayerGuideSlice,
} from "../core/layerGuide";
import type { MaterialCategory, MaterialPlan } from "../core/materialPlanner";
import {
  createProjectionFingerprint,
  createProjectionLayerInput,
  createProjectionMaterialPlan,
  layerProgressStorageKey,
  loadLayerProgress,
} from "./survivalToolsModel";
import { useModalFocus } from "./useModalFocus";
import "./SurvivalTools.css";

type SurvivalTab = "materials" | "chests" | "layers";

export interface SurvivalToolsLabels {
  numberLocale: string;
  title: string;
  close: string;
  tabs: {
    materials: string;
    chests: string;
    layers: string;
  };
  summary: {
    blocks: string;
    materials: string;
    largeChests: string;
    shulkerBoxes: string;
  };
  materials: {
    block: string;
    category: string;
    quantity: string;
    transport: string;
    empty: string;
    breakdown: string;
    shulkerUnit: string;
    stackUnit: string;
    looseUnit: string;
    includeSupport: string;
    supportCount: string;
    supportBlock: string;
  };
  chests: {
    empty: string;
    chestTitle: string;
    usage: string;
    freeSlots: string;
    slotRange: string;
    allocationItems: string;
    slotTitle: string;
    previousPage: string;
    nextPage: string;
    page: string;
  };
  layers: {
    axis: string;
    axisX: string;
    axisY: string;
    axisZ: string;
    previousOccupied: string;
    nextOccupied: string;
    coordinate: string;
    coordinateRange: string;
    zoomOut: string;
    zoomIn: string;
    resetView: string;
    markCompleted: string;
    completed: string;
    progress: string;
    blocks: string;
    legend: string;
    empty: string;
    canvas: string;
    position: string;
  };
  categories: Record<MaterialCategory, string>;
}

export interface SurvivalToolsProps {
  projection: ProjectionDocument;
  labels: SurvivalToolsLabels;
  initialAxis?: ProjectionAxis;
  onClose: () => void;
  restoreFocusTo?: HTMLElement | null;
}

interface ViewTransform {
  zoom: number;
  panX: number;
  panY: number;
}

interface ProgressState {
  fingerprint: string;
  axes: Record<ProjectionAxis, LayerGuideProgress>;
}

interface HoveredBlock {
  pixel: LayerGuidePixel<ProjectionBlockState>;
  clientX: number;
  clientY: number;
}

const AXES: ProjectionAxis[] = ["x", "y", "z"];
const CHESTS_PER_PAGE = 12;
const CANVAS_PADDING = 38;
const DEFAULT_VIEW: ViewTransform = { zoom: 1, panX: 0, panY: 0 };

const formatLabel = (template: string, values: Record<string, string | number>) =>
  Object.entries(values).reduce(
    (result, [key, value]) => result.replaceAll(`{${key}}`, String(value)),
    template,
  );

const fallbackBlockColor = (blockId: string) => {
  let hash = 0;
  for (let index = 0; index < blockId.length; index += 1) {
    hash = Math.imul(hash ^ blockId.charCodeAt(index), 0x45d9f3b) >>> 0;
  }
  return `hsl(${hash % 360} 42% 58%)`;
};

const blockColor = (state: ProjectionBlockState) => state.color
  ? `rgb(${state.color[0]} ${state.color[1]} ${state.color[2]})`
  : state.blockId === "minecraft:end_rod"
    ? "rgb(235 229 184)"
    : state.blockId.includes("white_stained_glass")
      ? "rgb(216 233 235)"
      : fallbackBlockColor(state.blockId);

const axisLabel = (labels: SurvivalToolsLabels, axis: ProjectionAxis) =>
  axis === "x" ? labels.layers.axisX : axis === "y" ? labels.layers.axisY : labels.layers.axisZ;

const initialCoordinate = (projection: ProjectionDocument, axis: ProjectionAxis) => {
  if (!projection.bounds) return 0;
  return projection.bounds.min[axis === "x" ? 0 : axis === "y" ? 1 : 2];
};

const getStorage = () => {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
};

const loadProgressState = (fingerprint: string): ProgressState => {
  const storage = getStorage();
  return {
    fingerprint,
    axes: {
      x: loadLayerProgress(storage, fingerprint, "x"),
      y: loadLayerProgress(storage, fingerprint, "y"),
      z: loadLayerProgress(storage, fingerprint, "z"),
    },
  };
};

const canvasTransform = (
  width: number,
  height: number,
  slice: LayerGuideSlice<ProjectionBlockState>,
  view: ViewTransform,
) => {
  if (!slice.bounds) return null;
  const availableWidth = Math.max(1, width - CANVAS_PADDING * 2);
  const availableHeight = Math.max(1, height - CANVAS_PADDING * 2);
  const fitScale = Math.min(
    availableWidth / slice.bounds.dimensions[0],
    availableHeight / slice.bounds.dimensions[1],
  );
  const scale = Math.max(Number.EPSILON, Math.min(38, fitScale)) * view.zoom;
  const contentWidth = slice.bounds.dimensions[0] * scale;
  const contentHeight = slice.bounds.dimensions[1] * scale;
  return {
    scale,
    originX: (width - contentWidth) / 2 + view.panX,
    originY: (height - contentHeight) / 2 + view.panY,
  };
};

function MaterialView({ plan, labels, colors }: {
  plan: MaterialPlan;
  labels: SurvivalToolsLabels;
  colors: ReadonlyMap<string, string>;
}) {
  const number = useMemo(() => new Intl.NumberFormat(labels.numberLocale), [labels.numberLocale]);
  if (!plan.requirements.length) return <div className="survival-empty">{labels.materials.empty}</div>;
  return (
    <div className="survival-table-wrap">
      <table className="survival-table">
        <thead>
          <tr>
            <th>{labels.materials.block}</th>
            <th>{labels.materials.category}</th>
            <th>{labels.materials.quantity}</th>
            <th>{labels.materials.transport}</th>
          </tr>
        </thead>
        <tbody>
          {plan.requirements.map((requirement) => (
            <tr key={requirement.blockId}>
              <td>
                <span
                  className="survival-swatch"
                  style={{ "--survival-swatch": colors.get(requirement.blockId) } as CSSProperties}
                />
                <code>{requirement.blockId}</code>
              </td>
              <td>{labels.categories[requirement.category]}</td>
              <td>{number.format(requirement.count)}</td>
              <td>{formatLabel(labels.materials.breakdown, {
                shulkers: number.format(requirement.shulkerBoxes),
                shulkerUnit: labels.materials.shulkerUnit,
                stacks: number.format(requirement.stacks),
                stackUnit: labels.materials.stackUnit,
                loose: number.format(requirement.looseItems),
                looseUnit: labels.materials.looseUnit,
              })}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ChestView({ plan, labels, colors }: {
  plan: MaterialPlan;
  labels: SurvivalToolsLabels;
  colors: ReadonlyMap<string, string>;
}) {
  const [page, setPage] = useState(0);
  const number = useMemo(() => new Intl.NumberFormat(labels.numberLocale), [labels.numberLocale]);
  const stackSizes = useMemo(() => new Map(
    plan.requirements.map((requirement) => [requirement.blockId, requirement.stackSize]),
  ), [plan.requirements]);
  const pageCount = Math.max(1, Math.ceil(plan.chests.length / CHESTS_PER_PAGE));
  const safePage = Math.min(page, pageCount - 1);
  const visible = plan.chests.slice(
    safePage * CHESTS_PER_PAGE,
    (safePage + 1) * CHESTS_PER_PAGE,
  );

  useEffect(() => setPage(0), [plan]);
  if (!plan.chests.length) return <div className="survival-empty">{labels.chests.empty}</div>;
  return (
    <>
      <div className="chest-list">
        {visible.map((chest) => {
          const slots = Array.from({ length: 54 }, (_, index) => {
            const slot = index + 1;
            return chest.allocations.find((allocation) =>
              slot >= allocation.startSlot && slot < allocation.startSlot + allocation.slotCount);
          });
          return (
            <article className="chest-item" key={chest.index}>
              <header className="chest-item__header">
                <strong>{formatLabel(labels.chests.chestTitle, { index: number.format(chest.index) })}</strong>
                <span>{formatLabel(labels.chests.usage, {
                  used: number.format(chest.usedSlots),
                  total: number.format(54),
                })}</span>
                <span>{formatLabel(labels.chests.freeSlots, { count: number.format(chest.freeSlots) })}</span>
              </header>
              <div className="chest-slot-grid">
                {slots.map((allocation, index) => {
                  if (!allocation) return <span className="chest-slot" key={index} aria-hidden="true" />;
                  const slot = index + 1;
                  const offset = slot - allocation.startSlot;
                  const stackSize = stackSizes.get(allocation.blockId) ?? 64;
                  const itemCount = Math.min(stackSize, allocation.itemCount - offset * stackSize);
                  const title = formatLabel(labels.chests.slotTitle, {
                    slot: number.format(slot),
                    block: allocation.blockId,
                    count: number.format(itemCount),
                  });
                  return (
                    <span
                      className="chest-slot chest-slot--used"
                      key={index}
                      title={title}
                      aria-label={title}
                      style={{ "--survival-swatch": colors.get(allocation.blockId) } as CSSProperties}
                    />
                  );
                })}
              </div>
              <div className="chest-allocations">
                {chest.allocations.map((allocation) => (
                  <div key={`${allocation.blockId}-${allocation.startSlot}`}>
                    <span
                      className="survival-swatch"
                      style={{ "--survival-swatch": colors.get(allocation.blockId) } as CSSProperties}
                    />
                    <code>{allocation.blockId}</code>
                    <span>{formatLabel(labels.chests.slotRange, {
                      start: number.format(allocation.startSlot),
                      end: number.format(allocation.startSlot + allocation.slotCount - 1),
                    })}</span>
                    <span>{formatLabel(labels.chests.allocationItems, {
                      count: number.format(allocation.itemCount),
                    })}</span>
                  </div>
                ))}
              </div>
            </article>
          );
        })}
      </div>
      {pageCount > 1 ? (
        <nav className="chest-pagination" aria-label={labels.tabs.chests}>
          <button
            type="button"
            onClick={() => setPage((current) => Math.max(0, current - 1))}
            disabled={safePage === 0}
            title={labels.chests.previousPage}
            aria-label={labels.chests.previousPage}
          >
            <ChevronLeft size={17} />
          </button>
          <span>{formatLabel(labels.chests.page, {
            current: number.format(safePage + 1),
            total: number.format(pageCount),
          })}</span>
          <button
            type="button"
            onClick={() => setPage((current) => Math.min(pageCount - 1, current + 1))}
            disabled={safePage === pageCount - 1}
            title={labels.chests.nextPage}
            aria-label={labels.chests.nextPage}
          >
            <ChevronRight size={17} />
          </button>
        </nav>
      ) : null}
    </>
  );
}

function LayerCanvas({ slice, labels, view, onViewChange }: {
  slice: LayerGuideSlice<ProjectionBlockState>;
  labels: SurvivalToolsLabels;
  view: ViewTransform;
  onViewChange: (view: ViewTransform) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ pointerId: number; x: number; y: number; panX: number; panY: number } | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [hovered, setHovered] = useState<HoveredBlock | null>(null);
  const pixels = useMemo(() => new Map(
    slice.pixels.map((pixel) => [`${pixel.u},${pixel.v}`, pixel]),
  ), [slice.pixels]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const update = () => setSize({ width: host.clientWidth, height: host.clientHeight });
    update();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", update);
      return () => window.removeEventListener("resize", update);
    }
    const observer = new ResizeObserver(update);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || size.width <= 0 || size.height <= 0) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.round(size.width * ratio));
    canvas.height = Math.max(1, Math.round(size.height * ratio));
    const context = canvas.getContext("2d");
    if (!context) return;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, size.width, size.height);
    context.fillStyle = "#0b1015";
    context.fillRect(0, 0, size.width, size.height);
    const transform = canvasTransform(size.width, size.height, slice, view);
    if (!transform || !slice.bounds) return;

    for (const pixel of slice.pixels) {
      const x = transform.originX + (pixel.u - slice.bounds.min[0]) * transform.scale;
      const y = transform.originY + (slice.bounds.max[1] - pixel.v) * transform.scale;
      context.fillStyle = blockColor(pixel.paletteEntry);
      context.fillRect(x, y, Math.max(1, transform.scale), Math.max(1, transform.scale));
    }

    if (transform.scale >= 7) {
      context.strokeStyle = "rgb(89 105 116 / 42%)";
      context.lineWidth = 1;
      for (let u = 0; u <= slice.bounds.dimensions[0]; u += 1) {
        const x = transform.originX + u * transform.scale;
        context.beginPath();
        context.moveTo(x, transform.originY);
        context.lineTo(x, transform.originY + slice.bounds.dimensions[1] * transform.scale);
        context.stroke();
      }
      for (let v = 0; v <= slice.bounds.dimensions[1]; v += 1) {
        const y = transform.originY + v * transform.scale;
        context.beginPath();
        context.moveTo(transform.originX, y);
        context.lineTo(transform.originX + slice.bounds.dimensions[0] * transform.scale, y);
        context.stroke();
      }
    }

    context.fillStyle = "#a9b8c2";
    context.font = '11px Inter, "Segoe UI", sans-serif';
    context.textAlign = "center";
    context.fillText(`+${axisLabel(labels, slice.uAxis)}`, size.width - 24, size.height - 15);
    context.textAlign = "left";
    context.fillText(`+${axisLabel(labels, slice.vAxis)}`, 12, 18);
    context.fillStyle = "#667681";
    context.font = '10px "JetBrains Mono", monospace';
    context.fillText(formatLabel(labels.layers.coordinateRange, {
      axis: axisLabel(labels, slice.uAxis),
      min: slice.bounds.min[0],
      max: slice.bounds.max[0],
    }), 12, size.height - 13);
  }, [labels, size, slice, view]);

  const pixelAt = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!slice.bounds) return null;
    const rect = event.currentTarget.getBoundingClientRect();
    const transform = canvasTransform(rect.width, rect.height, slice, view);
    if (!transform) return null;
    const u = slice.bounds.min[0] + Math.floor((event.clientX - rect.left - transform.originX) / transform.scale);
    const v = slice.bounds.max[1] - Math.floor((event.clientY - rect.top - transform.originY) / transform.scale);
    return pixels.get(`${u},${v}`) ?? null;
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0 && event.pointerType === "mouse") return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      panX: view.panX,
      panY: view.panY,
    };
    setHovered(null);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (drag?.pointerId === event.pointerId) {
      onViewChange({
        ...view,
        panX: drag.panX + event.clientX - drag.x,
        panY: drag.panY + event.clientY - drag.y,
      });
      return;
    }
    const pixel = pixelAt(event);
    setHovered(pixel ? { pixel, clientX: event.clientX, clientY: event.clientY } : null);
  };

  const stopDrag = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null;
  };

  const onWheel = (event: ReactWheelEvent<HTMLCanvasElement>) => {
    event.preventDefault();
    const factor = event.deltaY < 0 ? 1.14 : 1 / 1.14;
    onViewChange({ ...view, zoom: Math.min(12, Math.max(0.25, view.zoom * factor)) });
  };

  return (
    <div ref={hostRef} className="layer-canvas-host">
      <canvas
        ref={canvasRef}
        role="img"
        aria-label={labels.layers.canvas}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={stopDrag}
        onPointerCancel={stopDrag}
        onPointerLeave={(event) => {
          stopDrag(event);
          setHovered(null);
        }}
        onWheel={onWheel}
      />
      {hovered ? (
        <output
          className="layer-hover"
          style={{ left: hovered.clientX, top: hovered.clientY }}
        >
          <strong>{hovered.pixel.paletteEntry.blockId}</strong>
          <span>{formatLabel(labels.layers.position, {
            x: hovered.pixel.position[0],
            y: hovered.pixel.position[1],
            z: hovered.pixel.position[2],
          })}</span>
        </output>
      ) : null}
    </div>
  );
}

function LayerView({
  input,
  labels,
  axis,
  coordinate,
  progress,
  onAxisChange,
  onCoordinateChange,
  onProgressChange,
}: {
  input: LayerGuideSource<ProjectionBlockState>;
  labels: SurvivalToolsLabels;
  axis: ProjectionAxis;
  coordinate: number;
  progress: LayerGuideProgress;
  onAxisChange: (axis: ProjectionAxis) => void;
  onCoordinateChange: (coordinate: number) => void;
  onProgressChange: (progress: LayerGuideProgress) => void;
}) {
  const [view, setView] = useState<ViewTransform>(DEFAULT_VIEW);
  const occupied = useMemo(() => listOccupiedLayerCoordinates(input, axis), [axis, input]);
  const slice = useMemo(() => createLayerGuideSlice(input, axis, coordinate), [axis, coordinate, input]);
  const previous = getAdjacentLayerCoordinate(occupied, coordinate, "previous");
  const next = getAdjacentLayerCoordinate(occupied, coordinate, "next");
  const summary = summarizeLayerGuideProgress(progress, occupied);
  const completed = isLayerCompleted(progress, coordinate);
  const first = occupied[0] ?? 0;
  const last = occupied.at(-1) ?? 0;
  const number = useMemo(() => new Intl.NumberFormat(labels.numberLocale), [labels.numberLocale]);

  useEffect(() => setView(DEFAULT_VIEW), [axis, coordinate]);
  useEffect(() => {
    if (!occupied.length) return;
    if (coordinate < first || coordinate > last) onCoordinateChange(first);
  }, [coordinate, first, last, occupied.length, onCoordinateChange]);

  return (
    <div className="layer-guide">
      <div className="layer-toolbar">
        <div className="layer-axis-control" role="group" aria-label={labels.layers.axis}>
          {AXES.map((value) => (
            <button
              type="button"
              className={axis === value ? "is-active" : ""}
              aria-pressed={axis === value}
              onClick={() => onAxisChange(value)}
              key={value}
            >
              {axisLabel(labels, value)}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="layer-icon-button"
          disabled={previous === null}
          onClick={() => previous !== null && onCoordinateChange(previous)}
          title={labels.layers.previousOccupied}
          aria-label={labels.layers.previousOccupied}
        >
          <ChevronLeft size={18} />
        </button>
        <label className="layer-coordinate-input">
          <span>{labels.layers.coordinate}</span>
          <input
            type="number"
            min={first}
            max={last}
            value={coordinate}
            disabled={!occupied.length}
            onChange={(event) => {
              if (Number.isSafeInteger(event.currentTarget.valueAsNumber)) {
                onCoordinateChange(Math.min(last, Math.max(first, event.currentTarget.valueAsNumber)));
              }
            }}
          />
        </label>
        <button
          type="button"
          className="layer-icon-button"
          disabled={next === null}
          onClick={() => next !== null && onCoordinateChange(next)}
          title={labels.layers.nextOccupied}
          aria-label={labels.layers.nextOccupied}
        >
          <ChevronRight size={18} />
        </button>
        <div className="layer-zoom-controls">
          <button
            type="button"
            onClick={() => setView((current) => ({ ...current, zoom: Math.max(0.25, current.zoom / 1.25) }))}
            title={labels.layers.zoomOut}
            aria-label={labels.layers.zoomOut}
          >
            <ZoomOut size={17} />
          </button>
          <button
            type="button"
            onClick={() => setView(DEFAULT_VIEW)}
            title={labels.layers.resetView}
            aria-label={labels.layers.resetView}
          >
            <Scan size={17} />
          </button>
          <button
            type="button"
            onClick={() => setView((current) => ({ ...current, zoom: Math.min(12, current.zoom * 1.25) }))}
            title={labels.layers.zoomIn}
            aria-label={labels.layers.zoomIn}
          >
            <ZoomIn size={17} />
          </button>
        </div>
      </div>
      <input
        className="layer-range"
        type="range"
        min={first}
        max={last}
        step={1}
        value={coordinate}
        disabled={!occupied.length || first === last}
        aria-label={labels.layers.coordinate}
        onChange={(event) => onCoordinateChange(Number(event.currentTarget.value))}
      />
      <div className="layer-progress-row">
        <span>{formatLabel(labels.layers.progress, {
          completed: number.format(summary.completedLayers),
          total: number.format(summary.totalLayers),
          percent: number.format(Math.round(summary.ratio * 100)),
        })}</span>
        <span>{formatLabel(labels.layers.blocks, { count: number.format(slice.blockCount) })}</span>
        <label>
          <input
            type="checkbox"
            checked={completed}
            disabled={slice.blockCount === 0}
            onChange={(event) => onProgressChange(setLayerCompleted(progress, coordinate, event.currentTarget.checked))}
          />
          <span>{completed ? labels.layers.completed : labels.layers.markCompleted}</span>
        </label>
      </div>
      <div className="layer-workspace">
        {slice.bounds ? (
          <LayerCanvas slice={slice} labels={labels} view={view} onViewChange={setView} />
        ) : (
          <div className="survival-empty">{labels.layers.empty}</div>
        )}
        <aside className="layer-legend">
          <h3>{labels.layers.legend}</h3>
          {slice.legend.map((entry) => (
            <div key={entry.paletteIndex}>
              <span
                className="survival-swatch"
                style={{ "--survival-swatch": blockColor(entry.paletteEntry) } as CSSProperties}
              />
              <code>{entry.paletteEntry.blockId}</code>
              <span>{number.format(entry.count)}</span>
            </div>
          ))}
        </aside>
      </div>
    </div>
  );
}

export function SurvivalTools({
  projection,
  labels,
  initialAxis = "y",
  onClose,
  restoreFocusTo,
}: SurvivalToolsProps) {
  const dialogRef = useModalFocus<HTMLElement>({ open: true, onClose, restoreFocusTo });
  const [activeTab, setActiveTab] = useState<SurvivalTab>("materials");
  const [includeSupportBlocks, setIncludeSupportBlocks] = useState(false);
  const [supportBlockCount, setSupportBlockCount] = useState(0);
  const [axis, setAxis] = useState<ProjectionAxis>(initialAxis);
  const [coordinates, setCoordinates] = useState<Record<ProjectionAxis, number>>(() => ({
    x: initialCoordinate(projection, "x"),
    y: initialCoordinate(projection, "y"),
    z: initialCoordinate(projection, "z"),
  }));
  const fingerprint = useMemo(() => createProjectionFingerprint(projection), [projection]);
  const [progressState, setProgressState] = useState<ProgressState>(() => loadProgressState(fingerprint));
  const materialPlan = useMemo(() => createProjectionMaterialPlan(projection, {
    includeSupportBlocks,
    supportBlockId: "minecraft:cobblestone",
    supportBlockCount,
  }), [includeSupportBlocks, projection, supportBlockCount]);
  const layerInput = useMemo(() => createProjectionLayerInput(projection), [projection]);
  const colors = useMemo(() => {
    const result = new Map<string, string>();
    projection.palette.forEach((state) => {
      if (!result.has(state.blockId)) result.set(state.blockId, blockColor(state));
    });
    return result;
  }, [projection.palette]);
  const number = useMemo(() => new Intl.NumberFormat(labels.numberLocale), [labels.numberLocale]);

  useEffect(() => {
    if (progressState.fingerprint !== fingerprint) setProgressState(loadProgressState(fingerprint));
  }, [fingerprint, progressState.fingerprint]);

  useEffect(() => {
    if (progressState.fingerprint !== fingerprint) return;
    const storage = getStorage();
    if (!storage) return;
    for (const progressAxis of AXES) {
      try {
        storage.setItem(
          layerProgressStorageKey(fingerprint, progressAxis),
          serializeLayerGuideProgress(progressState.axes[progressAxis]),
        );
      } catch {
        break;
      }
    }
  }, [fingerprint, progressState]);

  const tabs: { id: SurvivalTab; label: string; icon: typeof PackageOpen }[] = [
    { id: "materials", label: labels.tabs.materials, icon: PackageOpen },
    { id: "chests", label: labels.tabs.chests, icon: Boxes },
    { id: "layers", label: labels.tabs.layers, icon: Layers3 },
  ];

  return (
    <section
      ref={dialogRef}
      className="survival-tools"
      role="dialog"
      aria-modal="true"
      aria-label={labels.title}
      tabIndex={-1}
    >
      <header className="survival-header">
        <div>
          <Box size={20} />
          <h2>{labels.title}</h2>
        </div>
        <button type="button" onClick={onClose} title={labels.close} aria-label={labels.close}>
          <X size={19} />
        </button>
      </header>
      <div className="survival-summary">
        <div><strong>{number.format(materialPlan.totalBlocks)}</strong><span>{labels.summary.blocks}</span></div>
        <div><strong>{number.format(materialPlan.requirements.length)}</strong><span>{labels.summary.materials}</span></div>
        <div><strong>{number.format(materialPlan.totalLargeChests)}</strong><span>{labels.summary.largeChests}</span></div>
        <div><strong>{number.format(materialPlan.totalShulkerBoxes)}</strong><span>{labels.summary.shulkerBoxes}</span></div>
      </div>
      <div className="survival-planning-options">
        <label>
          <input
            type="checkbox"
            checked={includeSupportBlocks}
            onChange={(event) => setIncludeSupportBlocks(event.currentTarget.checked)}
          />
          <span>{labels.materials.includeSupport}</span>
        </label>
        <code>{labels.materials.supportBlock}</code>
        <label className="survival-support-count">
          <span>{labels.materials.supportCount}</span>
          <input
            type="number"
            min={0}
            step={64}
            value={supportBlockCount}
            disabled={!includeSupportBlocks}
            onChange={(event) => setSupportBlockCount(Math.max(0, Math.floor(event.currentTarget.valueAsNumber || 0)))}
          />
        </label>
      </div>
      <nav className="survival-tabs" aria-label={labels.title}>
        {tabs.map(({ id, label, icon: Icon }) => (
          <button
            type="button"
            key={id}
            className={activeTab === id ? "is-active" : ""}
            aria-selected={activeTab === id}
            role="tab"
            onClick={() => setActiveTab(id)}
          >
            <Icon size={16} />
            <span>{label}</span>
          </button>
        ))}
      </nav>
      <main className={`survival-content survival-content--${activeTab}`}>
        {activeTab === "materials" ? <MaterialView plan={materialPlan} labels={labels} colors={colors} /> : null}
        {activeTab === "chests" ? <ChestView plan={materialPlan} labels={labels} colors={colors} /> : null}
        {activeTab === "layers" ? (
          <LayerView
            input={layerInput}
            labels={labels}
            axis={axis}
            coordinate={coordinates[axis]}
            progress={progressState.axes[axis] ?? createLayerGuideProgress(axis)}
            onAxisChange={setAxis}
            onCoordinateChange={(coordinate) => setCoordinates((current) => ({ ...current, [axis]: coordinate }))}
            onProgressChange={(progress) => setProgressState((current) => ({
              ...current,
              axes: { ...current.axes, [axis]: progress },
            }))}
          />
        ) : null}
      </main>
    </section>
  );
}
