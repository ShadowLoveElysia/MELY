import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import ts from "typescript";
import {
  resolveLocale,
  SUPPORTED_LOCALES,
  translate,
  translationEntries,
  translationKeyExists,
} from "../src/i18n";

const placeholders = (template: string) => (
  [...template.matchAll(/\{\{(\w+)\}\}/g)]
    .map((match) => match[1])
    .sort()
);

test("locale resolution supports Chinese, English, Japanese, and fallback", () => {
  assert.equal(resolveLocale(["zh-Hans-CN"]), "zh-CN");
  assert.equal(resolveLocale(["ja"]), "ja-JP");
  assert.equal(resolveLocale(["fr-FR", "en-GB"]), "en-US");
  assert.equal(resolveLocale(["fr-FR"]), "en-US");
});

test("translations interpolate parameters and expose core keys in every locale", () => {
  assert.equal(translate("en-US", "viewport.vertices", { count: "12,345" }), "12,345 vertices");
  assert.equal(translate("zh-CN", "sidebar.pose.axisPositive", { axis: "X" }), "X 轴正向微调");
  assert.equal(translate("ja-JP", "toast.motionLoaded", { name: "Walk", frames: 30 }), "Walk を読み込みました · 30 フレーム");
  assert.equal(translate("zh-CN", "sidebar.solid.faceDetail.strong"), "强化");
  assert.equal(translate("en-US", "sidebar.solid.faceDetail"), "Facial detail");
  assert.equal(translate("ja-JP", "sidebar.solid.faceDetail.balanced"), "バランス");
  assert.equal(translate("zh-CN", "toolbar.focusFace"), "聚焦面部");
  assert.equal(translate("en-US", "toolbar.focusFace"), "Focus face");
  assert.equal(translate("ja-JP", "toolbar.focusFace"), "顔にフォーカス");
  assert.equal(
    translate("en-US", "toast.poseExported", { bones: 2, morphs: 1 }),
    "Exported 2 non-default bones and 1 morphs",
  );

  for (const key of [
    "language.selector",
    "worker.stage.voxelizing",
    "sidebar.solid.faceDetailHint",
    "toolbar.focusFace",
    "sidebar.motion.previousFrame",
    "sidebar.motion.nextFrame",
    "viewport.selectPart",
    "sidebar.parts.selectedName",
    "sidebar.parts.hideSelected",
    "sidebar.parts.showSelected",
    "toast.generationFailed",
    "error.pose.invalidJson",
    "error.pose.invalidMorph",
    "error.pose.invalidMorphName",
    "error.pose.invalidMorphWeight",
    "error.pose.tooManyMorphs",
    "error.pose.duplicateMorph",
    "error.litematic.emptyProjection",
    "error.model.loadFailed",
    "error.motion.loadFailed",
    "error.archive.invalid",
    "error.export.failed",
    "error.desktop.selectSavePath",
    "error.desktop.openFile",
    "error.desktop.writeFile",
    "error.desktop.closeFile",
    "error.desktop.readAssets",
    "exportCenter.unavailable.volume",
    "exportCenter.unavailable.dimension",
    "exportCenter.useBundle",
  ]) {
    assert.equal(translationKeyExists(key), true, `${key} is missing from a locale`);
  }
  assert.deepEqual(SUPPORTED_LOCALES, ["zh-CN", "en-US", "ja-JP"]);
});

test("every locale has the same keys and placeholder contracts", () => {
  const referenceLocale = "zh-CN";
  const referenceEntries = translationEntries(referenceLocale);
  const referenceKeys = Object.keys(referenceEntries).sort();

  for (const locale of SUPPORTED_LOCALES) {
    const entries = translationEntries(locale);
    const keys = Object.keys(entries).sort();
    assert.deepEqual(keys, referenceKeys, `${locale} keys differ from ${referenceLocale}`);

    for (const key of referenceKeys) {
      assert.deepEqual(
        placeholders(entries[key]),
        placeholders(referenceEntries[key]),
        `${locale} placeholders differ for ${key}`,
      );
    }
  }
});

const sourceFiles = (directory: string): string[] => readdirSync(directory, { withFileTypes: true })
  .flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && path.endsWith(".tsx") ? [path] : [];
  });

test("all React UI translation calls and dynamic export format keys exist", () => {
  const referencedKeys = new Set<string>();
  const staticTranslationCall = /(?<![A-Za-z0-9_])t\("([^"]+)"/g;

  for (const sourceFile of sourceFiles("src")) {
    const source = readFileSync(sourceFile, "utf8");
    for (const match of source.matchAll(staticTranslationCall)) referencedKeys.add(match[1]);
  }

  for (const format of ["litematic", "bundle", "schematic", "mcstructure", "mcfunction"]) {
    referencedKeys.add(`export.format.${format}`);
    referencedKeys.add(`export.format.${format}.hint`);
  }

  for (const key of referencedKeys) {
    assert.equal(translationKeyExists(key), true, `${key} is referenced by the UI but missing from a locale`);
  }
});

test("React UI contains no unapproved literal labels or visible prose", () => {
  const allowedLiteralText = new Set(["MELY", "X", "Y", "Z", "F"]);
  const visibleAttributeNames = new Set(["aria-label", "title", "placeholder", "alt"]);
  const violations: string[] = [];

  for (const sourceFile of sourceFiles("src")) {
    const source = readFileSync(sourceFile, "utf8");
    const file = ts.createSourceFile(sourceFile, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visit = (node: ts.Node) => {
      if (ts.isJsxText(node)) {
        const text = node.getText(file).replace(/\s+/g, " ").trim();
        if (text && /[\p{L}\p{N}]/u.test(text) && !allowedLiteralText.has(text)) {
          violations.push(`${sourceFile}:${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1} text=${JSON.stringify(text)}`);
        }
      } else if (
        ts.isJsxAttribute(node)
        && visibleAttributeNames.has(node.name.getText(file))
        && node.initializer
        && ts.isStringLiteral(node.initializer)
      ) {
        violations.push(
          `${sourceFile}:${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1} ${node.name.getText(file)}=${JSON.stringify(node.initializer.text)}`,
        );
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }

  assert.deepEqual(violations, []);
});

const typescriptSourceFiles = (directory: string): string[] => readdirSync(directory, { withFileTypes: true })
  .flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return typescriptSourceFiles(path);
    return entry.isFile() && path.endsWith(".ts") ? [path] : [];
  });

test("TypeScript error boundaries use translated AppError keys and never expose Error.message", () => {
  const referencedKeys = new Set<string>();
  const violations: string[] = [];

  for (const sourceFile of typescriptSourceFiles("src")) {
    const source = readFileSync(sourceFile, "utf8");
    const file = ts.createSourceFile(sourceFile, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const visit = (node: ts.Node) => {
      if (
        ts.isCallExpression(node)
        && ts.isIdentifier(node.expression)
        && node.expression.text === "appError"
        && node.arguments[0]
        && ts.isStringLiteral(node.arguments[0])
      ) {
        referencedKeys.add(node.arguments[0].text);
      }
      if (
        ts.isPropertyAccessExpression(node)
        && node.name.text === "message"
        && ts.isIdentifier(node.expression)
        && /^(?:error|reason|cause)$/i.test(node.expression.text)
      ) {
        violations.push(
          `${sourceFile}:${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1} exposes ${node.expression.text}.message`,
        );
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }

  for (const key of referencedKeys) {
    assert.equal(translationKeyExists(key), true, `${key} is referenced by TypeScript but missing from a locale`);
  }
  assert.deepEqual(violations, []);
  assert.equal(translationKeyExists("error.external"), false);
});

test("localized public error paths do not contain internal English exception details", () => {
  const localizedKeys = [
    "error.model.loadFailed",
    "error.motion.loadFailed",
    "error.archive.invalid",
    "error.export.failed",
    "error.desktop.writeFile",
    "error.worker.unknown",
    "error.worker.failed",
    "error.worker.range",
    "error.worker.outOfMemory",
    "error.worker.crashed",
    "error.worker.protocol",
  ] as const;
  const nonEnglishLocales = ["zh-CN", "ja-JP"] as const;
  const asciiWord = /\b[A-Za-z]{4,}\b/;

  for (const locale of nonEnglishLocales) {
    for (const key of localizedKeys) {
      assert.doesNotMatch(translate(locale, key), asciiWord, `${locale} ${key} contains English prose`);
    }
  }

  for (const locale of SUPPORTED_LOCALES) {
    for (const key of localizedKeys) {
      assert.doesNotMatch(translate(locale, key), /native parser exploded/i);
    }
  }
});

test("new workflow translations preserve interpolation and component template contracts", () => {
  assert.equal(
    translate("en-US", "toast.resourceMemoryRejected", {
      memory: "5.1 GiB",
      limit: "5.0 GiB",
    }),
    "Estimated peak memory is 5.1 GiB, above the 5.0 GiB safety budget. Lower the height or complexity.",
  );
  assert.equal(
    translate("ja-JP", "heightUnlock.body", { vanilla: 384, maximum: 2032 }),
    "384 ブロックを超える投影は十分にテストされておらず、未改造のバニラワールドには完全に読み込めません。それでも最大 2032 ブロックまで解除して試せます。対応データパックとワールドコピーを使い、問題はコミュニティへ報告してください。",
  );
  assert.equal(
    translate("en-US", "exportCenter.unavailable.volume", { volume: "80,000,000", limit: "67,108,864" }),
    "The full bounds require 80,000,000 dense cells, exceeding the safe limit of 67,108,864.",
  );

  for (const locale of SUPPORTED_LOCALES) {
    const entries = translationEntries(locale);
    for (const key of [
      "survival.materials.breakdown",
      "survival.chests.chestTitle",
      "survival.chests.usage",
      "survival.layers.progress",
      "survival.layers.position",
    ]) {
      assert.doesNotMatch(entries[key], /\{\{\w+\}\}/, `${locale} ${key} must use SurvivalTools single-brace templates`);
    }
  }
});
