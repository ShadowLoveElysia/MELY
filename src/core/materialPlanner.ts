export const SHULKER_BOX_SLOTS = 27;
export const LARGE_CHEST_SLOTS = 54;

export type MaterialCategory = "structure" | "lighting" | "glass" | "decoration" | "support";

export interface MaterialRequirementInput {
  blockId: string;
  count: number;
  stackSize?: number;
  category?: MaterialCategory;
}

export interface MaterialRequirement {
  blockId: string;
  count: number;
  stackSize: number;
  category: MaterialCategory;
  shulkerBoxes: number;
  stacks: number;
  looseItems: number;
  storageSlots: number;
}

export interface ChestAllocation {
  blockId: string;
  category: MaterialCategory;
  startSlot: number;
  slotCount: number;
  itemCount: number;
  fullStacks: number;
  looseItems: number;
}

export interface ChestPlan {
  index: number;
  usedSlots: number;
  freeSlots: number;
  allocations: ChestAllocation[];
}

export interface MaterialPlan {
  requirements: MaterialRequirement[];
  chests: ChestPlan[];
  totalBlocks: number;
  totalStorageSlots: number;
  totalLargeChests: number;
  totalShulkerBoxes: number;
}

const positiveInteger = (value: number, fallback: number) => {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value));
};

const normalizeBlockId = (blockId: string) => {
  const normalized = blockId.normalize("NFKC").trim().toLowerCase();
  if (!normalized) throw new Error("Material block id must not be empty");
  return normalized.includes(":") ? normalized : `minecraft:${normalized}`;
};

const requirementFor = (
  blockId: string,
  count: number,
  stackSize: number,
  category: MaterialCategory,
): MaterialRequirement => {
  const shulkerCapacity = stackSize * SHULKER_BOX_SLOTS;
  const shulkerBoxes = Math.floor(count / shulkerCapacity);
  const afterShulkers = count - shulkerBoxes * shulkerCapacity;
  const stacks = Math.floor(afterShulkers / stackSize);
  const looseItems = afterShulkers - stacks * stackSize;
  return {
    blockId,
    count,
    stackSize,
    category,
    shulkerBoxes,
    stacks,
    looseItems,
    storageSlots: Math.ceil(count / stackSize),
  };
};

export const summarizeMaterials = (
  inputs: readonly MaterialRequirementInput[],
): MaterialRequirement[] => {
  const merged = new Map<string, {
    count: number;
    stackSize: number;
    category: MaterialCategory;
    order: number;
  }>();

  inputs.forEach((input, order) => {
    const count = Math.max(0, Math.floor(Number.isFinite(input.count) ? input.count : 0));
    if (count === 0) return;
    const blockId = normalizeBlockId(input.blockId);
    const stackSize = positiveInteger(input.stackSize ?? 64, 64);
    const category = input.category ?? "structure";
    const current = merged.get(blockId);
    if (!current) {
      merged.set(blockId, { count, stackSize, category, order });
      return;
    }
    if (current.stackSize !== stackSize) {
      throw new Error(`Conflicting stack sizes for ${blockId}`);
    }
    current.count += count;
    if (current.category === "structure" && category !== "structure") current.category = category;
  });

  return [...merged.entries()]
    .sort((left, right) => left[1].order - right[1].order)
    .map(([blockId, value]) => requirementFor(
      blockId,
      value.count,
      value.stackSize,
      value.category,
    ));
};

export const createChestPlan = (
  requirements: readonly MaterialRequirement[],
): ChestPlan[] => {
  const chests: ChestPlan[] = [];
  let chest: ChestPlan | undefined;

  const ensureChest = (category: MaterialCategory) => {
    const chestCategory = chest?.allocations[0]?.category;
    if (!chest || chest.usedSlots >= LARGE_CHEST_SLOTS || chestCategory !== category) {
      chest = {
        index: chests.length + 1,
        usedSlots: 0,
        freeSlots: LARGE_CHEST_SLOTS,
        allocations: [],
      };
      chests.push(chest);
    }
    return chest;
  };

  for (const requirement of requirements) {
    let remainingItems = requirement.count;
    while (remainingItems > 0) {
      const target = ensureChest(requirement.category);
      const availableSlots = LARGE_CHEST_SLOTS - target.usedSlots;
      const requiredSlots = Math.ceil(remainingItems / requirement.stackSize);
      const slotCount = Math.min(availableSlots, requiredSlots);
      const itemCount = Math.min(remainingItems, slotCount * requirement.stackSize);
      const fullStacks = Math.floor(itemCount / requirement.stackSize);
      const looseItems = itemCount - fullStacks * requirement.stackSize;
      target.allocations.push({
        blockId: requirement.blockId,
        category: requirement.category,
        startSlot: target.usedSlots + 1,
        slotCount,
        itemCount,
        fullStacks,
        looseItems,
      });
      target.usedSlots += slotCount;
      target.freeSlots = LARGE_CHEST_SLOTS - target.usedSlots;
      remainingItems -= itemCount;
    }
  }

  return chests;
};

export const createMaterialPlan = (
  inputs: readonly MaterialRequirementInput[],
): MaterialPlan => {
  const requirements = summarizeMaterials(inputs);
  const chests = createChestPlan(requirements);
  return {
    requirements,
    chests,
    totalBlocks: requirements.reduce((sum, requirement) => sum + requirement.count, 0),
    totalStorageSlots: requirements.reduce((sum, requirement) => sum + requirement.storageSlots, 0),
    totalLargeChests: chests.length,
    totalShulkerBoxes: requirements.reduce((sum, requirement) => sum + requirement.shulkerBoxes, 0),
  };
};
