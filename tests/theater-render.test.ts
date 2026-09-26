import { describe, expect, it } from "vitest";
import {
  bodyCardClasses,
  theaterTemplateStyleTag,
  theaterTemplateStyles,
} from "../src/theater-template";
import { fallbackTemplateWrapper, theaterClarityStyle, theaterHeadStyles, theaterReading } from "../src/theater-render";

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

  it("injects base and body-card fallback styles before sanitized model styles in original view", () => {
    const custom = "<style>.custom{color:teal}</style>";
    const result = theaterHeadStyles(custom, { clarity: false });
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

  it("defaults old records to readable type and bounds imported reading sizes", () => {
    expect(theaterReading()).toEqual({ clarity: true, fontSize: 16 });
    expect(theaterReading({ clarity: false, fontSize: 8 })).toEqual({ clarity: false, fontSize: 16 });
    expect(theaterReading({ fontSize: 1000 }).fontSize).toBe(24);
    expect(theaterReading({ fontSize: NaN }).fontSize).toBe(16);
  });

  it("excludes model CSS from clear view, including covering pseudo-elements, and retains original-theme opt-out", () => {
    const custom = '<style>#cover::before{content:"";position:fixed;inset:0;background:white!important}p{color:white!important;height:0;overflow:hidden}</style>';
    const clear = theaterHeadStyles(custom, { clarity: true, fontSize: 20 });
    expect(clear).not.toContain("#cover");
    expect(clear).not.toContain("height:0");
    expect(clear).toContain("data-theater-clarity-styles");
    expect(clear).toContain("font-size:20px");
    expect(clear).toContain("mix-blend-mode:normal!important");
    expect(theaterHeadStyles(custom, { clarity: false })).not.toContain("data-theater-clarity-styles");
    expect(theaterHeadStyles(custom, { clarity: false })).toContain(custom);
  });

  it("resets inline paint effects that can make otherwise dark text invisible", () => {
    const style = theaterClarityStyle("P", 18);
    expect(style.color).toBe("#263c32");
    expect(style.background).toBe("transparent");
    expect(style.opacity).toBe("1");
    expect(style.filter).toBe("none");
    expect(style["mix-blend-mode"]).toBe("normal");
    expect(style["-webkit-text-fill-color"]).toBe("currentColor");
    expect(style.mask).toBe("none");
    expect(style["font-size"]).toBe("18px");
    expect(theaterClarityStyle("BODY", 18).background).toBe("#fffdf8");
    expect(theaterClarityStyle("H2", 20)["font-size"]).toBe("24px");
  });
});
