import * as THREE from "three";
import {
  choosePrimaryMmdModel,
  expandMmdAssets,
  findMmdModelByPath,
  inspectMmdModels,
  normalizeAssetPath,
} from "../../src/core/mmdAssets.ts";
import { loadMmdModel } from "../../src/core/mmdModel.ts";
import {
  createMmdMeshSnapshot,
  releaseMmdMeshSnapshot,
} from "../../src/core/mmdSnapshot.ts";

const filesFromInput = (id) => {
  const input = document.getElementById(id);
  if (!(input instanceof HTMLInputElement) || !input.files?.length) {
    throw new Error(`Audit input ${id} is empty`);
  }
  return [...input.files];
};

const loadAuditModel = async (inputId = "model-files") => {
  const expanded = await expandMmdAssets(filesFromInput(inputId));
  const candidates = await inspectMmdModels(expanded);
  const modelFile = choosePrimaryMmdModel(expanded, candidates);
  if (!modelFile) throw new Error("Audit model package has no PMX or PMD file");
  const model = await loadMmdModel(expanded, modelFile);
  return { model, modelFile, candidates, expanded };
};

const errorPercentile = (values, percentile) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * percentile));
  return sorted[index] ?? 0;
};

const snapshotVertex = (snapshot, index, target) => target.set(
  snapshot.positions[index * 3],
  snapshot.positions[index * 3 + 1],
  snapshot.positions[index * 3 + 2],
);

const positiveWeightCount = (skinWeight, index) => {
  if (!skinWeight) return 0;
  return [
    skinWeight.getX(index),
    skinWeight.getY(index),
    skinWeight.getZ(index),
    skinWeight.getW(index),
  ].filter((weight) => Number.isFinite(weight) && weight > 1e-6).length;
};

const deformationDistribution = (mesh) => {
  const vertexCount = mesh.geometry.getAttribute("position").count;
  const skinWeight = mesh.geometry.getAttribute("skinWeight");
  const sdef = mesh.geometry.getAttribute("matricesSdefEnabled");
  const qdef = mesh.geometry.getAttribute("matricesQdefEnabled");
  const linearIndices = [];
  const linearWeightCounts = { bdef1: 0, bdef2: 0, bdef4: 0, other: 0 };
  let sdefCount = 0;
  let qdefCount = 0;
  for (let index = 0; index < vertexCount; index += 1) {
    if ((qdef?.getX(index) ?? 0) >= 0.5) qdefCount += 1;
    else if ((sdef?.getX(index) ?? 0) >= 0.5) sdefCount += 1;
    else {
      linearIndices.push(index);
      const weightCount = positiveWeightCount(skinWeight, index);
      if (weightCount === 1) linearWeightCounts.bdef1 += 1;
      else if (weightCount === 2) linearWeightCounts.bdef2 += 1;
      else if (weightCount === 3 || weightCount === 4) linearWeightCounts.bdef4 += 1;
      else linearWeightCounts.other += 1;
    }
  }
  return { vertexCount, linearIndices, linearWeightCounts, sdefCount, qdefCount };
};

const evenlySample = (indices, maximum) => {
  const count = Math.min(indices.length, maximum);
  if (count === indices.length) return [...indices];
  return Array.from({ length: count }, (_value, index) => (
    indices[Math.floor(index * indices.length / count)]
  ));
};

const activeMorphs = (mesh) => {
  const metadata = Array.isArray(mesh.userData.mmdMorphs) ? mesh.userData.mmdMorphs : [];
  return (mesh.morphTargetInfluences ?? []).flatMap((weight, index) => {
    if (!Number.isFinite(weight) || Math.abs(weight) <= 1e-6) return [];
    const morph = metadata[index] ?? {};
    return [{
      index,
      name: morph.name || morph.englishName || `morph_${index}`,
      englishName: morph.englishName || "",
      weight,
    }];
  });
};

const getManualMorphedPosition = (mesh, vertexIndex, target) => {
  const geometry = mesh.geometry;
  const position = geometry.getAttribute("position");
  target.fromBufferAttribute(position, vertexIndex);
  const morphPositions = geometry.morphAttributes.position;
  const influences = mesh.morphTargetInfluences;
  if (!morphPositions?.length || !influences) return target;

  const base = target.clone();
  const morph = new THREE.Vector3();
  for (let morphIndex = 0; morphIndex < morphPositions.length; morphIndex += 1) {
    const influence = influences[morphIndex] ?? 0;
    if (Math.abs(influence) <= 1e-12) continue;
    morph.fromBufferAttribute(morphPositions[morphIndex], vertexIndex);
    if (!geometry.morphTargetsRelative) morph.sub(base);
    target.addScaledVector(morph, influence);
  }
  return target;
};

const manuallyEvaluateLinearSkinning = (
  mesh,
  vertexIndex,
  boneMatrices,
  meshToRoot,
  target,
) => {
  const skinIndex = mesh.geometry.getAttribute("skinIndex");
  const skinWeight = mesh.geometry.getAttribute("skinWeight");
  getManualMorphedPosition(mesh, vertexIndex, target).applyMatrix4(mesh.bindMatrix);
  if (!skinIndex || !skinWeight) return target.applyMatrix4(mesh.bindMatrixInverse).applyMatrix4(meshToRoot);

  const source = target.clone();
  const transformed = new THREE.Vector3();
  target.set(0, 0, 0);
  const indices = [
    skinIndex.getX(vertexIndex),
    skinIndex.getY(vertexIndex),
    skinIndex.getZ(vertexIndex),
    skinIndex.getW(vertexIndex),
  ];
  const weights = [
    skinWeight.getX(vertexIndex),
    skinWeight.getY(vertexIndex),
    skinWeight.getZ(vertexIndex),
    skinWeight.getW(vertexIndex),
  ];
  for (let influence = 0; influence < 4; influence += 1) {
    const weight = weights[influence];
    if (!Number.isFinite(weight) || Math.abs(weight) <= 1e-12) continue;
    const matrix = boneMatrices[Math.round(indices[influence])];
    if (!matrix) throw new Error(`Vertex ${vertexIndex} references an invalid bone index`);
    target.addScaledVector(transformed.copy(source).applyMatrix4(matrix), weight);
  }
  return target.applyMatrix4(mesh.bindMatrixInverse).applyMatrix4(meshToRoot);
};

const errorAccumulator = () => ({ errors: [], squared: 0, maximum: 0 });

const addError = (accumulator, error) => {
  accumulator.errors.push(error);
  accumulator.squared += error * error;
  accumulator.maximum = Math.max(accumulator.maximum, error);
};

const errorSummary = (accumulator, sampleCount, kind) => ({
  kind,
  sampleCount,
  maximumError: accumulator.maximum,
  rmsError: Math.sqrt(accumulator.squared / Math.max(1, sampleCount)),
  p95Error: errorPercentile(accumulator.errors, 0.95),
  tolerance: 1e-4,
});

const snapshotDifference = (left, right) => {
  const count = Math.min(left.positions.length, right.positions.length) / 3;
  let changedVertices = 0;
  let maximum = 0;
  let squared = 0;
  for (let index = 0; index < count; index += 1) {
    const offset = index * 3;
    const error = Math.hypot(
      left.positions[offset] - right.positions[offset],
      left.positions[offset + 1] - right.positions[offset + 1],
      left.positions[offset + 2] - right.positions[offset + 2],
    );
    if (error > 1e-5) changedVertices += 1;
    maximum = Math.max(maximum, error);
    squared += error * error;
  }
  return {
    vertexCount: count,
    changedVertices,
    changedRatio: changedVertices / Math.max(1, count),
    maximum,
    rms: Math.sqrt(squared / Math.max(1, count)),
  };
};

const namedBoneStates = (model, names) => Object.fromEntries(names.map((name) => {
  const info = model.bones.find((bone) => bone.name === name || bone.englishName === name);
  const bone = info ? model.mesh.skeleton.bones[info.index] : undefined;
  return [name, bone ? {
    index: info.index,
    position: bone.position.toArray(),
    quaternion: bone.quaternion.toArray(),
  } : null];
}));

const runManualIkForModel = async (model) => {
  let beforeSnapshot;
  let afterSnapshot;
  try {
    const goal = model.bones.find((bone) => bone.isIkGoal);
    if (!goal) throw new Error("Audit model exposes no IK goal");
    const chain = (Array.isArray(model.mesh.userData.mmdIkChains)
      ? model.mesh.userData.mmdIkChains
      : []).find((candidate) => candidate.goalBoneIndex === goal.index);
    if (!chain) throw new Error("IK goal has no runtime chain");
    const linkedBoneIndices = chain.links.map((link) => link.boneIndex);
    const beforeRotations = linkedBoneIndices.map((index) => (
      model.mesh.skeleton.bones[index].quaternion.toArray()
    ));
    beforeSnapshot = await createMmdMeshSnapshot(model, { includeTextures: false });
    const changed = model.nudgeBone(goal.index, "x", model.translationStep * 4);
    afterSnapshot = await createMmdMeshSnapshot(model, { includeTextures: false });
    const afterRotations = linkedBoneIndices.map((index) => (
      model.mesh.skeleton.bones[index].quaternion.toArray()
    ));
    const changedLinks = afterRotations.filter((rotation, index) => rotation.some((value, component) => (
      Math.abs(value - beforeRotations[index][component]) > 1e-6
    ))).length;
    return {
      goal,
      changed,
      linkedBoneIndices,
      changedLinks,
      pose: model.exportMelyPose(),
      vertexDifference: snapshotDifference(beforeSnapshot, afterSnapshot),
    };
  } finally {
    if (beforeSnapshot) releaseMmdMeshSnapshot(beforeSnapshot);
    if (afterSnapshot) releaseMmdMeshSnapshot(afterSnapshot);
  }
};

window.__melyRunSnapshotAudit = async ({ sampleCount = 4096, targetFrame } = {}) => {
  const { model, modelFile, candidates } = await loadAuditModel();
  let restSnapshot;
  let posedSnapshot;
  try {
    const motionFiles = filesFromInput("motion-file");
    const motionInfo = await model.loadMotion(motionFiles[0]);
    restSnapshot = await createMmdMeshSnapshot(model, { includeTextures: false });
    const frame = Number.isFinite(targetFrame) ? targetFrame : motionInfo.maxFrame;
    model.updatePose(frame / motionInfo.frameRate);
    model.root.updateMatrixWorld(true);
    model.mesh.skeleton.update();
    posedSnapshot = await createMmdMeshSnapshot(model, { includeTextures: false });

    const distribution = deformationDistribution(model.mesh);
    const sampledIndices = evenlySample(distribution.linearIndices, sampleCount);
    const rootInverse = new THREE.Matrix4().copy(model.root.matrixWorld).invert();
    const meshToRoot = rootInverse.multiply(model.mesh.matrixWorld);
    const officialReference = new THREE.Vector3();
    const manualReference = new THREE.Vector3();
    const actual = new THREE.Vector3();
    const officialErrors = errorAccumulator();
    const manualErrors = errorAccumulator();
    const boneMatrices = model.mesh.skeleton.bones.map((bone, index) => (
      new THREE.Matrix4().multiplyMatrices(
        bone.matrixWorld,
        model.mesh.skeleton.boneInverses[index],
      )
    ));
    for (const index of sampledIndices) {
      model.mesh.getVertexPosition(index, officialReference).applyMatrix4(meshToRoot);
      manuallyEvaluateLinearSkinning(
        model.mesh,
        index,
        boneMatrices,
        meshToRoot,
        manualReference,
      );
      snapshotVertex(posedSnapshot, index, actual);
      addError(officialErrors, officialReference.distanceTo(actual));
      addError(manualErrors, manualReference.distanceTo(actual));
    }
    const rawIkChains = Array.isArray(model.mesh.userData.mmdIkChains)
      ? model.mesh.userData.mmdIkChains
      : [];
    return {
      model: {
        fileName: modelFile.name,
        name: model.stats.name,
        format: model.stats.format,
        stats: model.stats,
        candidates,
      },
      motion: motionInfo,
      deformation: {
        vertexCount: distribution.vertexCount,
        linearCount: distribution.linearIndices.length,
        linearWeightCounts: distribution.linearWeightCounts,
        sdefCount: distribution.sdefCount,
        qdefCount: distribution.qdefCount,
      },
      references: {
        three: errorSummary(
          officialErrors,
          sampledIndices.length,
          "THREE.SkinnedMesh.getVertexPosition",
        ),
        manualBdef: errorSummary(
          manualErrors,
          sampledIndices.length,
          "Explicit bind/morph/weighted-bone formula",
        ),
      },
      formulas: {
        morph: "p_morph = p_base + sum(influence_j * morph_delta_j)",
        bdef: "p_skin = bindMatrixInverse * sum(weight_i * boneMatrix_i * bindMatrix * p_morph)",
        rootSpace: "p_snapshot = inverse(rootWorld) * meshWorld * p_skin",
      },
      poseDifference: snapshotDifference(restSnapshot, posedSnapshot),
      activeMorphs: activeMorphs(model.mesh),
      ikChains: rawIkChains.map((chain) => ({
        goalBoneIndex: chain.goalBoneIndex,
        effectorBoneIndex: chain.effectorBoneIndex,
        linkCount: Array.isArray(chain.links) ? chain.links.length : 0,
      })),
    };
  } finally {
    if (restSnapshot) releaseMmdMeshSnapshot(restSnapshot);
    if (posedSnapshot) releaseMmdMeshSnapshot(posedSnapshot);
    model.dispose();
  }
};

window.__melyRunManualIkAudit = async () => {
  const { model, modelFile } = await loadAuditModel();
  try {
    const result = await runManualIkForModel(model);
    return {
      model: { fileName: modelFile.name, name: model.stats.name, format: model.stats.format },
      ...result,
    };
  } finally {
    model.dispose();
  }
};

window.__melyRunFixtureAudit = async () => {
  const { model, modelFile, candidates, expanded } = await loadAuditModel("folder-files");
  let primaryModel = model;
  let switchedModel;
  let frame0;
  let frame15;
  let frame30;
  try {
    const packagePaths = expanded.map((file) => normalizeAssetPath(file.webkitRelativePath || file.name));
    const motionFile = filesFromInput("complex-motion-file")[0];
    const motion = await primaryModel.loadMotion(motionFile);

    primaryModel.updatePose(0);
    frame0 = await createMmdMeshSnapshot(primaryModel, { includeTextures: false });
    const frame0State = {
      morphs: activeMorphs(primaryModel.mesh),
      bones: namedBoneStates(primaryModel, ["root", "upper", "lower", "ik_goal"]),
    };

    primaryModel.updatePose(15 / motion.frameRate);
    frame15 = await createMmdMeshSnapshot(primaryModel, { includeTextures: false });
    const frame15State = {
      morphs: activeMorphs(primaryModel.mesh),
      bones: namedBoneStates(primaryModel, ["root", "upper", "lower", "ik_goal"]),
    };

    primaryModel.updatePose(30 / motion.frameRate);
    frame30 = await createMmdMeshSnapshot(primaryModel, { includeTextures: false });
    const frame30State = {
      morphs: activeMorphs(primaryModel.mesh),
      bones: namedBoneStates(primaryModel, ["root", "upper", "lower", "ik_goal"]),
      pose: primaryModel.exportMelyPose(),
    };

    const frameDifferences = {
      frame0To15: snapshotDifference(frame0, frame15),
      frame15To30: snapshotDifference(frame15, frame30),
      frame0To30: snapshotDifference(frame0, frame30),
    };

    primaryModel.clearMotion();
    const manualIk = await runManualIkForModel(primaryModel);

    const accessoryCandidate = candidates.find((candidate) => /accessory\.pmd$/i.test(candidate.path));
    if (!accessoryCandidate) throw new Error("Fixture package has no accessory PMD candidate");
    const accessoryFile = findMmdModelByPath(expanded, accessoryCandidate.path);
    if (!accessoryFile) throw new Error("Accessory PMD candidate cannot be resolved to a File");
    switchedModel = await loadMmdModel(expanded, accessoryFile);
    primaryModel.dispose();
    primaryModel = null;

    return {
      package: {
        paths: packagePaths,
        candidateCount: candidates.length,
        candidates,
        primaryPath: normalizeAssetPath(modelFile.webkitRelativePath || modelFile.name),
      },
      primary: {
        fileName: modelFile.name,
        stats: model.stats,
        textureWarnings: model.textureWarnings,
      },
      motion,
      frames: {
        frame0: frame0State,
        frame15: frame15State,
        frame30: frame30State,
        differences: frameDifferences,
      },
      manualIk,
      switch: {
        selectedPath: accessoryCandidate.path,
        previousModelDisposed: true,
        stats: switchedModel.stats,
        textureWarnings: switchedModel.textureWarnings,
      },
    };
  } finally {
    if (frame0) releaseMmdMeshSnapshot(frame0);
    if (frame15) releaseMmdMeshSnapshot(frame15);
    if (frame30) releaseMmdMeshSnapshot(frame30);
    primaryModel?.dispose();
    switchedModel?.dispose();
  }
};

window.__melyAuditReady = true;
