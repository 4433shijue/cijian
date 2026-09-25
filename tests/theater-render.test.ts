import { describe, expect, it } from "vitest";
import {
  bodyCardClasses,
  theaterTemplateStyleTag,
  theaterTemplateStyles,
} from "../src/theater-template";
import { fallbackTemplateWrapper, theaterHeadStyles } from "../src/theater-render";

describe("body-state theater template", () => {
  it("exposes stable hooks for grouped regions, levels, evidence, and history", () => {
    expect(bodyCardClasses.root).toBe("theater-body-card");
    expect(theaterTemplateStyles).toContain(
      '[data-theater-template="body-card"]',
    );
    expect(theaterTemplateStyles).toContain(
      '[data-theater-template="forum"]',
    );
    expect(theaterTemplateStyles).toContain("data-reply-to");
    for (const className of [
      bodyCardClasses.groups,
      bodyCardClasses.group,
      bodyCardClasses.regions,
      bodyCardClasses.region,
      bodyCardClasses.level,
      bodyCardClasses.change,
      bodyCardClasses.evidence,
      bodyCardClasses.history,
    ])
      expect(theaterTemplateStyles).toContain(`.${className}`);
    expect(theaterTemplateStyles).toContain("@media (max-width: 620px)");
    expect(theaterTemplateStyles).toContain("details[open]");
  });

  it("keeps the fallback stylesheet self-contained and resource-free", () => {
    const styleTag = theaterTemplateStyleTag();
    expect(styleTag).toMatch(
      /^<style data-theater-template-styles>[\s\S]*<\/style>$/,
    );
    expect(styleTag).not.toMatch(/@import|@font-face|url\s*\(|image-set\s*\(/i);
  });

  it("injects base and body-card fallback styles before sanitized model styles", () => {
    const custom = "<style>.custom{color:teal}</style>";
    const result = theaterHeadStyles(custom);
    expect(result.indexOf("data-theater-base-styles")).toBeGreaterThanOrEqual(
      0,
    );
    expect(result.indexOf("data-theater-template-styles")).toBeGreaterThan(
      result.indexOf("data-theater-base-styles"),
    );
    expect(result.indexOf(custom)).toBeGreaterThan(
      result.indexOf("data-theater-template-styles"),
    );
  });

  it("wraps legacy freeform markup with the selected template when the model omitted its marker", () => {
    const result = fallbackTemplateWrapper("<section><h2>身体记录</h2><p>右手扣住杯沿</p></section>", ["body-status"]);
    expect(result).toContain('<div data-theater-template="body-card">');
    expect(result).toContain("身体记录");
  });

  it("preserves model-authored forum markers and does not nest a second template", () => {
    const html = '<section data-theater-template="forum"><article data-floor="1">楼主</article></section>';
    const result = fallbackTemplateWrapper(html, ["forum"]);
    expect(result.match(/data-theater-template="forum"/g)).toHaveLength(1);
    expect(result).toContain('data-floor="1"');
  });
});
