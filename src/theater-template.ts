/**
 * Stable hooks for model-authored body state cards.
 *
 * The model is allowed to choose the surrounding prose, but these class names
 * give the iframe a predictable, readable fallback when a card uses the
 * `data-theater-template="body-card"` marker.
 */
export const bodyCardClasses = {
  root: "theater-body-card",
  header: "body-card__header",
  title: "body-card__title",
  badge: "body-card__badge",
  summary: "body-card__summary",
  groups: "body-card__groups",
  group: "body-card__group",
  groupTitle: "body-card__group-title",
  groupCount: "body-card__group-count",
  regions: "body-card__regions",
  region: "body-card__region",
  regionHeader: "body-card__region-header",
  regionName: "body-card__region-name",
  level: "body-card__level",
  state: "body-card__state",
  change: "body-card__change",
  evidence: "body-card__evidence",
  duration: "body-card__duration",
  label: "body-card__label",
  history: "body-card__history",
  historyList: "body-card__history-list",
  historyItem: "body-card__history-item",
  historyBefore: "body-card__history-before",
  historyAfter: "body-card__history-after",
  historyArrow: "body-card__history-arrow",
} as const;

/**
 * Visual fallback for the body-state card. It deliberately contains no
 * resource-bearing CSS. The stylesheet is inserted into the isolated iframe
 * by theaterDocument, after model HTML has been sanitized.
 */
export const theaterTemplateStyles = `
[data-theater-template="body-card"] {
  --body-card-ink: #273c35;
  --body-card-muted: #6f8079;
  --body-card-line: rgba(39, 60, 53, .14);
  --body-card-panel: rgba(255, 255, 255, .82);
  --body-card-panel-soft: rgba(246, 249, 244, .82);
  --body-card-accent: #4a806e;
  --body-card-subtle: #6d8d9a;
  --body-card-clear: #bc7c43;
  --body-card-impact: #a85e69;
  display: block;
  width: 100%;
  max-width: 920px;
  margin: 0 auto;
  padding: 16px;
  color: var(--body-card-ink);
  background: linear-gradient(145deg, rgba(255,255,255,.94), rgba(240,247,239,.86));
  border: 1px solid var(--body-card-line);
  border-radius: 20px;
  box-shadow: 0 12px 30px rgba(45, 76, 61, .10);
  overflow: hidden;
}

[data-theater-template="body-card"] *,
[data-theater-template="body-card"] *::before,
[data-theater-template="body-card"] *::after {
  box-sizing: border-box;
}

[data-theater-template="body-card"] h1,
[data-theater-template="body-card"] h2,
[data-theater-template="body-card"] h3,
[data-theater-template="body-card"] p {
  margin-top: 0;
}

[data-theater-template="body-card"] h2,
[data-theater-template="body-card"] h3 {
  color: var(--body-card-ink);
  line-height: 1.35;
}

[data-theater-template="body-card"] .body-card__header,
[data-theater-template="body-card"] [data-body-card-header] {
  padding: 4px 4px 14px;
  border-bottom: 1px solid var(--body-card-line);
}

[data-theater-template="body-card"] .body-card__title,
[data-theater-template="body-card"] [data-body-card-title] {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 10px;
  margin-bottom: 6px;
  font-size: clamp(18px, 3vw, 24px);
}

[data-theater-template="body-card"] .body-card__badge,
[data-theater-template="body-card"] [data-body-card-badge] {
  display: inline-flex;
  align-items: center;
  min-height: 24px;
  padding: 2px 9px;
  color: #376a58;
  background: rgba(218, 238, 226, .88);
  border: 1px solid rgba(74, 128, 110, .24);
  border-radius: 999px;
  font-size: 12px;
  font-weight: 650;
  letter-spacing: .02em;
}

[data-theater-template="body-card"] .body-card__summary,
[data-theater-template="body-card"] [data-body-card-summary] {
  max-width: 70ch;
  margin-bottom: 0;
  color: var(--body-card-muted);
  font-size: 14px;
}

[data-theater-template="body-card"] .body-card__groups,
[data-theater-template="body-card"] [data-body-card-groups] {
  display: grid;
  gap: 10px;
  margin-top: 14px;
}

[data-theater-template="body-card"] .body-card__group,
[data-theater-template="body-card"] [data-body-card-group] {
  min-width: 0;
  background: var(--body-card-panel);
  border: 1px solid var(--body-card-line);
  border-radius: 14px;
  overflow: hidden;
}

[data-theater-template="body-card"] .body-card__group > summary,
[data-theater-template="body-card"] [data-body-card-group] > summary,
[data-theater-template="body-card"] .body-card__history > summary,
[data-theater-template="body-card"] [data-body-card-history] > summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 42px;
  padding: 10px 13px;
  color: var(--body-card-ink);
  cursor: pointer;
  list-style: none;
  font-weight: 650;
}

[data-theater-template="body-card"] .body-card__group > summary::-webkit-details-marker,
[data-theater-template="body-card"] [data-body-card-group] > summary::-webkit-details-marker,
[data-theater-template="body-card"] .body-card__history > summary::-webkit-details-marker,
[data-theater-template="body-card"] [data-body-card-history] > summary::-webkit-details-marker {
  display: none;
}

[data-theater-template="body-card"] .body-card__group > summary::after,
[data-theater-template="body-card"] [data-body-card-group] > summary::after,
[data-theater-template="body-card"] .body-card__history > summary::after,
[data-theater-template="body-card"] [data-body-card-history] > summary::after {
  content: "⌄";
  flex: 0 0 auto;
  color: var(--body-card-muted);
  font-size: 16px;
  line-height: 1;
  transition: transform .16s ease;
}

[data-theater-template="body-card"] details[open] > summary::after {
  transform: rotate(180deg);
}

[data-theater-template="body-card"] .body-card__group-title,
[data-theater-template="body-card"] [data-body-card-group-title] {
  min-width: 0;
}

[data-theater-template="body-card"] .body-card__group-count,
[data-theater-template="body-card"] [data-body-card-group-count] {
  margin-left: auto;
  color: var(--body-card-muted);
  font-size: 12px;
  font-weight: 500;
  white-space: nowrap;
}

[data-theater-template="body-card"] .body-card__regions,
[data-theater-template="body-card"] [data-body-card-regions] {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 9px;
  padding: 0 10px 10px;
}

[data-theater-template="body-card"] .body-card__region,
[data-theater-template="body-card"] [data-body-card-region] {
  min-width: 0;
  padding: 11px 12px;
  background: var(--body-card-panel-soft);
  border: 1px solid rgba(39, 60, 53, .10);
  border-radius: 12px;
}

[data-theater-template="body-card"] .body-card__region-header,
[data-theater-template="body-card"] [data-body-card-region-header] {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 9px;
  margin-bottom: 5px;
}

[data-theater-template="body-card"] .body-card__region-name,
[data-theater-template="body-card"] [data-body-card-region-name] {
  min-width: 0;
  font-weight: 700;
  overflow-wrap: anywhere;
}

[data-theater-template="body-card"] .body-card__level,
[data-theater-template="body-card"] [data-body-card-level] {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  min-height: 22px;
  padding: 1px 7px;
  color: var(--body-card-muted);
  background: rgba(112, 128, 121, .10);
  border: 1px solid rgba(112, 128, 121, .16);
  border-radius: 999px;
  font-size: 11px;
  line-height: 1.4;
  white-space: nowrap;
}

[data-theater-template="body-card"] .body-card__region--subtle .body-card__level,
[data-theater-template="body-card"] [data-body-card-level="轻微"],
[data-theater-template="body-card"] [data-level="subtle"] {
  color: #4f7280;
  background: rgba(190, 222, 232, .34);
  border-color: rgba(109, 141, 154, .28);
}

[data-theater-template="body-card"] .body-card__region--clear .body-card__level,
[data-theater-template="body-card"] [data-body-card-level="明显"],
[data-theater-template="body-card"] [data-level="clear"] {
  color: #8b5c2e;
  background: rgba(239, 211, 179, .42);
  border-color: rgba(188, 124, 67, .28);
}

[data-theater-template="body-card"] .body-card__region--impact .body-card__level,
[data-theater-template="body-card"] [data-body-card-level="影响动作"],
[data-level="impact"] {
  color: #8b4754;
  background: rgba(238, 202, 209, .46);
  border-color: rgba(168, 94, 105, .30);
}

[data-theater-template="body-card"] .body-card__state,
[data-theater-template="body-card"] [data-body-card-state] {
  margin-bottom: 8px;
  color: var(--body-card-ink);
  font-size: 14px;
}

[data-theater-template="body-card"] .body-card__change,
[data-theater-template="body-card"] .body-card__evidence,
[data-theater-template="body-card"] .body-card__duration,
[data-theater-template="body-card"] [data-body-card-change],
[data-theater-template="body-card"] [data-body-card-evidence],
[data-theater-template="body-card"] [data-body-card-duration] {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  gap: 7px;
  align-items: baseline;
  margin-top: 5px;
  color: var(--body-card-muted);
  font-size: 12px;
}

[data-theater-template="body-card"] .body-card__label,
[data-theater-template="body-card"] [data-body-card-label] {
  color: var(--body-card-accent);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: .04em;
  white-space: nowrap;
}

[data-theater-template="body-card"] .body-card__evidence q,
[data-theater-template="body-card"] [data-body-card-evidence] q {
  color: #51625b;
  quotes: "“" "”" "‘" "’";
  overflow-wrap: anywhere;
}

[data-theater-template="body-card"] .body-card__history,
[data-theater-template="body-card"] [data-body-card-history] {
  margin-top: 12px;
  background: rgba(246, 249, 244, .66);
  border: 1px solid var(--body-card-line);
  border-radius: 14px;
}

[data-theater-template="body-card"] .body-card__history-list,
[data-theater-template="body-card"] [data-body-card-history-list] {
  display: grid;
  gap: 7px;
  padding: 0 10px 10px;
}

[data-theater-template="body-card"] .body-card__history-item,
[data-theater-template="body-card"] [data-body-card-history-item] {
  display: grid;
  grid-template-columns: minmax(0, 1fr) max-content minmax(0, 1fr);
  gap: 8px;
  align-items: center;
  padding: 8px 10px;
  background: var(--body-card-panel);
  border: 1px solid rgba(39, 60, 53, .08);
  border-radius: 10px;
  font-size: 12px;
}

[data-theater-template="body-card"] .body-card__history-before,
[data-theater-template="body-card"] .body-card__history-after,
[data-theater-template="body-card"] [data-body-card-history-before],
[data-theater-template="body-card"] [data-body-card-history-after] {
  min-width: 0;
  overflow-wrap: anywhere;
}

[data-theater-template="body-card"] .body-card__history-before,
[data-theater-template="body-card"] [data-body-card-history-before] {
  color: var(--body-card-muted);
}

[data-theater-template="body-card"] .body-card__history-after,
[data-theater-template="body-card"] [data-body-card-history-after] {
  color: var(--body-card-ink);
  font-weight: 650;
}

[data-theater-template="body-card"] .body-card__history-arrow,
[data-theater-template="body-card"] [data-body-card-history-arrow] {
  color: var(--body-card-accent);
  font-size: 15px;
  white-space: nowrap;
}

[data-theater-template="body-card"] [hidden] {
  display: none !important;
}

@media (max-width: 620px) {
  [data-theater-template="body-card"] {
    padding: 12px;
    border-radius: 16px;
  }

  [data-theater-template="body-card"] .body-card__regions,
  [data-theater-template="body-card"] [data-body-card-regions] {
    grid-template-columns: minmax(0, 1fr);
  }

  [data-theater-template="body-card"] .body-card__region-header,
  [data-theater-template="body-card"] [data-body-card-region-header] {
    align-items: flex-start;
  }

  [data-theater-template="body-card"] .body-card__history-item,
  [data-theater-template="body-card"] [data-body-card-history-item] {
    grid-template-columns: minmax(0, 1fr);
    gap: 3px;
  }

  [data-theater-template="body-card"] .body-card__history-arrow,
  [data-theater-template="body-card"] [data-body-card-history-arrow] {
    transform: rotate(90deg);
    justify-self: start;
  }
}

/* Forum thread */
[data-theater-template="forum"] {
  --forum-ink: #273b36;
  --forum-muted: #71807b;
  --forum-line: rgba(39, 59, 54, .14);
  --forum-paper: rgba(255, 255, 255, .84);
  --forum-soft: rgba(239, 246, 240, .82);
  display: block;
  width: 100%;
  max-width: 920px;
  margin: 0 auto;
  padding: 14px;
  color: var(--forum-ink);
  background: linear-gradient(150deg, rgba(255,255,255,.95), rgba(238,246,239,.88));
  border: 1px solid var(--forum-line);
  border-radius: 18px;
  box-shadow: 0 12px 28px rgba(45, 76, 61, .09);
}

[data-theater-template="forum"] [data-forum-header],
[data-theater-template="forum"] .forum__header {
  padding: 3px 4px 13px;
  border-bottom: 1px solid var(--forum-line);
}

[data-theater-template="forum"] [data-forum-board],
[data-theater-template="forum"] .forum__board {
  color: var(--forum-muted);
  font-size: 12px;
  letter-spacing: .06em;
}

[data-theater-template="forum"] [data-forum-title],
[data-theater-template="forum"] .forum__title {
  margin: 5px 0 4px;
  color: var(--forum-ink);
  font-size: clamp(18px, 3vw, 25px);
  line-height: 1.35;
}

[data-theater-template="forum"] [data-forum-notice],
[data-theater-template="forum"] .forum__notice {
  margin: 0;
  color: var(--forum-muted);
  font-size: 12px;
}

[data-theater-template="forum"] [data-floor],
[data-theater-template="forum"] .forum__post {
  position: relative;
  margin-top: 10px;
  padding: 12px 13px;
  background: var(--forum-paper);
  border: 1px solid var(--forum-line);
  border-radius: 13px;
  box-shadow: 0 4px 12px rgba(45, 76, 61, .04);
}

[data-theater-template="forum"] [data-floor][data-reply-to],
[data-theater-template="forum"] .forum__post.is-reply {
  margin-left: clamp(14px, 5vw, 46px);
  background: var(--forum-soft);
}

[data-theater-template="forum"] [data-forum-meta],
[data-theater-template="forum"] .forum__meta {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 5px 9px;
  margin-bottom: 5px;
  color: var(--forum-muted);
  font-size: 12px;
}

[data-theater-template="forum"] [data-forum-author],
[data-theater-template="forum"] .forum__author {
  color: var(--forum-ink);
  font-weight: 700;
}

[data-theater-template="forum"] [data-forum-badge],
[data-theater-template="forum"] .forum__badge {
  display: inline-flex;
  padding: 1px 7px;
  color: #3b6e5b;
  background: rgba(213, 235, 222, .86);
  border: 1px solid rgba(74, 128, 110, .22);
  border-radius: 999px;
  font-size: 11px;
}

[data-theater-template="forum"] [data-floor-body],
[data-theater-template="forum"] .forum__body {
  margin: 0;
  overflow-wrap: anywhere;
}

[data-theater-template="forum"] [data-certainty="inference"],
[data-theater-template="forum"] [data-stance="guess"],
[data-theater-template="forum"] .forum__post.is-guess {
  border-left: 3px solid #c18a4d;
}

[data-theater-template="forum"] [data-certainty="visible"],
[data-theater-template="forum"] [data-stance="observation"] {
  border-left: 3px solid #6c9b87;
}

[data-theater-template="forum"] [data-forum-tag],
[data-theater-template="forum"] .forum__tag {
  display: inline-block;
  margin: 8px 5px 0 0;
  color: var(--forum-muted);
  font-size: 11px;
}

[data-theater-template="forum"] [data-forum-rule],
[data-theater-template="forum"] .forum__rule {
  margin: 13px 4px 0;
  color: var(--forum-muted);
  font-size: 12px;
  text-align: center;
}

/* Generic structured cards used by custom presets. */
[data-theater-template="dialogue"],
[data-theater-template="subtext-card"],
[data-theater-template="detail-list"],
[data-theater-template="evidence-board"],
[data-theater-template="relationship-card"],
[data-theater-template="scene-board"] {
  display: block;
  width: 100%;
  max-width: 920px;
  margin: 0 auto;
  padding: 15px;
  color: #30473f;
  background: rgba(255,255,255,.72);
  border: 1px solid rgba(48,71,63,.14);
  border-radius: 16px;
  box-shadow: 0 9px 22px rgba(45, 76, 61, .07);
}

[data-theater-template="dialogue"] [data-line],
[data-theater-template="subtext-card"] [data-card],
[data-theater-template="detail-list"] [data-detail],
[data-theater-template="evidence-board"] [data-evidence],
[data-theater-template="relationship-card"] [data-relation],
[data-theater-template="scene-board"] [data-sense] {
  margin-top: 9px;
  padding: 10px 12px;
  background: rgba(247,250,245,.82);
  border: 1px solid rgba(48,71,63,.10);
  border-radius: 11px;
}

@media (max-width: 620px) {
  [data-theater-template="forum"],
  [data-theater-template="dialogue"],
  [data-theater-template="subtext-card"],
  [data-theater-template="detail-list"],
  [data-theater-template="evidence-board"],
  [data-theater-template="relationship-card"],
  [data-theater-template="scene-board"] {
    padding: 11px;
    border-radius: 14px;
  }

  [data-theater-template="forum"] [data-floor][data-reply-to],
  [data-theater-template="forum"] .forum__post.is-reply {
    margin-left: 10px;
  }
}

@media (prefers-reduced-motion: reduce) {
  [data-theater-template="body-card"] details > summary::after {
    transition: none;
  }
}
`;

/** A complete style tag for safe insertion into the isolated theater head. */
export function theaterTemplateStyleTag() {
  return `<style data-theater-template-styles>${theaterTemplateStyles}</style>`;
}
