import * as THREE from "three";

export const THREE_MMD_OUTLINE_LAYER = 31;

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

export const updateThreeMmdOutlineMaterial = (
  target: ThreeMmdOutlineMaterial,
  source: MaterialWithMmdOutline,
) => {
  const parameters = readThreeMmdOutlineParameters(source);
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
  const outlineVisible = Boolean(
    source.visible
    && parameters?.visible
    && parameters.thickness > OUTLINE_EPSILON
    && parameters.alpha > OUTLINE_EPSILON
    && source.opacity > OUTLINE_EPSILON
    && source.depthTest
    && source.wireframe !== true
  );
  target.visible = outlineVisible;
  target.transparent = Boolean(
    source.transparent
    || source.opacity < 1
    || (parameters?.alpha ?? 1) < 1
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
  target.uniforms.outlineThickness.value = parameters?.thickness ?? 0;
  target.uniforms.outlineColor.value.fromArray(parameters?.color ?? [0, 0, 0]);
  target.uniforms.outlineAlpha.value = (parameters?.alpha ?? 0) * source.opacity;
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
