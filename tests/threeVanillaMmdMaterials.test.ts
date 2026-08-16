import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import {
  calibrateVanillaMmdMaterials,
  captureVanillaMmdLoaderTextures,
  patchVanillaMmdSphereFragmentShader,
  VANILLA_MMD_COLOR_CALIBRATION_VERSION,
} from "../src/core/threeVanillaMmdMaterials.ts";

const expectedSrgb = (values: readonly [number, number, number]) => (
  new THREE.Color().setRGB(values[0], values[1], values[2], THREE.SRGBColorSpace)
);

const assertColor = (actual: THREE.Color, expected: THREE.Color, epsilon = 1e-12) => {
  assert.ok(Math.abs(actual.r - expected.r) < epsilon);
  assert.ok(Math.abs(actual.g - expected.g) < epsilon);
  assert.ok(Math.abs(actual.b - expected.b) < epsilon);
};

const meshWith = (materials: THREE.Material | THREE.Material[]) => (
  new THREE.SkinnedMesh(new THREE.BufferGeometry(), materials)
);

test("vanilla MMD calibration converts diffuse and ambient inputs exactly once", () => {
  const material = new THREE.MeshToonMaterial({
    color: new THREE.Color(0.8, 0.4, 0.2),
    emissive: new THREE.Color(0.3, 0.2, 0.1),
    opacity: 0.42,
    transparent: true,
    visible: false,
  });
  const mmdMaterial = {
    name: "parser material",
    diffuse: [0.8, 0.4, 0.2, 0.42],
    ambient: [0.3, 0.2, 0.1],
  };
  material.userData.keep = { source: "parser" };
  material.userData.mmdMaterial = mmdMaterial;
  const metadata = [{
    diffuse: [0.8, 0.4, 0.2, 0.42],
    ambient: [0.3, 0.2, 0.1],
  }] as const;
  const metadataBefore = structuredClone(metadata);
  const mesh = meshWith(material);

  calibrateVanillaMmdMaterials(mesh, metadata);
  const firstColor = material.color.clone();
  const firstEmissive = material.emissive.clone();
  const firstVersion = material.version;

  assertColor(material.color, expectedSrgb([0.8, 0.4, 0.2]));
  assertColor(material.emissive, expectedSrgb([0.3, 0.2, 0.1]));
  assert.equal(material.opacity, 0.42);
  assert.equal(material.transparent, true);
  assert.equal(material.visible, false);
  assert.deepEqual(material.userData.keep, { source: "parser" });
  assert.equal(material.userData.mmdMaterial, mmdMaterial);
  assert.deepEqual(material.userData.mmdMaterial, {
    name: "parser material",
    diffuse: [0.8, 0.4, 0.2, 0.42],
    ambient: [0.3, 0.2, 0.1],
  });
  assert.deepEqual(material.userData.melyVanillaMmdColorCalibration, {
    version: VANILLA_MMD_COLOR_CALIBRATION_VERSION,
    colorTextureSlots: [],
  });
  assert.deepEqual(metadata, metadataBefore);

  calibrateVanillaMmdMaterials(mesh, metadata);
  assertColor(material.color, firstColor);
  assertColor(material.emissive, firstEmissive);
  assert.equal(material.version, firstVersion);
});

test("mapped ambient is linearized before the stock 0.2 attenuation", () => {
  const texture = new THREE.Texture();
  const mapped = new THREE.MeshToonMaterial({ map: texture });
  const plain = new THREE.MeshToonMaterial();
  const ambient = [0.5, 0.25, 0.75] as const;

  calibrateVanillaMmdMaterials(meshWith([mapped, plain]), [
    { diffuse: [1, 1, 1, 1], ambient },
    { diffuse: [1, 1, 1, 1], ambient },
  ]);

  assertColor(mapped.emissive, expectedSrgb(ambient).multiplyScalar(0.2));
  assertColor(plain.emissive, expectedSrgb(ambient));
  const incorrect = new THREE.Color(...ambient).multiplyScalar(0.2).convertSRGBToLinear();
  const error = Math.hypot(
    mapped.emissive.r - incorrect.r,
    mapped.emissive.g - incorrect.g,
    mapped.emissive.b - incorrect.b,
  );
  assert.ok(error > 0.01);
});

test("vanilla MMD color textures become sRGB without changing sampling or alpha state", () => {
  const map = new THREE.Texture();
  map.flipY = false;
  map.wrapS = THREE.RepeatWrapping;
  map.wrapT = THREE.MirroredRepeatWrapping;
  map.minFilter = THREE.NearestFilter;
  map.magFilter = THREE.LinearFilter;
  map.repeat.set(2, 3);
  const gradientMap = new THREE.Texture();
  gradientMap.minFilter = THREE.NearestFilter;
  gradientMap.magFilter = THREE.NearestFilter;
  const sphereMap = new THREE.Texture();
  const material = new THREE.MeshToonMaterial({
    map,
    gradientMap,
    opacity: 0.35,
    transparent: true,
  }) as THREE.MeshToonMaterial & { melyMmdSphereMap?: THREE.Texture };
  const mapState = {
    flipY: map.flipY,
    wrapS: map.wrapS,
    wrapT: map.wrapT,
    minFilter: map.minFilter,
    magFilter: map.magFilter,
    repeat: map.repeat.toArray(),
  };

  calibrateVanillaMmdMaterials(meshWith(material), [{
    diffuse: [0.7, 0.6, 0.5, 0.35],
    ambient: [0.1, 0.1, 0.1],
    sphereTexturePath: "effects/dress.sph",
    sphereMode: "multiply",
  }], {
    resolveSphereTexture: (path) => path === "effects/dress.sph" ? sphereMap : undefined,
  });

  assert.equal(map.colorSpace, THREE.SRGBColorSpace);
  assert.equal(gradientMap.colorSpace, THREE.SRGBColorSpace);
  assert.equal(sphereMap.colorSpace, THREE.SRGBColorSpace);
  assert.deepEqual({
    flipY: map.flipY,
    wrapS: map.wrapS,
    wrapT: map.wrapT,
    minFilter: map.minFilter,
    magFilter: map.magFilter,
    repeat: map.repeat.toArray(),
  }, mapState);
  assert.equal(material.opacity, 0.35);
  assert.equal(material.transparent, true);
  assert.deepEqual(material.userData.melyVanillaMmdColorCalibration.colorTextureSlots, [
    "map",
    "gradientMap",
    "melyMmdSphereMap",
  ]);
  assert.equal(material.melyMmdSphereMap, sphereMap);
  assert.deepEqual(material.userData.melyVanillaMmdSphere, {
    mode: "multiply",
    path: "effects/dress.sph",
    shaderApplied: true,
  });
});

test("PMD sphere-only material does not also sample the sphere as its diffuse map", () => {
  const sphereMap = new THREE.Texture();
  const material = new THREE.MeshToonMaterial({ map: sphereMap }) as THREE.MeshToonMaterial & {
    melyMmdSphereMap?: THREE.Texture;
  };

  calibrateVanillaMmdMaterials(meshWith(material), [{
    diffuse: [1, 1, 1, 1],
    ambient: [0, 0, 0],
    texturePath: "",
    sphereTexturePath: "hair.spa",
    sphereMode: "add",
  }], {
    format: "pmd",
    resolveSphereTexture: () => sphereMap,
  });

  assert.equal(material.map, null);
  assert.equal(material.melyMmdSphereMap, sphereMap);
  assert.equal(sphereMap.colorSpace, THREE.SRGBColorSpace);
});

test("sphere texture shared with a data slot is cloned and the shader binds the clone", () => {
  const shared = new THREE.Texture();
  const material = new THREE.MeshToonMaterial({ normalMap: shared });
  calibrateVanillaMmdMaterials(meshWith(material), [{
    diffuse: [1, 1, 1, 1],
    ambient: [0, 0, 0],
    sphereTexturePath: "shared.sph",
    sphereMode: "multiply",
  }], { resolveSphereTexture: () => shared });

  const sphereMaterial = material as THREE.MeshToonMaterial & {
    melyMmdSphereMap?: THREE.Texture;
  };
  const sphereMap = sphereMaterial.melyMmdSphereMap;
  assert.ok(sphereMap);
  assert.notEqual(sphereMap, shared);
  assert.equal(sphereMap.source, shared.source);
  assert.equal(shared.colorSpace, THREE.NoColorSpace);
  assert.equal(sphereMap.colorSpace, THREE.SRGBColorSpace);

  const shader = {
    fragmentShader: THREE.ShaderLib.toon.fragmentShader,
    vertexShader: THREE.ShaderLib.toon.vertexShader,
    uniforms: {},
  } as Parameters<THREE.Material["onBeforeCompile"]>[0];
  material.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
  assert.equal(shader.uniforms.melyMmdSphereMap.value, sphereMap);
  assert.match(
    shader.fragmentShader,
    /melyMmdSphereColor \*= reflectedLight\.directDiffuse \+ reflectedLight\.indirectDiffuse;/,
  );
  assert.match(shader.fragmentShader, /outgoingLight \*= melyMmdSphereColor;/);
});

test("vanilla MMD sphere shader preserves multiply and add semantics", () => {
  const stock = THREE.ShaderLib.toon.fragmentShader;
  const multiply = patchVanillaMmdSphereFragmentShader(stock, "multiply");
  const add = patchVanillaMmdSphereFragmentShader(stock, "add");

  assert.match(multiply, /uniform sampler2D melyMmdSphereMap;/);
  assert.match(multiply, /normal\.xy \* 0\.5 \+ 0\.5/);
  assert.match(
    multiply,
    /melyMmdSphereColor \*= reflectedLight\.directDiffuse \+ reflectedLight\.indirectDiffuse;/,
  );
  assert.match(multiply, /outgoingLight \*= melyMmdSphereColor;/);
  assert.match(add, /outgoingLight \+= melyMmdSphereColor;/);
  const sphereLighting = "melyMmdSphereColor *= reflectedLight.directDiffuse + reflectedLight.indirectDiffuse;";
  assert.ok(multiply.indexOf(sphereLighting) < multiply.indexOf("outgoingLight *= melyMmdSphereColor;"));
  assert.ok(add.indexOf(sphereLighting) < add.indexOf("outgoingLight += melyMmdSphereColor;"));
  assert.equal(multiply.match(/uniform sampler2D melyMmdSphereMap;/g)?.length, 1);
  assert.equal(multiply.match(/outgoingLight \*= melyMmdSphereColor;/g)?.length, 1);
  assert.throws(
    () => patchVanillaMmdSphereFragmentShader("void main() {}", "multiply"),
    /incompatible with this Three revision/,
  );
});

test("stock loader texture capture resolves normalized sphere paths and restores internals", () => {
  const texture = new THREE.Texture();
  const ambiguous = new THREE.Texture();
  const original = (path: string) => path === "effects\\dress.sph" ? texture : ambiguous;
  const materialBuilder = { _loadTexture: original };
  const loader = { meshBuilder: { materialBuilder } };
  const capture = captureVanillaMmdLoaderTextures(loader);

  materialBuilder._loadTexture("effects\\dress.sph");
  assert.equal(capture.resolve("effects/dress.sph"), texture);
  assert.equal(capture.resolve("dress.sph"), texture);
  materialBuilder._loadTexture("other/dress.sph");
  assert.equal(capture.resolve("dress.sph"), undefined);
  capture.restore();
  assert.equal(materialBuilder._loadTexture, original);
  capture.disposeDetached();
  assert.throws(
    () => captureVanillaMmdLoaderTextures({}),
    /Unsupported three-stdlib MMDLoader texture internals/,
  );
});

test("loader capture disposes only textures that were not transferred to the mesh", () => {
  const attached = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  const detached = new THREE.DataTexture(new Uint8Array([64, 64, 64, 255]), 1, 1);
  const materialBuilder = {
    _loadTexture: (path: string) => path === "map.png" ? attached : detached,
  };
  const capture = captureVanillaMmdLoaderTextures({ meshBuilder: { materialBuilder } });
  materialBuilder._loadTexture("map.png");
  materialBuilder._loadTexture("unused.spa");
  const material = new THREE.MeshToonMaterial({ map: attached });
  const mesh = meshWith(material);
  let attachedDisposals = 0;
  let detachedDisposals = 0;
  attached.addEventListener("dispose", () => { attachedDisposals += 1; });
  detached.addEventListener("dispose", () => { detachedDisposals += 1; });

  capture.restore();
  capture.disposeDetached(mesh);

  assert.equal(attachedDisposals, 0);
  assert.equal(detachedDisposals, 1);
  assert.ok(attached.source.data);
  assert.equal(detached.source.data, null);
  assert.equal(capture.resolve("unused.spa"), undefined);
});

test("a texture shared with a data slot is cloned only for color slots", () => {
  const pixels = new Uint8Array([128, 64, 255, 255]);
  const shared = new THREE.DataTexture(pixels, 1, 1);
  shared.colorSpace = THREE.NoColorSpace;
  shared.flipY = false;
  shared.wrapS = THREE.RepeatWrapping;
  const first = new THREE.MeshToonMaterial({ map: shared, normalMap: shared });
  const second = new THREE.MeshToonMaterial({ map: shared });
  const mesh = meshWith([first, second]);
  const root = new THREE.Group();
  root.add(mesh);

  calibrateVanillaMmdMaterials(mesh, [
    { diffuse: [1, 1, 1, 1], ambient: [0, 0, 0] },
    { diffuse: [1, 1, 1, 1], ambient: [0, 0, 0] },
  ]);

  const colorClone = first.map;
  assert.ok(colorClone);
  assert.notEqual(colorClone, shared);
  assert.equal(second.map, colorClone);
  assert.equal(first.normalMap, shared);
  assert.equal(shared.colorSpace, THREE.NoColorSpace);
  assert.equal(colorClone.colorSpace, THREE.SRGBColorSpace);
  assert.equal(colorClone.source, shared.source);
  assert.equal(colorClone.flipY, shared.flipY);
  assert.equal(colorClone.wrapS, shared.wrapS);

  const textures = new Set<THREE.Texture>();
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    materials.forEach((material) => {
      Object.values(material).forEach((value) => {
        if (value instanceof THREE.Texture) textures.add(value);
      });
    });
  });
  assert.ok(textures.has(shared));
  assert.ok(textures.has(colorClone));
});

test("non-toon materials and non-color-only textures are not calibrated", () => {
  const dataTexture = new THREE.Texture();
  const toon = new THREE.MeshToonMaterial({ normalMap: dataTexture });
  const basic = new THREE.MeshBasicMaterial({ color: 0x808080, map: new THREE.Texture() });
  const basicColor = basic.color.clone();

  calibrateVanillaMmdMaterials(meshWith([toon, basic]), [
    { diffuse: [0.5, 0.5, 0.5, 1], ambient: [0.2, 0.2, 0.2] },
    { diffuse: [0.5, 0.5, 0.5, 1], ambient: [0.2, 0.2, 0.2] },
  ]);

  assert.equal(dataTexture.colorSpace, THREE.NoColorSpace);
  assert.equal(toon.normalMap, dataTexture);
  assert.equal(basic.map?.colorSpace, THREE.NoColorSpace);
  assertColor(basic.color, basicColor);
  assert.equal(basic.userData.melyVanillaMmdColorCalibration, undefined);
});

test("already-calibrated shared textures are not mutated for a new pending material", () => {
  const shared = new THREE.Texture();
  const first = new THREE.MeshToonMaterial({ map: shared });
  const second = new THREE.MeshToonMaterial({ map: shared });
  const mesh = meshWith([first, second]);

  calibrateVanillaMmdMaterials(meshWith(first), [{
    diffuse: [1, 1, 1, 1],
    ambient: [0, 0, 0],
  }]);
  const sourceVersion = shared.version;
  calibrateVanillaMmdMaterials(mesh, [
    { diffuse: [1, 1, 1, 1], ambient: [0, 0, 0] },
    { diffuse: [1, 1, 1, 1], ambient: [0, 0, 0] },
  ]);

  assert.equal(first.map, shared);
  assert.notEqual(second.map, shared);
  assert.equal(second.map?.colorSpace, THREE.SRGBColorSpace);
  assert.equal(shared.version, sourceVersion);
});
