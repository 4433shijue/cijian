import { Zip, ZipDeflate, ZipPassThrough, strToU8 } from "fflate";
import { db } from "./db";
import { uid, type SceneEvent, type Story } from "./types";
import { structuredTheaterText } from "./theater-data";
import type { WorkOptions } from "./transfer-types";
import {
  exportSnapshot,
  PagedBlobWriter,
  TransferControl,
} from "./transfer-store";

export const xmlText = (s: string) =>
  s
    .replace(
      /[\u0000-\u0008\u000B\u000C\u000E-\u001F]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
      "�",
    )
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
const mdText = (s: string) => s.replace(/([\\`*_{}[\]<>#+.!|~-])/g, "\\$1");
export const safeFilename = (s: string) =>
  s
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/[ .]+$/, "")
    .slice(0, 90) || "此间作品";
type Block = {
  kind: "title" | "heading" | "prose" | "chat" | "theater";
  text: string;
  boundary?: boolean;
};
const xmlHead = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

class Archive {
  private pending: Uint8Array[] = [];
  private error?: Error;
  private zip = new Zip((error, bytes) => {
    if (error) this.error = error;
    else if (bytes.length) this.pending.push(bytes);
  });
  constructor(private writer: PagedBlobWriter) {}
  async drain() {
    if (this.error) throw this.error;
    for (const part of this.pending) await this.writer.write(part);
    this.pending = [];
  }
  async file(name: string, text: string, store = false) {
    const file = store
      ? new ZipPassThrough(name)
      : new ZipDeflate(name, { level: 6 });
    this.zip.add(file);
    file.push(strToU8(text), true);
    await this.drain();
  }
  start(name: string) {
    const file = new ZipDeflate(name, { level: 6 });
    this.zip.add(file);
    return file;
  }
  async end() {
    this.zip.end();
    await this.drain();
  }
}

async function documentWriter(
  writer: PagedBlobWriter,
  story: Story,
  o: WorkOptions,
) {
  const size = Math.min(24, Math.max(12, o.fontSize));
  const line = Math.min(2.5, Math.max(1.2, o.lineHeight));
  const archive = ["docx", "epub"].includes(o.format)
    ? new Archive(writer)
    : undefined;
  let stream: ZipDeflate | undefined;
  const write = async (text: string) => {
    if (stream) {
      stream.push(strToU8(text));
      await archive!.drain();
    } else await writer.write(text);
  };
  if (o.format === "docx") {
    await archive!.file(
      "[Content_Types].xml",
      xmlHead +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>',
    );
    await archive!.file(
      "_rels/.rels",
      xmlHead +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    );
    await archive!.file(
      "word/_rels/document.xml.rels",
      xmlHead +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
    );
    await archive!.file(
      "word/styles.xml",
      xmlHead +
        `<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:eastAsia="宋体"/><w:sz w:val="${size * 2}"/><w:lang w:val="zh-CN"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="${Math.round(line * 240)}" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:pPr><w:jc w:val="center"/><w:keepNext/></w:pPr><w:rPr><w:b/><w:sz w:val="40"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:pPr><w:keepNext/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/></w:rPr></w:style></w:styles>`,
    );
    stream = archive!.start("word/document.xml");
    await write(
      xmlHead +
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>',
    );
  } else if (o.format === "epub") {
    // EPUB requires this to be the first entry, uncompressed, without extra data.
    await archive!.file("mimetype", "application/epub+zip", true);
    await archive!.file(
      "META-INF/container.xml",
      xmlHead +
        '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
    );
    await archive!.file(
      "OEBPS/content.opf",
      xmlHead +
        `<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="book-id">urn:uuid:${uid()}</dc:identifier><dc:title>${xmlText(story.title)}</dc:title><dc:language>zh-CN</dc:language><meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d+Z$/, "Z")}</meta></metadata><manifest><item id="nav" href="nav.xhtml" properties="nav" media-type="application/xhtml+xml"/><item id="story" href="story.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="story"/></spine></package>`,
    );
    await archive!.file(
      "OEBPS/nav.xhtml",
      xmlHead +
        `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="zh-CN"><head><title>目录</title></head><body><nav epub:type="toc"><h1>目录</h1><ol><li><a href="story.xhtml">${xmlText(story.title)}</a></li></ol></nav></body></html>`,
    );
    stream = archive!.start("OEBPS/story.xhtml");
    await write(
      xmlHead +
        `<html xmlns="http://www.w3.org/1999/xhtml" lang="zh-CN"><head><title>${xmlText(story.title)}</title><style>body{font-size:${size / 16}em;line-height:${line};font-family:serif}p{white-space:pre-wrap;overflow-wrap:anywhere}.theater{padding:12px;border-left:3px solid #849980;background:#f4f6ef}.chat{margin-left:1em}.entry{margin-top:1.5em}${o.pageBreak ? ".boundary{break-before:page;page-break-before:always}" : ""}</style></head><body>`,
    );
  } else if (o.format === "print") {
    await write(
      `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${xmlText(story.title)} · 打印预览</title><style>:root{--size:${size}px;--line:${line}}*{box-sizing:border-box}body{margin:0;background:#eef1e8;color:#253d31;font:16px system-ui}nav{position:sticky;top:0;padding:14px;display:flex;flex-wrap:wrap;align-items:center;gap:18px;background:#f6f8f0;border-bottom:1px solid #d6dfcc}button,input{font:inherit}button{padding:9px 16px;border:1px solid #809b85;border-radius:8px;background:white;color:inherit}article{max-width:800px;margin:24px auto;padding:42px;background:white;font:var(--size)/var(--line) "Songti SC",SimSun,serif}h1{text-align:center;font-size:1.7em}h2{font-size:1.15em;break-after:avoid}p{white-space:pre-wrap;overflow-wrap:anywhere;orphans:3;widows:3}.theater{padding:12px;border-left:3px solid #849980;background:#f4f6ef}.chat{padding-left:1em;border-left:2px solid #dde5d6}.entry{margin-top:1.4em}body.paginate .boundary{break-before:page;page-break-before:always}@page{size:A4;margin:20mm}@media print{nav{display:none}body,article{background:white;color:black}article{margin:0;padding:0;max-width:none}}@media(max-width:600px){article{padding:22px;margin:12px}}</style></head><body class="${o.pageBreak ? "paginate" : ""}"><nav aria-label="打印排版"><label>字号 <input aria-label="预览字号" type="range" min="12" max="24" value="${size}" oninput="document.documentElement.style.setProperty('--size',this.value+'px')"></label><label>行距 <input aria-label="预览行距" type="range" min="1.2" max="2.5" step="0.1" value="${line}" oninput="document.documentElement.style.setProperty('--line',this.value)"></label><label><input type="checkbox" ${o.pageBreak ? "checked" : ""} onchange="document.body.classList.toggle('paginate',this.checked)">正文段落另起一页</label><button onclick="window.print()">打印 / 保存 PDF</button><span>在打印窗口选择「另存为 PDF」</span></nav><article>`,
    );
  }
  let proseSeen = false;
  return {
    async block(b: Block) {
      const boundary = b.boundary && proseSeen;
      if (b.boundary) proseSeen = true;
      if (o.format === "txt" || o.format === "md") {
        const heading =
          o.format === "md"
            ? b.kind === "title"
              ? "# "
              : b.kind === "heading"
                ? "## "
                : ""
            : "";
        await write(
          heading + (o.format === "md" ? mdText(b.text) : b.text) + "\n\n",
        );
      } else if (o.format === "docx") {
        for (const [i, line] of b.text.split(/\r?\n/).entries()) {
          const style =
            b.kind === "title"
              ? "Title"
              : b.kind === "heading"
                ? "Heading1"
                : "Normal";
          await write(
            `<w:p><w:pPr><w:pStyle w:val="${style}"/>${b.kind === "theater" ? '<w:pBdr><w:left w:val="single" w:sz="12" w:space="8" w:color="849980"/></w:pBdr><w:shd w:val="clear" w:fill="F4F6EF"/>' : ""}${boundary && i === 0 && o.pageBreak ? "<w:pageBreakBefore/>" : ""}</w:pPr><w:r><w:t xml:space="preserve">${xmlText(line)}</w:t></w:r></w:p>`,
          );
        }
      } else {
        const tag =
          b.kind === "title" ? "h1" : b.kind === "heading" ? "h2" : "p";
        await write(
          `<${tag} class="${b.kind} entry${boundary ? " boundary" : ""}">${xmlText(b.text)}</${tag}>`,
        );
      }
    },
    async close() {
      if (o.format === "docx")
        await write(
          '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr></w:body></w:document>',
        );
      if (o.format === "epub") await write("</body></html>");
      if (o.format === "print") await write("</article></body></html>");
      if (stream) {
        stream.push(new Uint8Array(), true);
        await archive!.drain();
        await archive!.end();
      }
    },
  };
}

export async function exportWork(
  session: string,
  options: WorkOptions,
  control = new TransferControl(),
) {
  const o = options;
  if (
    !["txt", "md", "docx", "epub", "print"].includes(o.format) ||
    !["novel", "all", "chat"].includes(o.content) ||
    !["all", "selection"].includes(o.range) ||
    (o.theaters !== undefined && typeof o.theaters !== "boolean") ||
    !Number.isFinite(o.fontSize) ||
    !Number.isFinite(o.lineHeight)
  )
    throw Error("导出选项无效");
  if (
    o.range === "selection" &&
    (!Number.isInteger(o.from) ||
      !Number.isInteger(o.to) ||
      o.from < 1 ||
      o.to < o.from)
  )
    throw Error("请填写有效的起止范围");
  const { writer, result: title } = await exportSnapshot(
    session,
    control,
    async (writer) => {
      const story = await db.stories.get(o.storyId);
      if (!story) throw Error("故事已不存在");
      const doc = await documentWriter(writer, story, o);
      await doc.block({ kind: "title", text: story.title });
      if (o.background && story.background) {
        await doc.block({ kind: "heading", text: "开场背景" });
        await doc.block({ kind: "prose", text: story.background });
      }
      if (o.characters) {
        await doc.block({ kind: "heading", text: "人物介绍" });
        for (const r of story.roles)
          await doc.block({
            kind: "prose",
            text: r.name + (r.bio ? "\n" + r.bio : ""),
          });
      }
      if (o.background || o.characters)
        await doc.block({
          kind: "heading",
          text: o.content === "chat" ? "聊天记录" : "故事正文",
        });
      let cursor: [string, number, string] | undefined,
        index = 0,
        selected = 0;
      // A cursor includes the primary key as a tie breaker so imported equal seqs
      // cannot skip entries. Only one complete event is held at a time.
      for (;;) {
        control.check();
        const e = await nextStoryEvent(story.id, cursor);
        if (!e) break;
        cursor = [e.storyId, e.seq, e.id];
        if (
          e.deleted ||
          e.status !== "complete" ||
          (o.content === "novel" && e.kind !== "novel") ||
          (o.content === "chat" && e.kind !== "message")
        )
          continue;
        index++;
        if (o.range === "selection" && (index < o.from || index > o.to))
          continue;
        const roleName = (id: string) =>
          story.roles.find((r) => r.id === id)?.name || "未知角色";
        await doc.block(
          e.kind === "novel"
            ? { kind: "prose", text: e.text, boundary: true }
            : {
                kind: "chat",
                text: `[手机聊天 · ${e.participants.map(roleName).join("、")}]\n${roleName(e.speaker)}：${e.text}`,
              },
        );
        if (o.theaters && e.kind === "novel") {
          const theaters = await db.theaters.where("[eventId+sourceVersionId]")
            .equals([e.id, e.versionId]).filter((t) => t.storyId === story.id && t.status === "complete").toArray();
          const theater = theaters.sort((a, b) => b.updated - a.updated || b.created - a.created || b.id.localeCompare(a.id))[0];
          const theaterContent = theater?.data ? structuredTheaterText(theater.data, e.text) : theater?.text;
          if (theaterContent?.trim()) await doc.block({
            kind: "theater",
            text: `【小剧场${theater!.presets.length ? " · " + theater!.presets.map((p) => p.name).join("、") : ""}】\n${theaterContent}`,
          });
        }
        selected++;
        if (selected === 1 || selected % 16 === 0)
          control.report({
            phase: "exporting",
            bytes: writer.bytes,
            totalBytes: 0,
            records: selected,
          });
      }
      if (!selected) throw Error("所选范围内没有已完成的正文或聊天");
      if (o.range === "selection" && o.to > index)
        throw Error(`所选内容只有 ${index} 项，请调整结束位置`);
      await doc.close();
      return story.title;
    },
  );
  const mime = {
    txt: "text/plain;charset=utf-8",
    md: "text/markdown;charset=utf-8",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    epub: "application/epub+zip",
    print: "text/html;charset=utf-8",
  }[o.format];
  return {
    blob: await writer.finish(mime),
    filename: `${safeFilename(title)}${o.content === "chat" ? "-聊天" : ""}.${o.format === "print" ? "html" : o.format}`,
  };
}

async function nextStoryEvent(
  storyId: string,
  cursor?: [string, number, string],
): Promise<SceneEvent | undefined> {
  return db.events
    .where("[storyId+seq+id]")
    .between(
      cursor || [storyId, -Infinity, ""],
      [storyId, Infinity, "\uffff"],
      !cursor,
      true,
    )
    .first();
}
