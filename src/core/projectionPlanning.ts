import type { ProjectionDocument } from "../types";
import { DEFAULT_LOCALE, translate, type LocaleCode, type TranslationKey } from "../i18n";
import { getBlockDefinition } from "./blockRegistry";
import { createMaterialPlan, type MaterialPlan, type MaterialRequirementInput } from "./materialPlanner";
import { countProjectionMaterials, splitProjectionViews } from "./projectionDocument";

export interface ProjectionPlanningOptions {
  includeSupportBlocks?: boolean;
  supportBlockId?: string;
  supportBlockCount?: number;
  splitSize?: number | [number, number, number];
}

export interface ProjectionPartGuide {
  name: string;
  index: [number, number, number];
  origin: [number, number, number];
  dimensions: [number, number, number];
  blockCount: number;
  placement: string;
}

export interface ProjectionEngineeringPlan {
  materialPlan: MaterialPlan;
  parts: ProjectionPartGuide[];
  totalBlocks: number;
  dimensions: [number, number, number];
  placement: {
    modelHeight: number;
    recommendedBottomY: number;
    highestOccupiedY: number;
    targetDimensionMinY: number | null;
    targetDimensionMaxY: number | null;
    disclaimer: string;
  };
}

const partName = (index: readonly number[]) =>
  `part_y${index[1]}_z${index[2]}_x${index[0]}`;

export const materialInputsFromProjection = (
  document: ProjectionDocument,
  options: ProjectionPlanningOptions = {},
): MaterialRequirementInput[] => {
  const inputs = countProjectionMaterials(document).map(({ state, count }) => {
    const definition = getBlockDefinition(state.blockId);
    return {
      blockId: state.blockId,
      count,
      stackSize: definition.stackSize || 64,
      category: definition.use,
    } satisfies MaterialRequirementInput;
  });
  if (options.includeSupportBlocks && (options.supportBlockCount ?? 0) > 0) {
    const support = getBlockDefinition(options.supportBlockId ?? "minecraft:cobblestone");
    inputs.push({
      blockId: support.canonicalId,
      count: Math.floor(options.supportBlockCount ?? 0),
      stackSize: support.stackSize || 64,
      category: "support",
    });
  }
  return inputs;
};

export const createProjectionEngineeringPlan = (
  document: ProjectionDocument,
  options: ProjectionPlanningOptions = {},
): ProjectionEngineeringPlan => {
  if (!document.bounds) {
    return {
      materialPlan: createMaterialPlan([]),
      parts: [],
      totalBlocks: 0,
      dimensions: [0, 0, 0],
      placement: {
        modelHeight: 0,
        recommendedBottomY: 0,
        highestOccupiedY: -1,
        targetDimensionMinY: null,
        targetDimensionMaxY: null,
        disclaimer: "",
      },
    };
  }
  const views = splitProjectionViews(document, options.splitSize ?? 32);
  const javaHeightMetadata = document.edition === "java";
  const parts = views.map((view): ProjectionPartGuide => {
    const name = partName(view.index);
    const origin = [...view.bounds.min] as [number, number, number];
    return {
      name,
      index: [...view.index],
      origin,
      dimensions: [...view.bounds.dimensions],
      blockCount: view.blockCount,
      placement: `${name}: X=${origin[0]}, Y=${origin[1]}, Z=${origin[2]}`,
    };
  });
  return {
    materialPlan: createMaterialPlan(materialInputsFromProjection(document, options)),
    parts,
    totalBlocks: document.blockCount,
    dimensions: [...document.bounds.dimensions],
    placement: {
      modelHeight: document.bounds.dimensions[1],
      recommendedBottomY: document.bounds.min[1],
      highestOccupiedY: document.bounds.max[1],
      targetDimensionMinY: javaHeightMetadata
        && typeof document.metadata?.targetDimensionMinY === "number"
        ? document.metadata.targetDimensionMinY
        : null,
      targetDimensionMaxY: javaHeightMetadata
        && typeof document.metadata?.targetDimensionMaxY === "number"
        ? document.metadata.targetDimensionMaxY
        : null,
      disclaimer: javaHeightMetadata && typeof document.metadata?.heightDisclaimer === "string"
        ? document.metadata.heightDisclaimer
        : "",
    },
  };
};

export const serializeEngineeringPlanJson = (plan: ProjectionEngineeringPlan) =>
  JSON.stringify({ generator: "MELY", version: 1, ...plan }, null, 2);

export const serializeEngineeringPlanText = (
  plan: ProjectionEngineeringPlan,
  locale: LocaleCode = DEFAULT_LOCALE,
) => {
  const t = (key: TranslationKey, params: Record<string, string | number> = {}) => (
    translate(locale, key, params)
  );
  const number = new Intl.NumberFormat(locale);
  const lines = [
    t("export.guide.readmeTitle"),
    t("export.guide.blockCount", { count: number.format(plan.totalBlocks) }),
    t("export.guide.dimensions", { dimensions: plan.dimensions.join(" x ") }),
    `Placement Y: ${plan.placement.recommendedBottomY}..${plan.placement.highestOccupiedY}`,
    t("export.guide.largeChests", { count: number.format(plan.materialPlan.totalLargeChests) }),
    t("export.guide.shulkerBoxes", { count: number.format(plan.materialPlan.totalShulkerBoxes) }),
    "",
    t("export.guide.materialsTitle"),
  ];
  for (const material of plan.materialPlan.requirements) {
    lines.push(t("export.guide.materialLine", {
      block: material.blockId,
      category: t(`survival.category.${material.category}` as TranslationKey),
      count: number.format(material.count),
      shulkers: number.format(material.shulkerBoxes),
      stacks: number.format(material.stacks),
      loose: number.format(material.looseItems),
    }));
  }
  lines.push("", t("export.guide.partsTitle"));
  plan.parts.forEach((part) => lines.push(t("export.guide.partLine", {
    id: part.name,
    origin: part.origin.join(" "),
    offset: part.origin.join(" "),
    blocks: number.format(part.blockCount),
  })));
  return lines.join("\n");
};
