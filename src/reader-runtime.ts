import type { ReaderPackage } from "./phone-reader";

/** Kept self-contained: this exact runtime is embedded in offline HTML exports. */
export function mountPhoneReader(root: HTMLElement, data: ReaderPackage) {
  const cfg = data.config,
    labels: Record<string, string> = {
      messages: "消息",
      contacts: "联系人",
      moments: "朋友圈",
      notes: "备忘录",
      photos: "相册",
      drafts: "草稿箱",
    };
  const key = (owner: string, type: string, id: string) =>
    `${owner}/${type}/${id}`;
  const storageKey = `cijian-reader:${data.id}:${data.revision}`;
  const fresh = () => ({
    read: [] as string[],
    solved: [] as string[],
    passwords: [] as string[],
    notifications: [] as string[],
    unlocked: false,
    owner: cfg.initialOwner,
  });
  let progress = fresh(),
    persistent = true,
    screen = "lock",
    owner = cfg.initialOwner,
    conversation = "",
    documentId = "",
    album = "",
    notice = "",
    disposed = false;
  let observer: IntersectionObserver | undefined,
    timer: ReturnType<typeof setTimeout> | undefined;
  let playing:
    | {
        id: string;
        index: number;
        phase: "wait" | "hold" | "done";
        paused: boolean;
        speed: number;
        shown: string[];
        retracted: string[];
      }
    | undefined;
  const validRead = new Set(
    cfg.owners.flatMap((owner) => [
      ...data.records
        .filter((r) => r.audience.includes(owner))
        .map((r) => key(owner, "record", r.id)),
      ...data.documents
        .filter((d) => d.audience.includes(owner))
        .map((d) => key(owner, "document", d.id)),
    ]),
  );
  function normalize(value: any) {
    if (
      !value ||
      !Array.isArray(value.read) ||
      !Array.isArray(value.solved) ||
      !Array.isArray(value.passwords)
    )
      throw Error("进度格式无效");
    return {
      ...fresh(),
      read: value.read.filter(
        (v: any) => typeof v === "string" && validRead.has(v),
      ),
      solved: value.solved.filter((v: any) =>
        cfg.rules.some((r) => r.id === v),
      ),
      passwords: value.passwords.filter(
        (v: any) =>
          typeof v === "string" &&
          cfg.rules.some((r) =>
            r.conditions.some(
              (c, i) => c.type === "password" && `${r.id}:${i}` === v,
            ),
          ),
      ),
      notifications: Array.isArray(value.notifications)
        ? value.notifications
            .filter((v: any) => typeof v === "string")
            .slice(-50)
        : [],
      unlocked: value.unlocked === true,
      owner: cfg.owners.includes(value.owner) ? value.owner : cfg.initialOwner,
    };
  }
  try {
    const saved = localStorage.getItem(storageKey);
    if (saved) progress = normalize(JSON.parse(saved));
    localStorage.setItem(storageKey, JSON.stringify(progress));
  } catch {
    persistent = false;
  }
  owner = progress.owner;
  if (progress.unlocked) screen = "home";
  const save = () => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(progress));
    } catch {
      persistent = false;
    }
  };
  const person = (id: string) =>
    data.devices[owner]?.notes[id] ||
    data.roles.find((r) => r.id === id)?.name ||
    "角色";
  const asset = (id: string) => {
    const a = data.assets.find((a) => a.id === id);
    return a &&
      /^data:(image\/(png|jpeg|webp|gif)|audio\/(mpeg|mp3|wav|x-wav|mp4|aac|ogg|webm));base64,/.test(
        a.data,
      )
      ? a.data
      : "";
  };
  const can = (r: { audience: string[] }) => r.audience.includes(owner);
  function targetRules(type: string, id: string) {
    return cfg.mode === "free"
      ? []
      : cfg.rules.filter((r) =>
          r.targets.some(
            (t) => t.ownerId === owner && t.type === type && t.id === id,
          ),
        );
  }
  function open(type: string, id: string) {
    return targetRules(type, id).every((r) => progress.solved.includes(r.id));
  }
  function evaluate() {
    if (cfg.mode === "free") {
      save();
      return false;
    }
    let changed = false;
    for (let i = 0; i <= cfg.rules.length; i++) {
      let next = false;
      for (const r of cfg.rules) {
        if (progress.solved.includes(r.id)) continue;
        const checks = r.conditions.map((c, index) =>
          c.type === "read"
            ? progress.read.includes(
                key(c.target.ownerId, c.target.type, c.target.id),
              )
            : c.type === "clue"
              ? progress.solved.includes(c.ruleId)
              : progress.passwords.includes(`${r.id}:${index}`),
        );
        if (r.match === "all" ? checks.every(Boolean) : checks.some(Boolean)) {
          progress.solved.push(r.id);
          if (r.notification) {
            progress.notifications.push(r.notification);
            notice = r.notification;
          }
          changed = next = true;
        }
      }
      if (!next) break;
    }
    save();
    return changed;
  }
  function mark(type: string, id: string) {
    const k = key(owner, type, id);
    if (!validRead.has(k) || progress.read.includes(k)) return;
    progress.read.push(k);
    const changed = evaluate();
    if (changed) render();
  }
  const el = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    text = "",
    className = "",
  ) => {
    const e = document.createElement(tag);
    if (text) e.textContent = text;
    if (className) e.className = className;
    return e;
  };
  const button = (text: string, fn: () => void, className = "") => {
    const b = el("button", text, className);
    b.type = "button";
    b.onclick = fn;
    return b;
  };
  function watch(node: HTMLElement, type: string, id: string) {
    node.dataset.readType = type;
    node.dataset.readId = id;
  }
  function stopPlayback() {
    if (timer) clearTimeout(timer);
    timer = undefined;
    playing = undefined;
  }
  function navigate(next: string) {
    stopPlayback();
    screen = next;
    documentId = "";
    conversation = "";
    notice = "";
    render();
  }
  function download(content: string, name: string, type: string) {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const a = el("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function gates(parent: HTMLElement, type: string, id: string) {
    const needed = targetRules(type, id).filter(
      (r) => !progress.solved.includes(r.id),
    );
    for (const r of needed) {
      const card = el("section", "", "reader-gate");
      card.append(el("strong", r.title || "内容待解锁"));
      if (r.hint) card.append(el("p", r.hint));
      const passwords = r.conditions
        .map((c, i) => ({ c, i }))
        .filter(
          (x) =>
            x.c.type === "password" &&
            !progress.passwords.includes(`${r.id}:${x.i}`),
        );
      if (passwords.length) {
        const form = el("form"),
          input = el("input");
        input.placeholder = "输入线索答案";
        input.setAttribute("aria-label", r.title + "的答案");
        const submit = el("button", "解锁");
        submit.type = "submit";
        form.append(input, submit);
        form.onsubmit = (e) => {
          e.preventDefault();
          let match = false;
          for (const { c, i } of passwords)
            if (
              c.type === "password" &&
              c.answers.some((a) => a.trim() === input.value.trim())
            ) {
              progress.passwords.push(`${r.id}:${i}`);
              match = true;
            }
          notice = match
            ? "答案正确，继续寻找剩余线索吧。"
            : r.error || "答案还不对，再看看手机里的线索。";
          evaluate();
          render();
        };
        card.append(form);
      } else card.append(el("p", "继续翻看手机，寻找解锁线索。"));
      parent.append(card);
    }
  }
  function photo(src: string, alt: string, parent: HTMLElement) {
    if (!src) return;
    const b = button("", () => {
      const dialog = el("dialog", "", "reader-image-dialog"),
        image = el("img");
      image.src = src;
      image.alt = alt;
      dialog.append(
        button("关闭", () => {
          dialog.close();
          dialog.remove();
        }),
        image,
      );
      root.append(dialog);
      dialog.showModal();
    });
    const image = el("img");
    image.src = src;
    image.alt = alt;
    image.loading = "lazy";
    b.className = "reader-photo";
    b.append(image);
    parent.append(b);
  }
  function message(parent: HTMLElement, r: ReaderPackage["records"][number]) {
    if (!can(r)) return;
    if (!open("record", r.id)) {
      gates(parent, "record", r.id);
      return;
    }
    const card = el(
      "article",
      "",
      r.kind === "message"
        ? `reader-message ${r.speakerId === owner ? "mine" : "theirs"}`
        : "reader-post",
    );
    card.append(
      el("small", `${person(r.speakerId)} · ${r.time.replace("T", " ")}`),
    );
    const body = el("div", "", "reader-bubble"),
      step =
        playing &&
        cfg.performances
          .find((p) => p.id === playing!.id)
          ?.steps.find((s) => s.recordId === r.id);
    const retracted =
      playing?.retracted.includes(r.id) || (r.retracted && !step?.revealedText);
    if (retracted) body.append(el("p", "撤回了一条消息", "reader-muted"));
    else {
      if (r.body.quoteId) {
        const q = data.records.find((q) => q.id === r.body.quoteId);
        body.append(
          el(
            "blockquote",
            q && can(q) && open("record", q.id) && !q.retracted
              ? q.body.text
              : "引用内容暂不可见",
          ),
        );
      }
      if (r.body.type !== "text")
        body.append(
          el(
            "small",
            (
              {
                image: "图片",
                sticker: "表情",
                audio: "语音",
                transfer: "剧情转账",
                call: "通话记录",
                system: "系统提示",
              } as Record<string, string>
            )[r.body.type] || "",
          ),
        );
      body.append(
        el(
          "p",
          step?.revealedText && r.retracted ? step.revealedText : r.body.text,
        ),
      );
      if (r.body.amount) body.append(el("strong", "¥ " + r.body.amount));
      if (r.body.type === "call")
        body.append(
          el(
            "p",
            (r.body.callState === "missed"
              ? "未接来电"
              : r.body.callState === "declined"
                ? "已拒绝"
                : "通话已结束") +
              (r.body.duration ? " · " + r.body.duration : ""),
          ),
        );
      for (const id of r.body.assets) {
        const a = data.assets.find((a) => a.id === id),
          src = asset(id);
        if (!a || !src) continue;
        if (a.mime.startsWith("image/"))
          photo(src, r.body.text || "图片", body);
        else {
          const audio = el("audio");
          audio.controls = true;
          audio.preload = "none";
          audio.src = src;
          body.append(audio);
        }
      }
    }
    card.append(body);
    if (r.likes.length)
      card.append(el("small", "♥ " + r.likes.map(person).join("、")));
    watch(card, "record", r.id);
    parent.append(card);
    if (r.kind === "moment")
      for (const comment of data.records.filter(
        (x) => x.parentId === r.id && can(x),
      ))
        message(card, comment);
  }
  function performance() {
    const p = playing && cfg.performances.find((p) => p.id === playing!.id);
    return p
      ? {
          ...p,
          steps: p.steps.filter((s) =>
            data.records.some((r) => r.id === s.recordId && can(r)),
          ),
        }
      : undefined;
  }
  function schedule() {
    if (timer) clearTimeout(timer);
    if (!playing || playing.paused || playing.phase === "done") return;
    const p = performance(),
      step = p?.steps[playing.index];
    if (!step) {
      playing.phase = "done";
      render();
      return;
    }
    timer = setTimeout(
      () => {
        if (!playing || disposed) return;
        if (!open("record", step.recordId)) {
          playing.paused = true;
          notice = "这一条尚未解锁，找到线索后再继续。";
          render();
          return;
        }
        if (playing.phase === "wait") {
          playing.shown.push(step.recordId);
          playing.phase = "hold";
          render();
          schedule();
        } else {
          if (step.retractAfter) playing.retracted.push(step.recordId);
          playing.index++;
          playing.phase =
            playing.index >= (p?.steps.length || 0) ? "done" : "wait";
          render();
          schedule();
        }
      },
      (playing.phase === "wait" ? step.delay : step.retractAfter || 500) /
        playing.speed,
    );
  }
  function showConversation(content: HTMLElement) {
    const c = data.conversations.find((c) => c.id === conversation);
    if (!c) return;
    const name =
      c.title ||
      c.members
        .filter((id) => id !== owner)
        .map(person)
        .join("、");
    content.append(el("h2", name || "聊天"));
    const choices = cfg.performances.filter((p) => p.conversationId === c.id);
    if (choices.length) {
      const controls = el("div", "", "reader-play-controls");
      if (!playing) {
        for (const p of choices)
          controls.append(
            button("播放：" + p.title, () => {
              playing = {
                id: p.id,
                index: 0,
                phase: "wait",
                paused: false,
                speed: 1,
                shown: [],
                retracted: [],
              };
              render();
              schedule();
            }),
          );
      } else {
        controls.append(
          button(playing.paused ? "继续" : "暂停", () => {
            playing!.paused = !playing!.paused;
            render();
            schedule();
          }),
          button("跳过停顿", () => {
            if (!playing) return;
            const step = performance()?.steps[playing.index];
            if (step && !open("record", step.recordId)) {
              notice = "需要先解锁这条内容。";
              render();
              return;
            }
            if (timer) clearTimeout(timer);
            if (step) {
              if (playing.phase === "wait") {
                playing.shown.push(step.recordId);
                playing.phase = "hold";
              } else {
                if (step.retractAfter) playing.retracted.push(step.recordId);
                playing.index++;
                playing.phase =
                  playing.index >= (performance()?.steps.length || 0)
                    ? "done"
                    : "wait";
              }
            }
            render();
            schedule();
          }),
          button("重新播放", () => {
            playing!.index = 0;
            playing!.shown = [];
            playing!.retracted = [];
            playing!.phase = "wait";
            playing!.paused = false;
            render();
            schedule();
          }),
          button("结束回放", () => {
            stopPlayback();
            render();
          }),
        );
        const speed = el("select");
        speed.setAttribute("aria-label", "播放速度");
        for (const v of [0.5, 1, 2, 4]) {
          const o = el("option", v + " 倍速");
          o.value = String(v);
          o.selected = playing.speed === v;
          speed.append(o);
        }
        speed.onchange = () => {
          playing!.speed = Number(speed.value);
          schedule();
        };
        controls.append(speed);
      }
      content.append(controls);
    }
    const p = performance();
    if (playing?.phase === "wait" && p?.steps[playing.index]?.typing)
      content.append(el("p", "对方正在输入…", "reader-typing"));
    for (const r of data.records.filter(
      (r) =>
        r.conversationId === c.id &&
        can(r) &&
        (!playing || playing.shown.includes(r.id)),
    ))
      message(content, r);
    if (playing?.paused && p?.steps[playing.index])
      gates(content, "record", p.steps[playing.index].recordId);
  }
  function showDocuments(content: HTMLElement) {
    const kind = (
      { notes: "note", photos: "photo", drafts: "draft" } as Record<
        string,
        string
      >
    )[screen];
    const docs = data.documents
      .filter((d) => d.kind === kind && can(d))
      .sort(
        (a, b) =>
          Number(b.pinned) - Number(a.pinned) || b.time.localeCompare(a.time),
      );
    if (screen === "photos") {
      const filter = el("select");
      filter.setAttribute("aria-label", "选择相册");
      for (const a of [
        "",
        ...new Set(
          docs
            .filter((d) => open("document", d.id))
            .map((d) => d.album)
            .filter(Boolean),
        ),
      ]) {
        const o = el("option", a || "全部相册");
        o.value = a;
        o.selected = album === a;
        filter.append(o);
      }
      filter.onchange = () => {
        album = filter.value;
        render();
      };
      content.append(filter);
    }
    for (const d of docs.filter(
      (d) => !album || screen !== "photos" || d.album === album,
    )) {
      if (!open("document", d.id)) {
        gates(content, "document", d.id);
        continue;
      }
      if (documentId && documentId !== d.id) continue;
      const card = el("article", "", "reader-document");
      card.append(el("small", d.time.replace("T", " ")), el("h3", d.title));
      if (!documentId && screen !== "photos") {
        card.append(
          button("打开", () => {
            documentId = d.id;
            render();
          }),
        );
        content.append(card);
        continue;
      }
      if (d.recipientId)
        card.append(el("small", "未发送给 " + person(d.recipientId)));
      card.append(el("p", d.text));
      const grid = el("div", "", "reader-photo-grid");
      for (const id of d.assets) photo(asset(id), d.title, grid);
      card.append(grid);
      watch(card, "document", d.id);
      content.append(card);
    }
    if (!docs.length)
      content.append(el("p", "这里还没有记录。", "reader-muted"));
  }
  function render() {
    if (disposed) return;
    const scroll = root.querySelector(".reader-content")?.scrollTop || 0;
    observer?.disconnect();
    root.replaceChildren();
    root.classList.add("cijian-reader");
    const skin = data.devices[owner]?.skin;
    root.dataset.theme = skin?.theme || "light";
    root.style.setProperty("--reader-font", `${skin?.fontSize || 16}px`);
    if (skin?.mine) root.style.setProperty("--mine", skin.mine);
    else root.style.removeProperty("--mine");
    if (skin?.theirs) root.style.setProperty("--theirs", skin.theirs);
    else root.style.removeProperty("--theirs");
    const ink = (color: string, dark = false) => {
      if (!/^#[0-9a-f]{6}$/i.test(color)) return dark ? "#edf1f4" : "#222";
      const cs = [1, 3, 5]
        .map((i) => parseInt(color.slice(i, i + 2), 16) / 255)
        .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      return 0.2126 * cs[0] + 0.7152 * cs[1] + 0.0722 * cs[2] > 0.179
        ? "#222"
        : "#fff";
    };
    root.style.setProperty(
      "--mine-ink",
      ink(skin?.mine || "", skin?.theme === "dark"),
    );
    root.style.setProperty(
      "--theirs-ink",
      ink(skin?.theirs || "", skin?.theme === "dark"),
    );
    root.style.backgroundImage =
      skin?.wallpaper && asset(skin.wallpaper)
        ? `url("${asset(skin.wallpaper)}")`
        : "";
    const header = el("header", "", "reader-header"),
      select = el("select");
    select.setAttribute("aria-label", "切换角色手机");
    for (const id of cfg.owners) {
      const o = el(
        "option",
        data.roles.find((r) => r.id === id)?.name || "角色",
      );
      o.value = id;
      o.selected = owner === id;
      select.append(o);
    }
    select.onchange = () => {
      stopPlayback();
      owner = select.value;
      progress.owner = owner;
      screen = progress.unlocked ? "home" : "lock";
      documentId = "";
      conversation = "";
      album = "";
      save();
      render();
    };
    header.append(
      select,
      el("span", screen === "home" ? "角色手机" : labels[screen] || "手机"),
    );
    if (screen !== "lock")
      header.append(
        button(screen === "home" ? "锁屏" : "返回", () => {
          if (screen === "home") {
            screen = "lock";
            render();
          } else if (documentId) {
            documentId = "";
            render();
          } else navigate("home");
        }),
      );
    root.append(header);
    const content = el("section", "", "reader-content");
    root.append(content);
    if (screen === "lock") {
      const lock = el("section", "", "reader-lock");
      lock.append(
        el("p", data.title, "reader-kicker"),
        el("div", "09:41", "reader-clock"),
        el("p", cfg.opening),
      );
      if (cfg.notification)
        lock.append(el("p", cfg.notification, "reader-notification"));
      const form = el("form"),
        input = el("input");
      if (cfg.password) {
        input.type = "password";
        input.placeholder = "手机解锁密码";
        input.setAttribute("aria-label", "手机解锁密码");
        form.append(input);
      }
      const submit = el("button", "打开手机");
      submit.type = "submit";
      form.append(submit);
      form.onsubmit = (e) => {
        e.preventDefault();
        if (cfg.password && input.value.trim() !== cfg.password.trim()) {
          notice = "密码不对，再想想。";
          render();
          return;
        }
        progress.unlocked = true;
        screen = "home";
        save();
        render();
      };
      lock.append(form);
      content.append(lock);
    } else if (screen === "home") {
      content.append(el("h1", person(owner) + "的手机"));
      const grid = el("div", "", "reader-desktop");
      for (const app of cfg.apps) {
        const b = button("", () => navigate(app));
        b.append(
          el(
            "span",
            (
              {
                messages: "聊",
                contacts: "人",
                moments: "圈",
                notes: "记",
                photos: "图",
                drafts: "笺",
              } as Record<string, string>
            )[app],
            "reader-app-icon",
          ),
          el("strong", labels[app]),
          el("small", open("app", app) ? "" : "待解锁"),
        );
        grid.append(b);
      }
      content.append(grid);
      const settings = el("details", "", "reader-progress");
      settings.append(el("summary", "阅读进度"));
      if (!persistent)
        settings.append(el("p", "此环境无法自动保存进度，可以下载进度文件。"));
      settings.append(
        button("导出进度", () =>
          download(
            JSON.stringify({
              format: "cijian-progress",
              id: data.id,
              revision: data.revision,
              progress,
            }),
            "手机阅读进度.json",
            "application/json",
          ),
        ),
      );
      const label = el("label", "导入进度 "),
        input = el("input");
      input.type = "file";
      input.accept = "application/json,.json";
      input.onchange = async () => {
        try {
          const f = input.files?.[0];
          if (!f) return;
          if (f.size > 1024 * 1024) throw Error("进度文件过大");
          const v = JSON.parse(await f.text());
          if (
            v.format !== "cijian-progress" ||
            v.id !== data.id ||
            v.revision !== data.revision
          )
            throw Error("进度不属于这一版本的阅读包");
          progress = normalize(v.progress);
          owner = progress.owner;
          save();
          notice = "进度已恢复";
          render();
        } catch (e) {
          notice = String(e);
          render();
        }
      };
      label.append(input);
      settings.append(
        label,
        button("重新开始", () => {
          if (confirm("清除这份作品的阅读进度并重新开始？")) {
            progress = fresh();
            owner = cfg.initialOwner;
            screen = "lock";
            save();
            render();
          }
        }),
      );
      content.append(settings);
      if (progress.notifications.length) {
        const tray = el("details", "", "reader-notifications");
        tray.append(el("summary", "剧情通知"));
        for (const n of progress.notifications) tray.append(el("p", n));
        content.append(tray);
      }
    } else if (!open("app", screen)) {
      gates(content, "app", screen);
    } else if (screen === "messages") {
      if (conversation) showConversation(content);
      else
        for (const c of data.conversations.filter(
          (c) =>
            c.members.includes(owner) ||
            data.records.some((r) => r.conversationId === c.id && can(r)),
        )) {
          const available = data.records.filter(
              (r) =>
                r.conversationId === c.id && can(r) && open("record", r.id),
            ),
            last = available.at(-1);
          const b = button(
            "",
            () => {
              conversation = c.id;
              render();
            },
            "reader-conversation",
          );
          b.append(
            el(
              "strong",
              c.title ||
                c.members
                  .filter((id) => id !== owner)
                  .map(person)
                  .join("、") ||
                "聊天",
            ),
            el(
              "small",
              last
                ? last.retracted
                  ? "撤回了一条消息"
                  : last.body.text || "一条消息"
                : "打开查看",
            ),
          );
          content.append(b);
        }
    } else if (screen === "contacts") {
      for (const r of data.roles) {
        if (r.id === owner) continue;
        const c = data.conversations.find(
          (c) =>
            c.kind === "direct" &&
            c.members.includes(owner) &&
            c.members.includes(r.id),
        );
        const b = button(
          person(r.id),
          () => {
            if (c) {
              screen = "messages";
              conversation = c.id;
              render();
            }
          },
          "reader-conversation",
        );
        content.append(b);
      }
    } else if (screen === "moments") {
      for (const r of data.records.filter((r) => r.kind === "moment" && can(r)))
        message(content, r);
    } else showDocuments(content);
    if (notice) {
      const toast = el("aside", notice, "reader-toast");
      toast.setAttribute("role", "status");
      toast.append(
        button("关闭", () => {
          notice = "";
          render();
        }),
      );
      root.append(toast);
    }
    content.scrollTop = scroll;
    observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const node = e.target as HTMLElement;
          setTimeout(() => {
            if (disposed || !node.isConnected) return;
            const b = node.getBoundingClientRect(),
              v = content.getBoundingClientRect();
            if (b.bottom > v.top && b.top < v.bottom)
              mark(node.dataset.readType!, node.dataset.readId!);
          }, 250);
        }
      },
      { root: content, threshold: 0 },
    );
    content
      .querySelectorAll<HTMLElement>("[data-read-id]")
      .forEach((node) => observer!.observe(node));
  }
  evaluate();
  render();
  return () => {
    disposed = true;
    observer?.disconnect();
    if (timer) clearTimeout(timer);
    root.replaceChildren();
  };
}
