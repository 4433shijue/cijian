import { expect, it } from "vitest";
import {
  builtInImageStyles,
  resolveImageStyle,
  selectCharacterReferences,
  imageStudioExportSchema,
  planningPreference,
  portableImageSettings,
  mergeImageStyles,
} from "../src/image-styles";
import { imageProfileSchema, imageSettings } from "../src/image-types";
import { imageReferencePolicy } from "../src/image-identity";
import type { Role } from "../src/types";

it("defaults to Korean painting for novel and photography for phone without replacing legacy custom style", () => {
  expect(builtInImageStyles).toHaveLength(7);
  expect(resolveImageStyle({ kind: "novel" }).id).toBe("korean-3d");
  expect(resolveImageStyle({ kind: "phone" }).id).toBe("life-photo");
  expect(
    resolveImageStyle({
      kind: "novel",
      images: imageSettings({ style: "旧的私有画风" }),
    }).positive,
  ).toBe("旧的私有画风");
});
it("keeps imported custom styles usable without global presets and allows one-picture overrides", () => {
  const custom = {
    id: "private",
    name: "私藏",
    positive: "细腻光影",
    negative: "粗线",
  };
  const story = {
    kind: "novel" as const,
    images: imageSettings({
      stylePresetId: custom.id,
      stylePresetSnapshot: custom,
    }),
  };
  expect(resolveImageStyle(story)).toEqual(custom);
  expect(resolveImageStyle(story, [], "watercolor").id).toBe("watercolor");
  expect(story.images.stylePresetId).toBe("private");
  const changedDefault = {
    ...builtInImageStyles[0],
    positive: "我的全局默认画风",
  };
  const portable = portableImageSettings({ kind: "novel" }, [changedDefault]);
  expect(resolveImageStyle({ kind: "novel", images: portable }).positive).toBe(
    "我的全局默认画风",
  );
  expect(
    mergeImageStyles([changedDefault], [builtInImageStyles[0], custom]),
  ).toEqual([changedDefault, custom]);
});
it("selects style-matched identity references before common references and never borrows another style", () => {
  const role = {
    imageReference: "old",
    imageReferences: [
      {
        id: "a",
        name: "厚涂正面",
        view: "front",
        styleId: "korean-3d",
        data: "a",
      },
      {
        id: "b",
        name: "水彩",
        view: "front",
        styleId: "watercolor",
        data: "b",
      },
      { id: "c", name: "通用", view: "side", styleId: "", data: "c" },
    ],
  } as Role;
  expect(
    selectCharacterReferences(role, "korean-3d").map((r) => r.data),
  ).toEqual(["a"]);
  expect(
    selectCharacterReferences(role, "classic-oil").map((r) => r.data),
  ).toEqual(["old", "c"]);
});
it("resolves reference limitations without making fallback generation requests", () => {
  const p = imageProfileSchema.parse({
    id: "i",
    name: "test",
    model: "image",
    url: "https://example.test/v1",
    references: "auto",
  });
  expect(imageReferencePolicy(p).enabled).toBe(true);
  expect(imageReferencePolicy(p, true).enabled).toBe(false);
  expect(
    imageReferencePolicy({
      ...p,
      endpointMode: "full",
      url: p.url + "/images/generations",
    }).enabled,
  ).toBe(false);
  expect(imageReferencePolicy({ ...p, protocol: "custom" }).enabled).toBe(
    false,
  );
  expect(
    imageReferencePolicy({
      ...p,
      protocol: "chat",
      url: p.url + "/chat/completions",
    }).enabled,
  ).toBe(true);
});
it("validates imported presets and excludes keys and arbitrary fields", () => {
  const file = {
    format: "cijian-image-studio",
    version: 1,
    presets: builtInImageStyles,
    key: "not-a-secret",
  };
  expect(imageStudioExportSchema.parse(file)).not.toHaveProperty("key");
  expect(() =>
    imageStudioExportSchema.parse({
      ...file,
      presets: [builtInImageStyles[0], builtInImageStyles[0]],
    }),
  ).toThrow();
  expect(planningPreference(undefined, "novel")).toContain("固定外貌");
});
