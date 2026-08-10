import {
  AlertTriangle,
  ArrowUp,
  Bone,
  Box,
  Boxes,
  ChevronDown,
  ChevronUp,
  CircleCheck,
  Download,
  FileBox,
  FolderOpen,
  GripVertical,
  Layers3,
  LoaderCircle,
  Lock,
  Redo2,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Undo2,
  Unlock,
  Upload,
  UserRound,
  WandSparkles,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { CSSProperties, DragEvent, KeyboardEvent, PointerEvent } from "react";
import { orderModelParts } from "../core/modelParts";
import { useI18n } from "../i18n/I18nProvider";
import type {
  GenerationMode,
  HologramOptions,
  MmdMaterialInfo,
  MmdBoneInfo,
  MmdModelStats,
  MmdMotionTrackKind,
  MmdMotionTracks,
  MmdPoseState,
  PreviewMode,
  ProjectionStats,
  SolidOptions,
} from "../types";
import { Field, Select, Slider, Toggle } from "./Controls";
import { Section } from "./Section";

interface ImportedAsset {
  name: string;
  path: string;
  type: "model" | "motion" | "texture" | "archive";
  size: number;
}

interface SidebarProps {
  options: HologramOptions;
  solidOptions: SolidOptions;
  generationMode: GenerationMode;
  previewMode: PreviewMode;
  stats: ProjectionStats | null;
  modelStats: MmdModelStats | null;
  motionTracks: MmdMotionTracks;
  lockedMotionFrames: Record<MmdMotionTrackKind, number | null>;
  bones: readonly MmdBoneInfo[];
  materials: readonly MmdMaterialInfo[];
  hiddenMaterialIndices: readonly number[];
  selectedBoneIndex: number | null;
  poseEditing: boolean;
  poseState: MmdPoseState;
  processing: boolean;
  modelLoading: boolean;
  modelLoadStage: string;
  exporting: boolean;
  heightMaximum: number;
  extendedHeightUnlocked: boolean;
  extendedHeightActive: boolean;
  estimatedBlockCount: number | null;
  resourceEstimateLabel: string | null;
  progress: number;
  stage: string;
  progressDetail: string;
  sidebarWidth: number;
  physicsAvailable: boolean;
  physicsEnabled: boolean;
  physicsLoading: boolean;
  onOptionsChange: (patch: Partial<HologramOptions>) => void;
  onSolidOptionsChange: (patch: Partial<SolidOptions>) => void;
  onGenerationModeChange: (mode: GenerationMode) => void;
  onPreviewModeChange: (mode: PreviewMode) => void;
  onAssetsAdded: (files: File[]) => void | Promise<void>;
  onPhysicsEnabledChange: (enabled: boolean) => void | Promise<void>;
  onMaterialVisibilityChange: (index: number, visible: boolean) => void;
  onSidebarResizeStart: (event: PointerEvent<HTMLDivElement>) => void;
  onSidebarResizeStep: (delta: number) => void;
  onSidebarResizeReset: () => void;
  onPoseEditingChange: (editing: boolean) => void;
  onBoneSelected: (index: number | null) => void;
  onPoseNudge: (axis: "x" | "y" | "z", direction: -1 | 1) => void;
  onPoseUndo: () => void;
  onPoseRedo: () => void;
  onBoneReset: () => void;
  onPoseReset: () => void;
  onPoseExport: () => void | Promise<void>;
  onPoseImport: (file: File) => void | Promise<void>;
  onGenerate: () => void;
  onExport: () => void;
  onExtendedHeightToggle: () => void;
}

export function Sidebar({
  options,
  solidOptions,
  generationMode,
  previewMode,
  stats,
  modelStats,
  motionTracks,
  lockedMotionFrames,
  bones,
  materials,
  hiddenMaterialIndices,
  selectedBoneIndex,
  poseEditing,
  poseState,
  processing,
  modelLoading,
  modelLoadStage,
  exporting,
  heightMaximum,
  extendedHeightUnlocked,
  extendedHeightActive,
  estimatedBlockCount,
  resourceEstimateLabel,
  progress,
  stage,
  progressDetail,
  sidebarWidth,
  physicsAvailable,
  physicsEnabled,
  physicsLoading,
  onOptionsChange,
  onSolidOptionsChange,
  onGenerationModeChange,
  onPreviewModeChange,
  onAssetsAdded,
  onPhysicsEnabledChange,
  onMaterialVisibilityChange,
  onSidebarResizeStart,
  onSidebarResizeStep,
  onSidebarResizeReset,
  onPoseEditingChange,
  onBoneSelected,
  onPoseNudge,
  onPoseUndo,
  onPoseRedo,
  onBoneReset,
  onPoseReset,
  onPoseExport,
  onPoseImport,
  onGenerate,
  onExport,
  onExtendedHeightToggle,
}: SidebarProps) {
  const { t, number } = useI18n();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const poseInputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [partsExpanded, setPartsExpanded] = useState(false);
  const selectedBone = selectedBoneIndex === null ? null : bones[selectedBoneIndex] ?? null;
  const boneDisplayName = (bone: MmdBoneInfo) => bone.displayName
    || t("model.boneFallback", { index: number(bone.index + 1) });
  const selectedSkinMaterials = new Set(solidOptions.skinMaterialIndices);
  const hiddenMaterials = new Set(hiddenMaterialIndices);
  const hiddenMaterialCount = materials.reduce(
    (count, material) => count + (hiddenMaterials.has(material.index) ? 1 : 0),
    0,
  );
  const visibleMaterialCount = materials.length - hiddenMaterialCount;
  const orderedMaterials = orderModelParts(materials, hiddenMaterials);
  const displayedMaterials = partsExpanded ? orderedMaterials : orderedMaterials.slice(0, 3);
  const unlockedMotionTracks = (["dance", "expression"] as const)
    .filter((kind) => motionTracks[kind] && lockedMotionFrames[kind] === null)
    .map((kind) => t(kind === "dance" ? "sidebar.motion.danceTrack" : "sidebar.motion.expressionTrack"));
  const motionReady = unlockedMotionTracks.length === 0;

  const onResizeKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      onSidebarResizeStep(event.key === "ArrowLeft" ? -24 : 24);
    } else if (event.key === "Home") {
      event.preventDefault();
      onSidebarResizeReset();
    }
  };

  const toggleSkinMaterial = (index: number) => {
    const next = new Set(solidOptions.skinMaterialIndices);
    if (next.has(index)) next.delete(index);
    else next.add(index);
    onSolidOptionsChange({ skinMaterialIndices: [...next].sort((left, right) => left - right) });
  };

  useEffect(() => {
    const input = folderInputRef.current;
    if (!input) return;
    input.setAttribute("webkitdirectory", "");
    input.setAttribute("directory", "");
  }, []);

  useEffect(() => setPartsExpanded(false), [materials]);

  const addFiles = (files: FileList | null) => {
    if (!files?.length || modelLoading) return;
    void Promise.resolve(onAssetsAdded([...files])).finally(() => {
      if (fileInputRef.current) fileInputRef.current.value = "";
      if (folderInputRef.current) folderInputRef.current.value = "";
    });
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    addFiles(event.dataTransfer.files);
  };

  return (
    <aside
      className="sidebar"
      aria-label={t("sidebar.aria")}
      style={{ "--sidebar-width": `${sidebarWidth}px` } as CSSProperties}
    >
      <div
        className="sidebar-resize-handle"
        role="separator"
        tabIndex={0}
        aria-label={t("sidebar.resize")}
        aria-orientation="vertical"
        aria-valuemin={300}
        aria-valuemax={840}
        aria-valuenow={sidebarWidth}
        title={t("sidebar.resize")}
        onPointerDown={onSidebarResizeStart}
        onDoubleClick={onSidebarResizeReset}
        onKeyDown={onResizeKeyDown}
      >
        <GripVertical size={12} />
      </div>
      <div className="sidebar-scroll">
        <Section index="01" title={t("sidebar.section.assets")} subtitle={t("sidebar.section.assetsSubtitle")}>
          <div
            className={`drop-zone ${dragging ? "drop-zone--active" : ""} ${modelLoading ? "drop-zone--loading" : ""}`}
            aria-busy={modelLoading}
            onDragEnter={() => setDragging(true)}
            onDragLeave={() => setDragging(false)}
            onDragOver={(event) => event.preventDefault()}
            onDrop={onDrop}
          >
            <input
              ref={fileInputRef}
              type="file"
              hidden
              multiple
              accept=".pmx,.pmd,.vmd,.zip,.png,.jpg,.jpeg,.bmp,.tga"
              onChange={(event) => addFiles(event.target.files)}
            />
            <input
              ref={folderInputRef}
              type="file"
              hidden
              multiple
              onChange={(event) => addFiles(event.target.files)}
            />
            {modelLoading ? <LoaderCircle className="loading-spinner" size={20} /> : <Upload size={20} />}
            <strong>{modelLoading ? modelLoadStage : t("sidebar.drop.title")}</strong>
            <span>{modelLoading ? t("sidebar.drop.loading") : t("sidebar.drop.hint")}</span>
            <div className="drop-actions">
              <button
                type="button"
                className="secondary-button"
                disabled={modelLoading}
                onClick={() => fileInputRef.current?.click()}
              >
                <FileBox size={14} />
                {t("sidebar.drop.chooseFiles")}
              </button>
              <button
                type="button"
                className="secondary-button"
                disabled={modelLoading}
                onClick={() => folderInputRef.current?.click()}
              >
                <FolderOpen size={14} />
                {t("sidebar.drop.chooseFolder")}
              </button>
            </div>
          </div>

          {modelStats ? (
            <Field
              label={t("sidebar.physics.label")}
              hint={t(physicsAvailable ? "sidebar.physics.hint" : "sidebar.physics.unavailable")}
            >
              <Toggle
                checked={physicsEnabled}
                label={t("sidebar.physics.label")}
                disabled={!physicsAvailable || physicsLoading || modelLoading || processing}
                onChange={(enabled) => void onPhysicsEnabledChange(enabled)}
              />
            </Field>
          ) : null}

          {modelStats ? (
            <div className="model-summary">
              <div className="model-summary__header">
                <span>
                  <CircleCheck size={14} />
                  <strong>{modelStats.name}</strong>
                </span>
                <small>{modelStats.format.toUpperCase()}</small>
              </div>
              <div className="model-stat-grid">
                <span><small>{t("sidebar.stat.vertices")}</small><strong>{number(modelStats.vertexCount)}</strong></span>
                <span><small>{t("sidebar.stat.triangles")}</small><strong>{number(modelStats.triangleCount)}</strong></span>
                <span><small>{t("sidebar.stat.bones")}</small><strong>{number(modelStats.boneCount)}</strong></span>
                <span><small>{t("sidebar.stat.materials")}</small><strong>{number(modelStats.materialCount)}</strong></span>
                <span><small>{t("sidebar.stat.morphs")}</small><strong>{number(modelStats.morphCount)}</strong></span>
                <span><small>{t("sidebar.stat.rigidBodies")}</small><strong>{number(modelStats.rigidBodyCount)}</strong></span>
                <span><small>{t("sidebar.stat.joints")}</small><strong>{number(modelStats.jointCount)}</strong></span>
              </div>
              {modelStats.textureWarnings ? (
                <div className="model-warning">
                  <AlertTriangle size={13} />
                  <span>{t("sidebar.textureWarnings", { count: number(modelStats.textureWarnings) })}</span>
                </div>
              ) : null}
            </div>
          ) : null}

          {modelStats ? (
            <div className="preview-selector" role="group" aria-label={t("sidebar.preview.aria")}>
              <button
                type="button"
                className={previewMode === "source" ? "preview-option preview-option--active" : "preview-option"}
                aria-pressed={previewMode === "source"}
                onClick={() => onPreviewModeChange("source")}
              >
                <UserRound size={16} />
                <span><strong>{t("sidebar.preview.source")}</strong><small>{t("sidebar.preview.sourceHint")}</small></span>
              </button>
              <button
                type="button"
                className={previewMode === "hologram" ? "preview-option preview-option--active" : "preview-option"}
                aria-pressed={previewMode === "hologram"}
                disabled={!stats}
                onClick={() => onPreviewModeChange("hologram")}
              >
                <Boxes size={16} />
                <span><strong>{t("sidebar.preview.projection")}</strong><small>{stats ? t("sidebar.preview.blocks", { count: number(stats.blockCount) }) : t("sidebar.preview.pending")}</small></span>
              </button>
            </div>
          ) : null}

          {modelStats && materials.length ? (
            <div className="model-parts">
              <button
                type="button"
                className="model-parts__toggle"
                aria-expanded={partsExpanded}
                aria-controls="model-parts-list"
                title={t(partsExpanded ? "sidebar.parts.collapse" : "sidebar.parts.expand")}
                disabled={materials.length <= 3}
                onClick={() => setPartsExpanded((current) => !current)}
              >
                <span>
                  <Layers3 size={15} />
                  <strong>{t("sidebar.parts.title")}</strong>
                </span>
                <span>
                  <small>{t("sidebar.parts.visibleCount", {
                    visible: number(visibleMaterialCount),
                    total: number(materials.length),
                  })}</small>
                  {materials.length > 3
                    ? partsExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />
                    : null}
                </span>
              </button>
              <div
                id="model-parts-list"
                className={`model-parts__list ${partsExpanded ? "model-parts__list--expanded" : ""}`}
              >
                {displayedMaterials.map((material) => {
                  const hidden = hiddenMaterials.has(material.index);
                  const displayName = material.displayName
                    || t("model.materialFallback", { index: number(material.index + 1) });
                  const cannotHide = !hidden && visibleMaterialCount <= 1;
                  return (
                    <label
                      className={`model-part ${hidden ? "model-part--hidden" : ""}`}
                      key={material.index}
                      title={cannotHide ? t("sidebar.parts.keepOne") : displayName}
                    >
                      <input
                        type="checkbox"
                        checked={!hidden}
                        disabled={cannotHide || modelLoading || processing}
                        onChange={(event) => onMaterialVisibilityChange(material.index, event.target.checked)}
                      />
                      <span
                        className="model-part__swatch"
                        style={{ backgroundColor: `rgb(${material.color.map((value) => Math.round(value * 255)).join(",")})` }}
                      />
                      <span className="model-part__name">
                        <strong>{displayName}</strong>
                        <small>{t("sidebar.parts.materialIndex", {
                          index: material.index.toString().padStart(2, "0"),
                        })}</small>
                      </span>
                      {hidden ? <small className="model-part__status">{t("sidebar.parts.hidden")}</small> : null}
                    </label>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="demo-source">
              <UserRound size={14} />
              <span>{t("sidebar.asset.waiting")}</span>
            </div>
          )}

        </Section>

        {modelStats ? (
          <Section index="02" title={t("sidebar.section.pose")} subtitle={t("sidebar.section.poseSubtitle")}>
            <Field label={t("sidebar.pose.viewport")} hint={t("sidebar.pose.viewportHint")}>
              <Toggle
                checked={poseEditing}
                label={t("sidebar.pose.manual")}
                onChange={onPoseEditingChange}
              />
            </Field>

            <div className="pose-control">
              <div className="pose-control__header">
                <span>
                  <Bone size={14} />
                  <strong>{selectedBone ? boneDisplayName(selectedBone) : t("sidebar.pose.selectBone")}</strong>
                </span>
                <small>{selectedBone?.controlMode === "translate"
                  ? t("sidebar.pose.control.translate")
                  : t("sidebar.pose.control.rotate")}</small>
              </div>
              <select
                className="bone-select"
                aria-label={t("sidebar.pose.selectBone")}
                value={selectedBoneIndex ?? ""}
                onChange={(event) => onBoneSelected(event.target.value === "" ? null : Number(event.target.value))}
              >
                <option value="">{t("sidebar.pose.selectBone")}</option>
                {bones.map((bone) => (
                  <option key={bone.index} value={bone.index}>
                    {bone.index.toString().padStart(3, "0")} · {boneDisplayName(bone)}{bone.isIkGoal ? " · IK" : ""}
                  </option>
                ))}
              </select>

              <div className="axis-nudges" aria-label={t("sidebar.pose.axisNudge")}>
                {(["x", "y", "z"] as const).map((axis) => (
                  <div className={`axis-nudge axis-nudge--${axis}`} key={axis}>
                    <strong>{axis.toUpperCase()}</strong>
                    <button
                      type="button"
                      aria-label={t("sidebar.pose.axisNegative", { axis: axis.toUpperCase() })}
                      title={t("sidebar.pose.axisNegative", { axis: axis.toUpperCase() })}
                      disabled={!selectedBone}
                      onClick={() => onPoseNudge(axis, -1)}
                    >
                      −
                    </button>
                    <button
                      type="button"
                      aria-label={t("sidebar.pose.axisPositive", { axis: axis.toUpperCase() })}
                      title={t("sidebar.pose.axisPositive", { axis: axis.toUpperCase() })}
                      disabled={!selectedBone}
                      onClick={() => onPoseNudge(axis, 1)}
                    >
                      +
                    </button>
                  </div>
                ))}
              </div>

              <div className="pose-actions">
                <button type="button" aria-label={t("sidebar.pose.undo")} title={t("sidebar.pose.undo")} disabled={!poseState.canUndo} onClick={onPoseUndo}>
                  <Undo2 size={14} />
                </button>
                <button type="button" aria-label={t("sidebar.pose.redo")} title={t("sidebar.pose.redo")} disabled={!poseState.canRedo} onClick={onPoseRedo}>
                  <Redo2 size={14} />
                </button>
                <button type="button" aria-label={t("sidebar.pose.resetBone")} title={t("sidebar.pose.resetBone")} disabled={!selectedBone} onClick={onBoneReset}>
                  <Bone size={14} />
                </button>
                <button type="button" aria-label={t("sidebar.pose.resetAll")} title={t("sidebar.pose.resetAll")} disabled={!poseState.editCount} onClick={onPoseReset}>
                  <RotateCcw size={14} />
                </button>
                <output>{t("sidebar.pose.editCount", { count: number(poseState.editCount) })}</output>
              </div>
            </div>
            <input
              ref={poseInputRef}
              type="file"
              hidden
              accept=".json,.pose.json,application/json"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (!file) return;
                void Promise.resolve(onPoseImport(file)).finally(() => {
                  if (poseInputRef.current) poseInputRef.current.value = "";
                });
              }}
            />
            <div className="drop-actions">
              <button
                type="button"
                className="secondary-button"
                disabled={processing || modelLoading}
                onClick={() => void onPoseExport()}
              >
                <Download size={14} />
                {t("sidebar.pose.exportJson")}
              </button>
              <button
                type="button"
                className="secondary-button"
                disabled={processing || modelLoading}
                onClick={() => poseInputRef.current?.click()}
              >
                <Upload size={14} />
                {t("sidebar.pose.importJson")}
              </button>
            </div>
          </Section>
        ) : null}

        <Section index={modelStats ? "03" : "02"} title={t("sidebar.section.scale")} subtitle={t("sidebar.scale.version")}>
          <Field label={t("sidebar.scale.targetHeight")} hint={t("sidebar.scale.targetHeightHint")}>
            <Slider
              value={options.targetHeight}
              min={32}
              max={heightMaximum}
              editable
              unit={t("sidebar.scale.blocksUnit")}
              onChange={(targetHeight) => onOptionsChange({ targetHeight })}
            />
          </Field>
          <button
            type="button"
            className={extendedHeightUnlocked ? "height-unlock height-unlock--active" : "height-unlock"}
            aria-pressed={extendedHeightUnlocked}
            onClick={onExtendedHeightToggle}
          >
            {extendedHeightUnlocked ? <Unlock size={15} /> : <Lock size={15} />}
            <span>{extendedHeightUnlocked
              ? t("sidebar.scale.lockExtended")
              : t("sidebar.scale.unlockExtended", { maximum: number(2032) })}</span>
          </button>
          <div className="dimension-strip">
            <span><Box size={14} /> {t("sidebar.scale.bounds")}</span>
            <strong>{stats ? `${stats.dimensions[0]} × ${stats.dimensions[1]} × ${stats.dimensions[2]}` : "-- × -- × --"}</strong>
          </div>
          <div className="dimension-strip">
            <span><Boxes size={14} /> {t("sidebar.scale.estimatedBlocks")}</span>
            <strong>{estimatedBlockCount === null ? "--" : number(estimatedBlockCount)}</strong>
          </div>
          {resourceEstimateLabel ? (
            <div className="resource-estimate">
              <span>{t("sidebar.scale.estimatedMemory")}</span>
              <strong>{resourceEstimateLabel}</strong>
            </div>
          ) : null}
          {extendedHeightActive ? (
            <div className="height-warning" role="status">
              <AlertTriangle size={16} />
              <span>
                <strong>{t("sidebar.scale.extendedWarningTitle")}</strong>
                <small>{t("sidebar.scale.extendedWarningBody")}</small>
              </span>
            </div>
          ) : null}
        </Section>

        <Section
          index={modelStats ? "04" : "03"}
          title={t("sidebar.section.mode")}
          subtitle={generationMode === "solid" ? t("sidebar.mode.solidSubtitle") : t("sidebar.mode.hologramSubtitle")}
        >
          <div className="mode-selector" role="group" aria-label={t("sidebar.mode.aria")}>
            <button
              type="button"
              className={generationMode === "hologram" ? "mode-option mode-option--active" : "mode-option"}
              aria-pressed={generationMode === "hologram"}
              onClick={() => onGenerationModeChange("hologram")}
            >
              <WandSparkles size={18} />
              <span><strong>{t("sidebar.mode.hologram")}</strong><small>{t("sidebar.mode.hologramHint")}</small></span>
            </button>
            <button
              type="button"
              className={generationMode === "solid" ? "mode-option mode-option--active" : "mode-option"}
              aria-pressed={generationMode === "solid"}
              onClick={() => onGenerationModeChange("solid")}
            >
              <Boxes size={18} />
              <span><strong>{t("sidebar.mode.solid")}</strong><small>{t("sidebar.mode.solidHint")}</small></span>
            </button>
          </div>

          {generationMode === "hologram" ? (
            <>
              <Field label={t("sidebar.hologram.spacing")} hint={t("sidebar.hologram.spacingHint")}>
                <Slider
                  value={options.sampleSpacing}
                  min={1}
                  max={5}
                  onChange={(sampleSpacing) => onOptionsChange({ sampleSpacing })}
                />
              </Field>
              <Field label={t("sidebar.hologram.material")}>
                <Select value={options.material} onChange={(material) => onOptionsChange({ material: material as HologramOptions["material"] })}>
                  <option value="mixed">{t("sidebar.hologram.mixed")}</option>
                  <option value="end_rod">{t("sidebar.hologram.endRod")}</option>
                  <option value="white_pane">{t("sidebar.hologram.whitePane")}</option>
                </Select>
              </Field>
              <div className="direction-rule">
                <ArrowUp size={16} />
                <span><strong>{t("sidebar.hologram.vertical")}</strong><small>{t("sidebar.hologram.verticalHint")}</small></span>
                <CircleCheck size={15} />
              </div>
              <Field label={t("sidebar.hologram.preserveFace")} hint={t("sidebar.hologram.preserveFaceHint")}>
                <Toggle
                  checked={options.preserveFace}
                  label={t("sidebar.hologram.preserveFace")}
                  onChange={(preserveFace) => onOptionsChange({ preserveFace })}
                />
              </Field>
              <Field label={t("sidebar.hologram.glow")}>
                <Slider value={options.glow} min={0} max={100} unit="%" onChange={(glow) => onOptionsChange({ glow })} />
              </Field>
            </>
          ) : (
            <>
              <Field label={t("sidebar.solid.structure")} hint={t("sidebar.solid.structureHint")}>
                <Select value={solidOptions.fillMode} onChange={(fillMode) => onSolidOptionsChange({ fillMode: fillMode as SolidOptions["fillMode"] })}>
                  <option value="shell">{t("sidebar.solid.shell")}</option>
                  <option value="filled">{t("sidebar.solid.filled")}</option>
                </Select>
              </Field>
              <Field label={t("sidebar.solid.alpha")} hint={t("sidebar.solid.alphaHint")}>
                <Slider
                  value={solidOptions.alphaThreshold}
                  min={0}
                  max={0.9}
                  step={0.05}
                  onChange={(alphaThreshold) => onSolidOptionsChange({ alphaThreshold })}
                />
              </Field>
              <Field label={t("sidebar.solid.thickness")} hint={t("sidebar.solid.thicknessHint")}>
                <Slider
                  value={solidOptions.thicknessCompensation}
                  min={0}
                  max={0.3}
                  step={0.02}
                  onChange={(thicknessCompensation) => onSolidOptionsChange({ thicknessCompensation })}
                />
              </Field>
              <Field label={t("sidebar.solid.palette")} hint={t("sidebar.solid.paletteHint")}>
                <Select value={solidOptions.palettePreset} onChange={(palettePreset) => onSolidOptionsChange({ palettePreset: palettePreset as SolidOptions["palettePreset"] })}>
                  <option value="clean">{t("sidebar.solid.clean")}</option>
                  <option value="balanced">{t("sidebar.solid.balanced")}</option>
                </Select>
              </Field>
              <Field label={t("sidebar.solid.theme")} hint={t("sidebar.solid.themeHint")}>
                <Select value={solidOptions.materialTheme} onChange={(materialTheme) => onSolidOptionsChange({ materialTheme: materialTheme as SolidOptions["materialTheme"] })}>
                  <option value="original">{t("sidebar.solid.theme.original")}</option>
                  <option value="greekMarble">{t("sidebar.solid.theme.greekMarble")}</option>
                  <option value="steampunk">{t("sidebar.solid.theme.steampunk")}</option>
                  <option value="ancientRuins">{t("sidebar.solid.theme.ancientRuins")}</option>
                </Select>
              </Field>
              <Field label={t("sidebar.solid.dithering")} hint={t("sidebar.solid.ditheringHint")}>
                <Slider
                  value={solidOptions.dithering}
                  min={0}
                  max={100}
                  unit="%"
                  onChange={(dithering) => onSolidOptionsChange({ dithering })}
                />
              </Field>
              <Field label={t("sidebar.solid.emissiveMapping")} hint={t("sidebar.solid.emissiveMappingHint")}>
                <Toggle
                  checked={solidOptions.emissiveMapping}
                  label={t("sidebar.solid.emissiveMapping")}
                  onChange={(emissiveMapping) => onSolidOptionsChange({ emissiveMapping })}
                />
              </Field>
              {solidOptions.emissiveMapping && materials.length ? (
                <div className="material-picker" aria-label={t("sidebar.solid.emissiveMaterials")}>
                  <div className="material-picker__header">
                    <span>{t("sidebar.solid.emissiveMaterials")}</span>
                    <small>{t("sidebar.solid.materialCount", {
                      selected: number(solidOptions.emissiveMaterialIndices.length),
                      total: number(materials.length),
                    })}</small>
                  </div>
                  <div className="material-picker__list">
                    {materials.map((material) => (
                      <label
                        className="material-item"
                        key={material.index}
                        title={material.displayName || t("model.materialFallback", { index: number(material.index + 1) })}
                      >
                        <input
                          type="checkbox"
                          checked={solidOptions.emissiveMaterialIndices.includes(material.index)}
                          onChange={() => {
                            const next = new Set(solidOptions.emissiveMaterialIndices);
                            if (next.has(material.index)) next.delete(material.index);
                            else next.add(material.index);
                            onSolidOptionsChange({ emissiveMaterialIndices: [...next].sort((left, right) => left - right) });
                          }}
                        />
                        <span
                          className="material-swatch"
                          style={{ backgroundColor: `rgb(${material.color.map((value) => Math.round(value * 255)).join(",")})` }}
                        />
                        <span className="material-item__name">
                          {material.index.toString().padStart(2, "0")} · {material.displayName || t("model.materialFallback", { index: number(material.index + 1) })}
                        </span>
                        {material.suggestedEmissive ? <small>{t("sidebar.solid.emissiveBadge")}</small> : null}
                      </label>
                    ))}
                  </div>
                </div>
              ) : null}
              {solidOptions.materialTheme === "ancientRuins" ? (
                <Field label={t("sidebar.solid.ruinDecoration")} hint={t("sidebar.solid.ruinDecorationHint")}>
                  <Slider
                    value={solidOptions.ruinDecoration}
                    min={0}
                    max={100}
                    unit="%"
                    onChange={(ruinDecoration) => onSolidOptionsChange({ ruinDecoration })}
                  />
                </Field>
              ) : null}
              <Field label={t("sidebar.solid.skinProtection")} hint={t("sidebar.solid.skinProtectionHint")}>
                <Toggle
                  checked={solidOptions.skinProtection}
                  label={t("sidebar.solid.skinProtection")}
                  onChange={(skinProtection) => onSolidOptionsChange({ skinProtection })}
                />
              </Field>
              <Field label={t("sidebar.solid.faceDetail")} hint={t("sidebar.solid.faceDetailHint")}>
                <Select value={solidOptions.faceDetail} onChange={(faceDetail) => onSolidOptionsChange({ faceDetail: faceDetail as SolidOptions["faceDetail"] })}>
                  <option value="off">{t("sidebar.solid.faceDetail.off")}</option>
                  <option value="balanced">{t("sidebar.solid.faceDetail.balanced")}</option>
                  <option value="strong">{t("sidebar.solid.faceDetail.strong")}</option>
                </Select>
              </Field>
              {solidOptions.skinProtection && materials.length ? (
                <div className="material-picker" aria-label={t("sidebar.solid.skinMaterials")}>
                  <div className="material-picker__header">
                    <span>{t("sidebar.solid.skinMaterials")}</span>
                    <small>{t("sidebar.solid.materialCount", {
                      selected: number(solidOptions.skinMaterialIndices.length),
                      total: number(materials.length),
                    })}</small>
                  </div>
                  <div className="material-picker__list">
                    {materials.map((material) => (
                      <label
                        className="material-item"
                        key={material.index}
                        title={material.displayName || t("model.materialFallback", { index: number(material.index + 1) })}
                      >
                        <input
                          type="checkbox"
                          checked={selectedSkinMaterials.has(material.index)}
                          onChange={() => toggleSkinMaterial(material.index)}
                        />
                        <span
                          className="material-swatch"
                          style={{ backgroundColor: `rgb(${material.color.map((value) => Math.round(value * 255)).join(",")})` }}
                        />
                        <span className="material-item__name">
                          {material.index.toString().padStart(2, "0")} · {material.displayName || t("model.materialFallback", { index: number(material.index + 1) })}
                        </span>
                        {material.hasTexture ? <small>{t("sidebar.solid.textureBadge")}</small> : null}
                      </label>
                    ))}
                  </div>
                </div>
              ) : null}
              <Field label={t("sidebar.solid.excludeGravity")} hint={t("sidebar.solid.excludeGravityHint")}>
                <Toggle
                  checked={solidOptions.excludeGravity}
                  label={t("sidebar.solid.excludeGravity")}
                  onChange={(excludeGravity) => onSolidOptionsChange({ excludeGravity })}
                />
              </Field>
              <Field label={t("sidebar.solid.excludeRare")} hint={t("sidebar.solid.excludeRareHint")}>
                <Toggle
                  checked={solidOptions.excludeRare}
                  label={t("sidebar.solid.excludeRare")}
                  onChange={(excludeRare) => onSolidOptionsChange({ excludeRare })}
                />
              </Field>
            </>
          )}
        </Section>

        <Section index={modelStats ? "05" : "04"} title={t("sidebar.section.rules")} subtitle={t("sidebar.section.rulesSubtitle")} defaultOpen={false}>
          <div className="rule-row">
            <ShieldCheck size={16} />
            <span><strong>{t("sidebar.rules.versionKeys")}</strong><small>{t("sidebar.rules.dataVersion", { version: number(3465) })}</small></span>
            <CircleCheck size={15} />
          </div>
          <div className="rule-row">
            <Layers3 size={16} />
            <span><strong>{t("sidebar.rules.stateValidation")}</strong><small>{t("sidebar.rules.stateDetails")}</small></span>
            <CircleCheck size={15} />
          </div>
        </Section>
      </div>

      <div className="sidebar-footer">
        {modelLoading ? (
          <div className="progress-block progress-block--indeterminate">
            <div><span>{modelLoadStage}</span><strong>{t("sidebar.loadingBadge")}</strong></div>
            <div className="progress-track"><span /></div>
          </div>
        ) : processing || exporting ? (
          <div className="progress-block">
            <div><span>{stage}</span><strong>{Math.round(progress * 100)}%</strong></div>
            <div className="progress-track"><span style={{ width: `${progress * 100}%` }} /></div>
            {progressDetail ? <small className="progress-file" title={progressDetail}>{progressDetail}</small> : null}
          </div>
        ) : (
          <div className="result-summary">
            <span><Boxes size={15} /> {t("sidebar.currentProjection")}</span>
            <strong>{t("sidebar.blocks", { count: stats ? number(stats.blockCount) : "--" })}</strong>
          </div>
        )}
        <div className="footer-actions">
          <button
            type="button"
            className="primary-button"
            title={!motionReady ? t("sidebar.motion.lockBeforeGenerateTracks", {
              tracks: unlockedMotionTracks.join(" / "),
            }) : undefined}
            onClick={onGenerate}
            disabled={!modelStats || processing || modelLoading || !motionReady}
          >
            {generationMode === "solid" ? <Boxes size={16} /> : <Sparkles size={16} />}
            {modelLoading ? t("sidebar.importing") : processing ? t("sidebar.generating") : generationMode === "solid" ? t("sidebar.generateSolid") : t("sidebar.generateHologram")}
          </button>
          <button type="button" className="export-button" onClick={onExport} disabled={!stats || processing || modelLoading || exporting}>
            {exporting ? t("sidebar.packaging") : t("sidebar.export")}
          </button>
        </div>
      </div>
    </aside>
  );
}

export type { ImportedAsset };
