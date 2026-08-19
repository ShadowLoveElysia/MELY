import * as THREE from "three";

export const THREE_MMD_OUTLINE_LAYER = 31;
export const THREE_MMD_SELECTION_OUTLINE_LAYER = 30;
export const THREE_MMD_SELECTION_OUTLINE_THICKNESS = 0.005;
export const THREE_MMD_SELECTION_OUTLINE_COLOR = [1, 0.58, 0.12] as const;

export interface ThreeMmdOutlineParameters {
  thickness: number;
  color: readonly [number, number, number];
  alpha: number;
  visible: boolean;
}

interface MaterialWithMmdOutline extends THREE.Material {
  alphaMap?: THREE.Texture | null;
  displacementBias?: number;
  displacementMap?: THREE.Texture | null;
  displacementScale?: number;
  fog?: boolean;
  map?: THREE.Texture | null;
  premultipliedAlpha: boolean;
  toneMapped: boolean;
  wireframe?: boolean;
}

export interface ThreeMmdOutlineMaterial extends THREE.ShaderMaterial {
  alphaMap: THREE.Texture | null;
  displacementMap: THREE.Texture | null;
  map: THREE.Texture | null;
}

export type ThreeMmdSdefAttributeContract = "canonical" | "moeru";

interface MoeruOutlineDescriptor {
  alpha?: number;
  color?: THREE.Color;
  visible?: boolean;
  width?: number;
}

interface MoeruMmdMaterial extends MaterialWithMmdOutline {
  applyMMDMaterialState?: (state: MoeruMmdMaterialState) => void;
  descriptor?: {
    outline?: MoeruOutlineDescriptor;
  };
  isMMDMaterial?: boolean;
}

interface MoeruMmdMaterialState {
  edgeAlpha?: number;
  edgeColor?: THREE.Color;
  edgeWidth?: number;
}

interface MoeruOutlineStateBridge {
  baseVisible: boolean;
  state: MoeruMmdMaterialState;
}

const OUTLINE_PARAMETERS_KEY = "outlineParameters";
const MELY_OUTLINE_PARAMETERS_KEY = "melyMmdOutlineParameters";
const OUTLINE_EPSILON = 1e-6;

const finiteOr = (value: unknown, fallback: number) => (
  typeof value === "number" && Number.isFinite(value) ? value : fallback
);

const colorTuple = (
  value: unknown,
  fallback: readonly [number, number, number] = [0, 0, 0],
): [number, number, number] => {
  if (value instanceof THREE.Color) return [value.r, value.g, value.b];
  if (!Array.isArray(value) || value.length < 3) return [...fallback];
  return [
    finiteOr(value[0], fallback[0]),
    finiteOr(value[1], fallback[1]),
    finiteOr(value[2], fallback[2]),
  ];
};

const normalizeOutlineParameters = (
  value: unknown,
): ThreeMmdOutlineParameters | null => {
  if (!value || typeof value !== "object") return null;
  const candidate = value as {
    thickness?: unknown;
    color?: unknown;
    alpha?: unknown;
    visible?: unknown;
  };
  const thickness = Math.max(0, finiteOr(candidate.thickness, 0));
  const alpha = THREE.MathUtils.clamp(finiteOr(candidate.alpha, 1), 0, 1);
  return {
    thickness,
    color: colorTuple(candidate.color),
    alpha,
    visible: candidate.visible === undefined ? thickness > 0 : candidate.visible === true,
  };
};

export const readThreeMmdOutlineParameters = (
  material: THREE.Material,
): ThreeMmdOutlineParameters | null => normalizeOutlineParameters(
  material.userData[MELY_OUTLINE_PARAMETERS_KEY]
  ?? material.userData[OUTLINE_PARAMETERS_KEY],
);

/**
 * Bridges Moeru's renderer-neutral descriptor to the shared Three outline
 * contract. Descriptor colors are already in Three's linear working space.
 */
export const adaptMoeruMmdOutlineParameters = (mesh: THREE.SkinnedMesh) => {
  const materials = (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) as MoeruMmdMaterial[];
  materials.forEach((material) => {
    const outline = material.descriptor?.outline;
    if (material.isMMDMaterial !== true || !outline) return;
    const thickness = Math.max(0, finiteOr(outline.width, 0));
    material.userData[MELY_OUTLINE_PARAMETERS_KEY] = {
      thickness,
      color: colorTuple(outline.color),
      alpha: THREE.MathUtils.clamp(finiteOr(outline.alpha, 1), 0, 1),
      visible: outline.visible === true && thickness > 0,
    } satisfies ThreeMmdOutlineParameters;

    const applyState = material.applyMMDMaterialState;
    if (!applyState || material.userData.melyMmdOutlineStateBridge) return;
    const bridge: MoeruOutlineStateBridge = {
      baseVisible: outline.visible === true,
      state: {},
    };
    material.applyMMDMaterialState = (state) => {
      applyState.call(material, state);
      bridge.state = state;
    };
    material.userData.melyMmdOutlineStateBridge = bridge;
  });
};

const syncMoeruOutlineState = (material: THREE.Material) => {
  const bridge = material.userData.melyMmdOutlineStateBridge as MoeruOutlineStateBridge | undefined;
  if (!bridge) return;
  const current = readThreeMmdOutlineParameters(material);
  const state = bridge.state;
  const thickness = Math.max(0, finiteOr(state.edgeWidth, current?.thickness ?? 0));
  const alpha = THREE.MathUtils.clamp(finiteOr(state.edgeAlpha, current?.alpha ?? 1), 0, 1);
  const color = colorTuple(state.edgeColor, current?.color);
  if (
    current
    && current.thickness === thickness
    && current.alpha === alpha
    && current.visible === (bridge.baseVisible && thickness > 0)
    && current.color.every((value, index) => value === color[index])
  ) return;
  material.userData[MELY_OUTLINE_PARAMETERS_KEY] = {
    thickness,
    color,
    alpha,
    visible: bridge.baseVisible && thickness > 0,
  } satisfies ThreeMmdOutlineParameters;
};

export const markThreeMmdOutlineSource = (mesh: THREE.SkinnedMesh) => {
  mesh.layers.enable(THREE_MMD_OUTLINE_LAYER);
};

const SDEF_DECLARATION = /* glsl */ `
#ifdef MELY_USE_SDEF
#ifdef USE_SKINNING
#ifdef MELY_SDEF_CANONICAL
attribute float matricesSdefEnabled;
attribute vec3 matricesSdefC;
attribute vec3 matricesSdefRW0;
attribute vec3 matricesSdefRW1;
#define MELY_SDEF_ENABLED matricesSdefEnabled
#define MELY_SDEF_C matricesSdefC
#define MELY_SDEF_RW0 matricesSdefRW0
#define MELY_SDEF_RW1 matricesSdefRW1
#else
attribute float mmdSdefMask;
attribute vec3 mmdSdefC;
attribute vec3 mmdSdefRW0;
attribute vec3 mmdSdefRW1;
#define MELY_SDEF_ENABLED mmdSdefMask
#define MELY_SDEF_C mmdSdefC
#define MELY_SDEF_RW0 mmdSdefRW0
#define MELY_SDEF_RW1 mmdSdefRW1
#endif

vec4 melyRotationMatrixToQuaternion( mat3 matrix ) {
  float trace = matrix[ 0 ][ 0 ] + matrix[ 1 ][ 1 ] + matrix[ 2 ][ 2 ];
  if ( trace > 0.0 ) {
    float s = 0.5 / sqrt( trace + 1.0 );
    return vec4( ( matrix[ 1 ][ 2 ] - matrix[ 2 ][ 1 ] ) * s, ( matrix[ 2 ][ 0 ] - matrix[ 0 ][ 2 ] ) * s, ( matrix[ 0 ][ 1 ] - matrix[ 1 ][ 0 ] ) * s, 0.25 / s );
  }
  if ( matrix[ 0 ][ 0 ] > matrix[ 1 ][ 1 ] && matrix[ 0 ][ 0 ] > matrix[ 2 ][ 2 ] ) {
    float s = 2.0 * sqrt( 1.0 + matrix[ 0 ][ 0 ] - matrix[ 1 ][ 1 ] - matrix[ 2 ][ 2 ] );
    return vec4( 0.25 * s, ( matrix[ 0 ][ 1 ] + matrix[ 1 ][ 0 ] ) / s, ( matrix[ 2 ][ 0 ] + matrix[ 0 ][ 2 ] ) / s, ( matrix[ 1 ][ 2 ] - matrix[ 2 ][ 1 ] ) / s );
  }
  if ( matrix[ 1 ][ 1 ] > matrix[ 2 ][ 2 ] ) {
    float s = 2.0 * sqrt( 1.0 + matrix[ 1 ][ 1 ] - matrix[ 0 ][ 0 ] - matrix[ 2 ][ 2 ] );
    return vec4( ( matrix[ 0 ][ 1 ] + matrix[ 1 ][ 0 ] ) / s, 0.25 * s, ( matrix[ 1 ][ 2 ] + matrix[ 2 ][ 1 ] ) / s, ( matrix[ 2 ][ 0 ] - matrix[ 0 ][ 2 ] ) / s );
  }
  float s = 2.0 * sqrt( 1.0 + matrix[ 2 ][ 2 ] - matrix[ 0 ][ 0 ] - matrix[ 1 ][ 1 ] );
  return vec4( ( matrix[ 2 ][ 0 ] + matrix[ 0 ][ 2 ] ) / s, ( matrix[ 1 ][ 2 ] + matrix[ 2 ][ 1 ] ) / s, 0.25 * s, ( matrix[ 0 ][ 1 ] - matrix[ 1 ][ 0 ] ) / s );
}

mat3 melyQuaternionToRotationMatrix( vec4 q ) {
  float xx = q.x * q.x; float yy = q.y * q.y; float zz = q.z * q.z;
  float xy = q.x * q.y; float zw = q.z * q.w; float zx = q.z * q.x;
  float yw = q.y * q.w; float yz = q.y * q.z; float xw = q.x * q.w;
  return mat3( 1.0 - 2.0 * ( yy + zz ), 2.0 * ( xy + zw ), 2.0 * ( zx - yw ), 2.0 * ( xy - zw ), 1.0 - 2.0 * ( zz + xx ), 2.0 * ( yz + xw ), 2.0 * ( zx + yw ), 2.0 * ( yz - xw ), 1.0 - 2.0 * ( yy + xx ) );
}

vec4 melySlerp( vec4 q0, vec4 q1, float t ) {
  float cosTheta = dot( q0, q1 );
  q1 = mix( -q1, q1, step( 0.0, cosTheta ) );
  cosTheta = abs( cosTheta );
  if ( cosTheta > 0.999999 ) return normalize( mix( q0, q1, t ) );
  float theta = acos( cosTheta );
  float sinTheta = sin( theta );
  return q0 * sin( ( 1.0 - t ) * theta ) / sinTheta + q1 * sin( t * theta ) / sinTheta;
}
#endif
#endif
`;

const SDEF_NORMAL_VERTEX = /* glsl */ `
#ifdef USE_SKINNING
  mat4 skinMatrix = mat4( 0.0 );
  skinMatrix += skinWeight.x * boneMatX;
  skinMatrix += skinWeight.y * boneMatY;
  skinMatrix += skinWeight.z * boneMatZ;
  skinMatrix += skinWeight.w * boneMatW;
  skinMatrix = bindMatrixInverse * skinMatrix * bindMatrix;
  vec3 linearNormal = vec4( skinMatrix * vec4( objectNormal, 0.0 ) ).xyz;
  #ifdef MELY_SDEF_CANONICAL
  mat4 normalBone0 = boneMatX;
  mat4 normalBone1 = boneMatY;
  #else
  mat4 normalBone0 = bindMatrixInverse * boneMatX * bindMatrix;
  mat4 normalBone1 = bindMatrixInverse * boneMatY * bindMatrix;
  #endif
  mat3 normalRotation = melyQuaternionToRotationMatrix( melySlerp( melyRotationMatrixToQuaternion( mat3( normalBone0 ) ), melyRotationMatrixToQuaternion( mat3( normalBone1 ) ), skinWeight.y ) );
  objectNormal = mix( linearNormal, normalRotation * objectNormal, step( 0.5, MELY_SDEF_ENABLED ) );
#endif
`;

const SDEF_POSITION_VERTEX = /* glsl */ `
#ifdef USE_SKINNING
  vec4 skinVertex = bindMatrix * vec4( transformed, 1.0 );
  vec4 skinned = vec4( 0.0 );
  skinned += boneMatX * skinVertex * skinWeight.x;
  skinned += boneMatY * skinVertex * skinWeight.y;
  skinned += boneMatZ * skinVertex * skinWeight.z;
  skinned += boneMatW * skinVertex * skinWeight.w;
  vec3 linearTransformed = ( bindMatrixInverse * skinned ).xyz;
  #ifdef MELY_SDEF_CANONICAL
  mat4 positionBone0 = boneMatX;
  mat4 positionBone1 = boneMatY;
  #else
  mat4 positionBone0 = bindMatrixInverse * boneMatX * bindMatrix;
  mat4 positionBone1 = bindMatrixInverse * boneMatY * bindMatrix;
  #endif
  mat3 positionRotation = melyQuaternionToRotationMatrix( melySlerp( melyRotationMatrixToQuaternion( mat3( positionBone0 ) ), melyRotationMatrixToQuaternion( mat3( positionBone1 ) ), skinWeight.y ) );
  vec3 positionOffset = ( positionBone0 * vec4( MELY_SDEF_RW0, 1.0 ) ).xyz * skinWeight.x + ( positionBone1 * vec4( MELY_SDEF_RW1, 1.0 ) ).xyz * skinWeight.y;
  #ifdef MELY_SDEF_CANONICAL
  vec3 sdefPosition = positionRotation * ( skinVertex.xyz - MELY_SDEF_C ) + positionOffset;
  vec3 sdefTransformed = ( bindMatrixInverse * vec4( sdefPosition, 1.0 ) ).xyz;
  #else
  vec3 sdefTransformed = positionRotation * ( transformed - MELY_SDEF_C ) + positionOffset;
  #endif
  transformed = mix( linearTransformed, sdefTransformed, step( 0.5, MELY_SDEF_ENABLED ) );
#endif
`;

export const MELY_MMD_OUTLINE_VERTEX_SHADER = /* glsl */ `
#include <common>
#include <uv_pars_vertex>
#include <displacementmap_pars_vertex>
#include <fog_pars_vertex>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
${SDEF_DECLARATION}
#include <logdepthbuf_pars_vertex>
#include <clipping_planes_pars_vertex>

uniform float outlineThickness;

vec4 calculateOutline( vec4 position, vec3 normal, vec3 deformedPosition ) {
  vec4 adjacent = projectionMatrix * modelViewMatrix * vec4( deformedPosition + normal, 1.0 );
  vec4 direction = normalize( position - adjacent );
  return position + direction * outlineThickness * position.w;
}

void main() {
  #include <uv_vertex>
  #include <beginnormal_vertex>
  #include <morphnormal_vertex>
  #include <skinbase_vertex>
  #ifdef MELY_USE_SDEF
    ${SDEF_NORMAL_VERTEX}
  #else
    #include <skinnormal_vertex>
  #endif
  #include <begin_vertex>
  #include <morphtarget_vertex>
  #ifdef MELY_USE_SDEF
    ${SDEF_POSITION_VERTEX}
  #else
    #include <skinning_vertex>
  #endif
  #include <displacementmap_vertex>
  #include <project_vertex>
  gl_Position = calculateOutline( gl_Position, -objectNormal, transformed );
  #include <logdepthbuf_vertex>
  #include <clipping_planes_vertex>
  #include <fog_vertex>
}
`;

export const MELY_MMD_OUTLINE_FRAGMENT_SHADER = /* glsl */ `
#include <common>
#include <uv_pars_fragment>
#include <map_pars_fragment>
#include <alphamap_pars_fragment>
#include <alphatest_pars_fragment>
#include <fog_pars_fragment>
#include <logdepthbuf_pars_fragment>
#include <clipping_planes_pars_fragment>

uniform vec3 outlineColor;
uniform float outlineAlpha;

void main() {
  #include <clipping_planes_fragment>
  #include <logdepthbuf_fragment>
  vec4 diffuseColor = vec4( 1.0 );
  #include <map_fragment>
  #include <alphamap_fragment>
  #include <alphatest_fragment>
  if ( diffuseColor.a <= 0.01 ) discard;
  gl_FragColor = vec4( outlineColor, outlineAlpha * diffuseColor.a );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
  #include <premultiplied_alpha_fragment>
}
`;

export const validateThreeMmdOutlineShaderChunks = () => {
  const missing = new Set<string>();
  const includePattern = /#include <([\w\d./]+)>/g;
  const visit = (source: string) => {
    for (const match of source.matchAll(includePattern)) {
      const name = match[1];
      const chunk = THREE.ShaderChunk[name as keyof typeof THREE.ShaderChunk];
      if (typeof chunk !== "string") missing.add(name);
    }
  };
  visit(MELY_MMD_OUTLINE_VERTEX_SHADER);
  visit(MELY_MMD_OUTLINE_FRAGMENT_SHADER);
  return [...missing];
};

const SDEF_ATTRIBUTE_CONTRACTS = [
  {
    contract: "canonical",
    enabled: "matricesSdefEnabled",
    required: ["matricesSdefEnabled", "matricesSdefC", "matricesSdefRW0", "matricesSdefRW1"],
  },
  {
    contract: "moeru",
    enabled: "mmdSdefMask",
    required: ["mmdSdefMask", "mmdSdefC", "mmdSdefRW0", "mmdSdefRW1"],
  },
] as const;

const inspectSdefAttributes = (mesh: THREE.SkinnedMesh) => {
  const attributes = SDEF_ATTRIBUTE_CONTRACTS.find(({ required }) => (
    required.every((name) => Boolean(mesh.geometry.getAttribute(name)))
  ));
  if (!attributes) return { contract: null, vertexCount: 0 } as const;
  const enabled = mesh.geometry.getAttribute(attributes.enabled);
  let count = 0;
  for (let index = 0; index < enabled.count; index += 1) {
    if (enabled.getX(index) >= 0.5) count += 1;
  }
  return { contract: attributes.contract, vertexCount: count } as const;
};

const materialList = (mesh: THREE.SkinnedMesh) => (
  (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) as MaterialWithMmdOutline[]
);

const textureUsesAlpha = (texture: THREE.Texture | null | undefined) => (
  Boolean(texture && (texture as THREE.Texture & { transparent?: boolean }).transparent)
);

const createOutlineMaterial = (
  source: MaterialWithMmdOutline,
  sdefContract: ThreeMmdSdefAttributeContract | null,
) => {
  const material = new THREE.ShaderMaterial({
    name: `MELY MMD outline: ${source.name || source.uuid}`,
    side: THREE.BackSide,
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsLib.common,
      THREE.UniformsLib.fog,
      THREE.UniformsLib.displacementmap,
      {
        outlineThickness: { value: 0 },
        outlineColor: { value: new THREE.Color() },
        outlineAlpha: { value: 1 },
      },
    ]),
    vertexShader: MELY_MMD_OUTLINE_VERTEX_SHADER,
    fragmentShader: MELY_MMD_OUTLINE_FRAGMENT_SHADER,
  }) as ThreeMmdOutlineMaterial;
  material.map = null;
  material.alphaMap = null;
  material.displacementMap = null;
  if (sdefContract) {
    material.defines = {
      MELY_USE_SDEF: 1,
      ...(sdefContract === "canonical" ? { MELY_SDEF_CANONICAL: 1 } : {}),
    };
  }
  return material;
};

interface ThreeOutlineStyle {
  thickness: number;
  color: readonly [number, number, number];
  alpha: number;
  visible: boolean;
}

const applyThreeOutlineMaterialSurface = (
  target: ThreeMmdOutlineMaterial,
  source: MaterialWithMmdOutline,
  style: ThreeOutlineStyle,
) => {
  const mapUsesAlpha = textureUsesAlpha(source.map);
  const previousProgramState = [
    Boolean(target.map),
    Boolean(target.alphaMap),
    target.alphaTest > 0,
    Boolean(target.displacementMap),
    target.fog,
    target.toneMapped,
    target.premultipliedAlpha,
    target.transparent,
  ].join(":");
  target.visible = Boolean(
    style.visible
    && style.thickness > OUTLINE_EPSILON
    && style.alpha > OUTLINE_EPSILON
    && source.visible
    && source.opacity > OUTLINE_EPSILON
    && source.depthTest
    && source.wireframe !== true
  );
  target.transparent = Boolean(
    source.transparent
    || source.opacity < 1
    || style.alpha < 1
    || mapUsesAlpha
  );
  target.depthTest = source.depthTest;
  target.depthWrite = source.depthWrite && !target.transparent;
  target.colorWrite = source.colorWrite;
  target.fog = source.fog === true;
  target.toneMapped = source.toneMapped;
  target.premultipliedAlpha = source.premultipliedAlpha;
  target.clippingPlanes = source.clippingPlanes;
  target.clipIntersection = source.clipIntersection;
  target.clipShadows = source.clipShadows;
  target.map = source.transparent
    || source.opacity < 1
    || source.alphaTest > 0
    || mapUsesAlpha
    ? source.map ?? null
    : null;
  target.alphaMap = source.alphaMap ?? null;
  target.alphaTest = source.alphaTest;
  target.displacementMap = source.displacementMap ?? null;
  target.uniforms.outlineThickness.value = style.thickness;
  target.uniforms.outlineColor.value.fromArray(style.color);
  target.uniforms.outlineAlpha.value = style.alpha * source.opacity;
  target.uniforms.opacity.value = source.opacity;
  target.uniforms.map.value = target.map;
  target.uniforms.alphaMap.value = target.alphaMap;
  target.uniforms.alphaTest.value = target.alphaTest;
  target.uniforms.displacementMap.value = target.displacementMap;
  target.uniforms.displacementScale.value = source.displacementScale ?? 1;
  target.uniforms.displacementBias.value = source.displacementBias ?? 0;
  if (target.map) {
    if (target.map.matrixAutoUpdate) target.map.updateMatrix();
    target.uniforms.mapTransform.value.copy(target.map.matrix);
  }
  if (target.alphaMap) {
    if (target.alphaMap.matrixAutoUpdate) target.alphaMap.updateMatrix();
    target.uniforms.alphaMapTransform.value.copy(target.alphaMap.matrix);
  }
  if (target.displacementMap) {
    if (target.displacementMap.matrixAutoUpdate) target.displacementMap.updateMatrix();
    target.uniforms.displacementMapTransform.value.copy(target.displacementMap.matrix);
  }
  const nextProgramState = [
    Boolean(target.map),
    Boolean(target.alphaMap),
    target.alphaTest > 0,
    Boolean(target.displacementMap),
    target.fog,
    target.toneMapped,
    target.premultipliedAlpha,
    target.transparent,
  ].join(":");
  if (previousProgramState !== nextProgramState) target.needsUpdate = true;
  target.uniformsNeedUpdate = true;
};

export const updateThreeMmdOutlineMaterial = (
  target: ThreeMmdOutlineMaterial,
  source: MaterialWithMmdOutline,
) => {
  const parameters = readThreeMmdOutlineParameters(source);
  applyThreeOutlineMaterialSurface(target, source, {
    thickness: parameters?.thickness ?? 0,
    color: parameters?.color ?? [0, 0, 0],
    alpha: parameters?.alpha ?? 0,
    visible: parameters?.visible === true,
  });
};

export const updateThreeMmdSelectionOutlineMaterial = (
  target: ThreeMmdOutlineMaterial,
  source: THREE.Material,
  selected: boolean,
) => {
  applyThreeOutlineMaterialSurface(target, source as MaterialWithMmdOutline, {
    thickness: THREE_MMD_SELECTION_OUTLINE_THICKNESS,
    color: THREE_MMD_SELECTION_OUTLINE_COLOR,
    alpha: 1,
    visible: selected,
  });
};

export const syncThreeMmdOutlineMaterials = (
  targets: readonly ThreeMmdOutlineMaterial[],
  sources: readonly THREE.Material[],
) => {
  sources.forEach(syncMoeruOutlineState);
  targets.forEach((material, index) => {
    const source = sources[index];
    if (source) updateThreeMmdOutlineMaterial(material, source as MaterialWithMmdOutline);
    else material.visible = false;
  });
};

export interface ThreeMmdOutlinePass {
  readonly mesh: THREE.SkinnedMesh;
  readonly outlineMesh: THREE.SkinnedMesh;
  readonly materials: readonly ThreeMmdOutlineMaterial[];
  readonly sdefVertexCount: number;
  readonly sdefAttributeContract: ThreeMmdSdefAttributeContract | null;
  dispose: () => void;
  render: (
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    sourceCamera: THREE.Camera,
  ) => void;
}

export interface ThreeMmdSelectionOutlinePass {
  readonly meshes: readonly THREE.SkinnedMesh[];
  readonly outlineMeshes: readonly THREE.SkinnedMesh[];
  readonly maskMeshes: readonly THREE.SkinnedMesh[];
  readonly materials: readonly ThreeMmdOutlineMaterial[];
  readonly maskMaterials: readonly ThreeMmdOutlineMaterial[];
  readonly sdefVertexCount: number;
  readonly sdefAttributeContracts: readonly (ThreeMmdSdefAttributeContract | null)[];
  dispose: () => void;
  render: (
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    sourceCamera: THREE.Camera,
    selectedMaterialIndex: number | null,
    hiddenMaterialIndices?: ReadonlySet<number>,
  ) => void;
}

interface ThreeSelectionOutlineEntry {
  sourceMesh: THREE.SkinnedMesh;
  sourceMaterials: MaterialWithMmdOutline[];
  canonicalMaterialIndices: readonly (number | null)[];
  outlineMesh: THREE.SkinnedMesh;
  outlineMaterials: ThreeMmdOutlineMaterial[];
  maskMesh: THREE.SkinnedMesh;
  maskMaterials: ThreeMmdOutlineMaterial[];
  sdefAttributeContract: ThreeMmdSdefAttributeContract | null;
  sdefVertexCount: number;
}

const isSkinnedMesh = (value: unknown): value is THREE.SkinnedMesh => Boolean(
  value
  && typeof value === "object"
  && (value as { isSkinnedMesh?: boolean }).isSkinnedMesh,
);

const selectionCanonicalMaterialIndices = (
  mesh: THREE.SkinnedMesh,
  materialCount: number,
) => {
  const splitIndex = mesh.userData.mmdMorphSplitBody?.materialIndex;
  const proxyIndex = mesh.userData.mmdMaterialRenderProxy?.materialIndex;
  const override = Number.isInteger(splitIndex)
    ? splitIndex as number
    : Number.isInteger(proxyIndex)
      ? proxyIndex as number
      : null;
  return Array.from({ length: materialCount }, (_, index) => override ?? index);
};

const createSelectionOutlineEntry = (mesh: THREE.SkinnedMesh): ThreeSelectionOutlineEntry => {
  const sourceMaterials = materialList(mesh);
  const sdefAttributes = inspectSdefAttributes(mesh);
  const sdefAttributeContract = sdefAttributes.vertexCount > 0 ? sdefAttributes.contract : null;
  const outlineMaterials = sourceMaterials.map((source) => (
    createOutlineMaterial(source, sdefAttributeContract)
  ));
  const maskMaterials = sourceMaterials.map((source) => (
    createOutlineMaterial(source, sdefAttributeContract)
  ));
  const outlineMesh = new THREE.SkinnedMesh(mesh.geometry, outlineMaterials);
  outlineMesh.name = "MELY MMD selection outline";
  outlineMesh.userData.melyMmdSelectionOutlineProxy = true;
  outlineMesh.bindMode = mesh.bindMode;
  outlineMesh.bind(mesh.skeleton, mesh.bindMatrix);
  outlineMesh.bindMatrixInverse.copy(mesh.bindMatrixInverse);
  outlineMesh.morphTargetInfluences = mesh.morphTargetInfluences;
  outlineMesh.morphTargetDictionary = mesh.morphTargetDictionary;
  outlineMesh.frustumCulled = mesh.frustumCulled;
  outlineMesh.matrixAutoUpdate = false;
  outlineMesh.matrixWorldAutoUpdate = false;
  outlineMesh.layers.set(THREE_MMD_SELECTION_OUTLINE_LAYER);
  const maskMesh = new THREE.SkinnedMesh(mesh.geometry, maskMaterials);
  maskMesh.name = "MELY MMD selection stencil mask";
  maskMesh.userData.melyMmdSelectionOutlineProxy = true;
  maskMesh.bindMode = mesh.bindMode;
  maskMesh.bind(mesh.skeleton, mesh.bindMatrix);
  maskMesh.bindMatrixInverse.copy(mesh.bindMatrixInverse);
  maskMesh.morphTargetInfluences = mesh.morphTargetInfluences;
  maskMesh.morphTargetDictionary = mesh.morphTargetDictionary;
  maskMesh.frustumCulled = mesh.frustumCulled;
  maskMesh.matrixAutoUpdate = false;
  maskMesh.matrixWorldAutoUpdate = false;
  maskMesh.layers.set(THREE_MMD_SELECTION_OUTLINE_LAYER);
  return {
    sourceMesh: mesh,
    sourceMaterials,
    canonicalMaterialIndices: selectionCanonicalMaterialIndices(mesh, sourceMaterials.length),
    outlineMesh,
    outlineMaterials,
    maskMesh,
    maskMaterials,
    sdefAttributeContract,
    sdefVertexCount: sdefAttributes.vertexCount,
  };
};

const copyOutlineCamera = (
  previous: THREE.Camera | null,
  source: THREE.Camera,
  layer: number,
) => {
  const camera = !previous || previous.type !== source.type ? source.clone() : previous;
  if (camera === previous) camera.copy(source, false);
  camera.layers.set(layer);
  camera.matrixWorld.copy(source.matrixWorld);
  camera.matrixWorldInverse.copy(source.matrixWorldInverse);
  camera.projectionMatrix.copy(source.projectionMatrix);
  camera.projectionMatrixInverse.copy(source.projectionMatrixInverse);
  return camera;
};

const hierarchyIsVisible = (object: THREE.Object3D) => {
  let current: THREE.Object3D | null = object;
  while (current) {
    if (!current.visible) return false;
    current = current.parent;
  }
  return true;
};

/**
 * Creates a selection-only hull pass without touching source mesh layers. It
 * can coexist with the native MMD outline and has an independent lifecycle.
 */
export const createThreeMmdSelectionOutlinePass = (
  meshes: readonly THREE.SkinnedMesh[],
): ThreeMmdSelectionOutlinePass => {
  const uniqueMeshes = [...new Map(
    meshes.filter(isSkinnedMesh).map((mesh) => [mesh.uuid, mesh]),
  ).values()];
  const entries = uniqueMeshes.map(createSelectionOutlineEntry);
  const outlineScene = new THREE.Scene();
  outlineScene.matrixWorldAutoUpdate = false;
  entries.forEach((entry) => outlineScene.add(entry.outlineMesh));
  const maskScene = new THREE.Scene();
  maskScene.matrixWorldAutoUpdate = false;
  entries.forEach((entry) => maskScene.add(entry.maskMesh));
  let outlineCamera: THREE.Camera | null = null;
  let disposed = false;

  return {
    meshes: uniqueMeshes,
    outlineMeshes: entries.map((entry) => entry.outlineMesh),
    maskMeshes: entries.map((entry) => entry.maskMesh),
    materials: entries.flatMap((entry) => entry.outlineMaterials),
    maskMaterials: entries.flatMap((entry) => entry.maskMaterials),
    sdefVertexCount: entries.reduce((count, entry) => count + entry.sdefVertexCount, 0),
    sdefAttributeContracts: entries.map((entry) => entry.sdefAttributeContract),
    render: (
      renderer,
      scene,
      sourceCamera,
      selectedMaterialIndex,
      hiddenMaterialIndices = new Set<number>(),
    ) => {
      if (disposed) return;
      if (selectedMaterialIndex === null || hiddenMaterialIndices.has(selectedMaterialIndex)) {
        entries.forEach((entry) => {
          entry.outlineMaterials.forEach((material) => {
            material.visible = false;
          });
          entry.maskMaterials.forEach((material) => {
            material.visible = false;
          });
        });
        return;
      }
      let hasVisibleSelection = false;
      entries.forEach((entry) => {
        const {
          sourceMesh,
          sourceMaterials,
          outlineMesh,
          outlineMaterials,
          maskMesh,
          maskMaterials,
        } = entry;
        const hierarchyVisible = Boolean(sourceMesh.parent) && hierarchyIsVisible(sourceMesh);
        outlineMaterials.forEach((material, index) => {
          const selected = hierarchyVisible
            && entry.canonicalMaterialIndices[index] === selectedMaterialIndex;
          updateThreeMmdSelectionOutlineMaterial(material, sourceMaterials[index], selected);
          material.side = THREE.DoubleSide;
          material.depthWrite = false;
          material.stencilWrite = true;
          material.stencilWriteMask = 0;
          material.stencilFunc = THREE.NotEqualStencilFunc;
          material.stencilRef = 1;
          material.stencilFuncMask = 0xff;
          material.stencilFail = THREE.KeepStencilOp;
          material.stencilZFail = THREE.KeepStencilOp;
          material.stencilZPass = THREE.KeepStencilOp;

          const maskMaterial = maskMaterials[index];
          updateThreeMmdSelectionOutlineMaterial(maskMaterial, sourceMaterials[index], selected);
          maskMaterial.uniforms.outlineThickness.value = 0;
          maskMaterial.side = THREE.DoubleSide;
          maskMaterial.colorWrite = false;
          maskMaterial.depthWrite = false;
          maskMaterial.stencilWrite = true;
          maskMaterial.stencilWriteMask = 0xff;
          maskMaterial.stencilFunc = THREE.AlwaysStencilFunc;
          maskMaterial.stencilRef = 1;
          maskMaterial.stencilFuncMask = 0xff;
          maskMaterial.stencilFail = THREE.KeepStencilOp;
          maskMaterial.stencilZFail = THREE.KeepStencilOp;
          maskMaterial.stencilZPass = THREE.ReplaceStencilOp;
          hasVisibleSelection ||= material.visible;
        });
        outlineMesh.matrixWorld.copy(sourceMesh.matrixWorld);
        outlineMesh.bindMatrix.copy(sourceMesh.bindMatrix);
        outlineMesh.bindMatrixInverse.copy(sourceMesh.bindMatrixInverse);
        outlineMesh.morphTargetInfluences = sourceMesh.morphTargetInfluences;
        outlineMesh.visible = hierarchyVisible;
        maskMesh.matrixWorld.copy(sourceMesh.matrixWorld);
        maskMesh.bindMatrix.copy(sourceMesh.bindMatrix);
        maskMesh.bindMatrixInverse.copy(sourceMesh.bindMatrixInverse);
        maskMesh.morphTargetInfluences = sourceMesh.morphTargetInfluences;
        maskMesh.visible = hierarchyVisible;
      });
      if (!hasVisibleSelection) return;

      outlineCamera = copyOutlineCamera(
        outlineCamera,
        sourceCamera,
        THREE_MMD_SELECTION_OUTLINE_LAYER,
      );
      const previousAutoClear = renderer.autoClear;
      const previousBackground = outlineScene.background;
      const previousMaskBackground = maskScene.background;
      const previousFog = outlineScene.fog;
      const previousMaskFog = maskScene.fog;
      const previousShadowMap = renderer.shadowMap.enabled;
      outlineScene.background = null;
      maskScene.background = null;
      outlineScene.fog = scene.fog;
      maskScene.fog = scene.fog;
      renderer.autoClear = false;
      renderer.shadowMap.enabled = false;
      try {
        renderer.clearStencil();
        renderer.render(maskScene, outlineCamera);
        renderer.render(outlineScene, outlineCamera);
        renderer.clearStencil();
      } finally {
        renderer.shadowMap.enabled = previousShadowMap;
        renderer.autoClear = previousAutoClear;
        outlineScene.background = previousBackground;
        maskScene.background = previousMaskBackground;
        outlineScene.fog = previousFog;
        maskScene.fog = previousMaskFog;
      }
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      entries.forEach((entry) => {
        outlineScene.remove(entry.outlineMesh);
        maskScene.remove(entry.maskMesh);
        entry.outlineMaterials.forEach((material) => material.dispose());
        entry.maskMaterials.forEach((material) => material.dispose());
        entry.outlineMesh.material = [];
        entry.maskMesh.material = [];
      });
    },
  };
};

export const createThreeMmdOutlinePass = (
  mesh: THREE.SkinnedMesh,
): ThreeMmdOutlinePass => {
  const sourceLayerMask = mesh.layers.mask;
  markThreeMmdOutlineSource(mesh);
  const sources = materialList(mesh);
  const sdefAttributes = inspectSdefAttributes(mesh);
  const sdefVertexCount = sdefAttributes.vertexCount;
  const sdefAttributeContract = sdefVertexCount > 0 ? sdefAttributes.contract : null;
  const materials = sources.map((source) => createOutlineMaterial(source, sdefAttributeContract));
  const outlineMesh = new THREE.SkinnedMesh(mesh.geometry, materials);
  outlineMesh.name = "MELY MMD source outline";
  outlineMesh.bindMode = mesh.bindMode;
  outlineMesh.bind(mesh.skeleton, mesh.bindMatrix);
  outlineMesh.bindMatrixInverse.copy(mesh.bindMatrixInverse);
  outlineMesh.morphTargetInfluences = mesh.morphTargetInfluences;
  outlineMesh.morphTargetDictionary = mesh.morphTargetDictionary;
  outlineMesh.frustumCulled = mesh.frustumCulled;
  outlineMesh.matrixAutoUpdate = false;
  outlineMesh.matrixWorldAutoUpdate = false;
  outlineMesh.layers.set(THREE_MMD_OUTLINE_LAYER);

  const outlineScene = new THREE.Scene();
  outlineScene.matrixWorldAutoUpdate = false;
  outlineScene.add(outlineMesh);
  let outlineCamera: THREE.Camera | null = null;
  let disposed = false;

  return {
    mesh,
    outlineMesh,
    materials,
    sdefVertexCount,
    sdefAttributeContract,
    render: (renderer, scene, sourceCamera) => {
      if (disposed || !mesh.visible || !mesh.parent || !mesh.parent.visible) return;
      syncThreeMmdOutlineMaterials(materials, sources);
      if (!materials.some((material) => material.visible)) return;

      outlineMesh.matrixWorld.copy(mesh.matrixWorld);
      outlineMesh.bindMatrix.copy(mesh.bindMatrix);
      outlineMesh.bindMatrixInverse.copy(mesh.bindMatrixInverse);
      outlineMesh.morphTargetInfluences = mesh.morphTargetInfluences;
      outlineMesh.visible = mesh.visible;
      if (!outlineCamera || outlineCamera.type !== sourceCamera.type) {
        outlineCamera = sourceCamera.clone();
      } else {
        outlineCamera.copy(sourceCamera, false);
      }
      outlineCamera.layers.set(THREE_MMD_OUTLINE_LAYER);
      outlineCamera.matrixWorld.copy(sourceCamera.matrixWorld);
      outlineCamera.matrixWorldInverse.copy(sourceCamera.matrixWorldInverse);
      outlineCamera.projectionMatrix.copy(sourceCamera.projectionMatrix);
      outlineCamera.projectionMatrixInverse.copy(sourceCamera.projectionMatrixInverse);

      const previousAutoClear = renderer.autoClear;
      const previousBackground = outlineScene.background;
      const previousFog = outlineScene.fog;
      const previousShadowMap = renderer.shadowMap.enabled;
      outlineScene.background = null;
      outlineScene.fog = scene.fog;
      renderer.autoClear = false;
      renderer.shadowMap.enabled = false;
      try {
        renderer.render(outlineScene, outlineCamera);
      } finally {
        renderer.shadowMap.enabled = previousShadowMap;
        renderer.autoClear = previousAutoClear;
        outlineScene.background = previousBackground;
        outlineScene.fog = previousFog;
      }
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      mesh.layers.mask = sourceLayerMask;
      outlineScene.remove(outlineMesh);
      materials.forEach((material) => material.dispose());
      outlineMesh.material = [];
    },
  };
};
