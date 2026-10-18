import { zipSync } from "fflate";
import type { Story } from "./types";
import {
  phoneBubbleInk,
  type PhoneAsset,
  type PhoneRecord,
  type PhoneSkin,
} from "./phone-types";
import { canSee, recordText } from "./phone-store";

interface ExportInput {
  title: string;
  owner: string;
  records: PhoneRecord[];
  allRecords: PhoneRecord[];
  story: Story;
  assets: PhoneAsset[];
  skin: PhoneSkin;
  notes: Record<string, string>;
}
export async function renderPhoneImages(input: ExportInput): Promise<Blob[]> {
  await document.fonts.ready;
  const { skin, owner, story } = input,
    scale = 3,
    width = 360,
    limit = 2600;
  const dark = skin.theme === "dark";
  const palette = {
    light: ["#ededed", "#95ec69", "#ffffff"],
    dark: ["#171b20", "#26764b", "#313943"],
    pink: ["#f7edf1", "#f7c5d6", "#ffffff"],
    lake: ["#e7f1ef", "#a2ddc9", "#ffffff"],
  }[skin.theme];
  const measure = document.createElement("canvas").getContext("2d")!;
  const font = `${skin.fontSize}px "Microsoft YaHei", sans-serif`;
  measure.font = font;
  const wrap = (text: string, max = 215) => {
    const lines: string[] = [];
    for (const para of text.split("\n")) {
      let line = "";
      for (const char of Array.from(para)) {
        if (line && measure.measureText(line + char).width > max) {
          if (/^[。，！？、；：）》」』】…]$/.test(char) && line.length > 1) {
            const characters = Array.from(line);
            line = characters.pop()!;
            lines.push(characters.join(""));
          } else {
            lines.push(line);
            line = "";
          }
        }
        line += char;
      }
      lines.push(line);
    }
    return lines;
  };
  const images = new Map<string, HTMLImageElement>();
  const load = async (id: string) => {
    if (images.has(id)) return images.get(id)!;
    const a = input.assets.find((a) => a.id === id);
    if (!a?.mime.startsWith("image/")) return;
    const img = new Image();
    img.src = a.data;
    await img.decode();
    images.set(id, img);
    return img;
  };
  const wallpaper = skin.wallpaper ? await load(skin.wallpaper) : undefined;
  type Block = {
    record: PhoneRecord;
    text: string[];
    image?: HTMLImageElement;
    images?: HTMLImageElement[];
    height: number;
    continued?: boolean;
  };
  const blocks: Block[] = [];
  for (const record of input.records) {
    if (!canSee(record, owner) || record.legacyDraft) continue;
    let content = record.retracted ? "撤回了一条消息" : recordText(record);
    if (record.body.quoteId) {
      const q = input.allRecords.find(
        (r) => r.id === record.body.quoteId && canSee(r, owner),
      );
      content = `引用：${q?.body.text || "内容已不可见"}\n${content}`;
    }
    if (record.kind === "moment") {
      if (record.likes.length)
        content += `\n♥ ${record.likes.map((id) => input.notes[id] || story.roles.find((r) => r.id === id)?.name).join("、")}`;
      for (const c of input.allRecords.filter(
        (r) => r.parentId === record.id && canSee(r, owner),
      ))
        content += `\n${input.notes[c.speakerId] || story.roles.find((r) => r.id === c.speakerId)?.name}：${c.retracted ? "已撤回" : c.body.text}`;
    }
    const lines = wrap(content),
      maxLines = 45;
    for (let i = 0; i < lines.length; i += maxLines) {
      const text = lines.slice(i, i + maxLines);
      blocks.push({
        record,
        text,
        height: 68 + text.length * (skin.fontSize * 1.6),
        continued: i > 0,
      });
    }
    if (!record.retracted) {
      const attachments: HTMLImageElement[] = [];
      for (const id of record.body.assets) {
        const image = await load(id);
        if (image) attachments.push(image);
      }
      if (record.kind === "moment" && attachments.length > 1) {
        blocks.push({
          record,
          text: [],
          images: attachments,
          height: 65 + Math.ceil(attachments.length / 3) * 76,
          continued: true,
        });
      } else
        for (const image of attachments)
          blocks.push({
            record,
            text: [],
            image,
            height: 65 + Math.min(300, (215 * image.height) / image.width),
            continued: true,
          });
    }
  }
  const pages: Block[][] = [];
  let page: Block[] = [],
    height = 80;
  for (const block of blocks) {
    if (page.length && height + block.height > limit) {
      pages.push(page);
      page = [];
      height = 80;
    }
    page.push(block);
    height += block.height;
  }
  if (page.length) pages.push(page);
  const blobs: Blob[] = [];
  for (const [index, items] of pages.entries()) {
    const h = Math.ceil(items.reduce((n, b) => n + b.height, 90));
    const canvas = document.createElement("canvas");
    canvas.width = width * scale;
    canvas.height = h * scale;
    const ctx = canvas.getContext("2d")!;
    ctx.scale(scale, scale);
    ctx.fillStyle = palette[0];
    ctx.fillRect(0, 0, width, h);
    if (wallpaper) {
      ctx.globalAlpha = 0.35;
      ctx.drawImage(wallpaper, 0, 0, width, h);
      ctx.globalAlpha = 1;
    }
    ctx.fillStyle = dark ? "#e9edf2" : "#222";
    ctx.font = 'bold 17px "Microsoft YaHei", sans-serif';
    ctx.fillText(input.title.slice(0, 18), 20, 33);
    ctx.font = '11px "Microsoft YaHei", sans-serif';
    ctx.fillStyle = dark ? "#a4acb8" : "#697079";
    ctx.fillText(
      `此间 · 手机作品${pages.length > 1 ? ` · ${index + 1}/${pages.length}` : ""}`,
      20,
      54,
    );
    let y = 76;
    for (const b of items) {
      const mine = b.record.speakerId === owner && b.record.kind === "message",
        x = mine ? 70 : 52,
        bw = 240;
      ctx.fillStyle = dark ? "#a4acb8" : "#697079";
      ctx.font = '11px "Microsoft YaHei", sans-serif';
      const author =
        input.notes[b.record.speakerId] ||
        story.roles.find((r) => r.id === b.record.speakerId)?.name ||
        "角色";
      const ax = mine ? 320 : 10;
      const portrait = story.roles.find(
        (r) => r.id === b.record.speakerId,
      )?.avatar;
      ctx.fillStyle = "#b4c7be";
      ctx.beginPath();
      ctx.roundRect(ax, y + 22, 30, 30, 6);
      ctx.fill();
      if (portrait?.startsWith("data:image/")) {
        let avatar = images.get(portrait);
        if (!avatar) {
          avatar = new Image();
          avatar.src = portrait;
          try {
            await avatar.decode();
            images.set(portrait, avatar);
          } catch {
            avatar = undefined;
          }
        }
        if (avatar) {
          ctx.save();
          ctx.beginPath();
          ctx.roundRect(ax, y + 22, 30, 30, 6);
          ctx.clip();
          const side = Math.min(avatar.width, avatar.height);
          ctx.drawImage(
            avatar,
            (avatar.width - side) / 2,
            (avatar.height - side) / 2,
            side,
            side,
            ax,
            y + 22,
            30,
            30,
          );
          ctx.restore();
        }
      } else {
        ctx.fillStyle = "#244a3b";
        ctx.font = '16px "Microsoft YaHei", sans-serif';
        ctx.fillText(author.slice(0, 1), ax + 7, y + 43);
      }
      ctx.fillStyle = dark ? "#a4acb8" : "#697079";
      ctx.font = '11px "Microsoft YaHei", sans-serif';
      ctx.fillText(
        `${author} · ${b.record.time.replace("T", " ")}${b.continued ? " · 续" : ""}`,
        x,
        y + 12,
      );
      ctx.fillStyle = mine
        ? skin.mine || palette[1]
        : skin.theirs || palette[2];
      ctx.beginPath();
      ctx.roundRect(x, y + 22, bw, b.height - 37, 8);
      ctx.fill();
      ctx.fillStyle = phoneBubbleInk(
        mine ? skin.mine || palette[1] : skin.theirs || palette[2],
        dark,
      );
      ctx.font = font;
      b.text.forEach((line, i) =>
        ctx.fillText(line, x + 12, y + 42 + i * skin.fontSize * 1.6),
      );
      if (b.image) {
        const ih = b.height - 65,
          iw = Math.min(215, (ih * b.image.width) / b.image.height);
        ctx.drawImage(b.image, x + 12, y + 30, iw, ih);
      }
      if (b.images)
        b.images.forEach((img, i) => {
          const size = 68,
            ratio = Math.min(size / img.width, size / img.height);
          const ix = x + 12 + (i % 3) * 74,
            iy = y + 30 + Math.floor(i / 3) * 76;
          ctx.drawImage(
            img,
            ix + (size - img.width * ratio) / 2,
            iy + (size - img.height * ratio) / 2,
            img.width * ratio,
            img.height * ratio,
          );
        });
      y += b.height;
    }
    blobs.push(
      await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (blob) => (blob ? resolve(blob) : reject(Error("长图生成失败"))),
          "image/png",
        ),
      ),
    );
    canvas.width = 1;
    canvas.height = 1;
  }
  if (!blobs.length) throw Error("没有可导出的内容");
  return blobs;
}
export async function exportPhoneImages(input: ExportInput) {
  const blobs = await renderPhoneImages(input),
    base = input.title.replace(/[\\/:*?"<>|]/g, "_");
  let blob = blobs[0],
    filename = `${base}.png`;
  if (blobs.length > 1) {
    const files: Record<string, Uint8Array> = {};
    for (let i = 0; i < blobs.length; i++)
      files[`${base}-${String(i + 1).padStart(2, "0")}.png`] = new Uint8Array(
        await blobs[i].arrayBuffer(),
      );
    blob = new Blob([zipSync(files, { level: 0 })], {
      type: "application/zip",
    });
    filename = `${base}.zip`;
  }
  const url = URL.createObjectURL(blob),
    a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
