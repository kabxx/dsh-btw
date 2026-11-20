import { CONTEXT_OVERFLOW, appendTurn, applyReply } from '../shared/wire.js';

// The containing DSH slots own column widths, the mobile sidebar shell, and focus outside BTW.
export const styles = String.raw`
.dsh-btw-dock {
  box-sizing: border-box;
  width: calc(100% - 2 * var(--dsh-composer-side-clearance, 0px) - 4 * var(--dsh-composer-dock-inset, 4px));
  max-width: calc(var(--dsh-composer-card-max-width, 100%) - 4 * var(--dsh-composer-dock-inset, 4px));
  min-width: 0;
  margin-inline: auto;
}
.dsh-btw-card {
  --dsw-elevation-stroke-color: var(--dsw-alias-border-l1);
  position: relative;
  isolation: isolate;
  border-radius: var(--dsw-radius-md);
  box-shadow: var(--dsw-elevation-panel);
  color: var(--dsw-alias-label-secondary);
}
.dsh-btw-card::before {
  position: absolute;
  z-index: -1;
  inset: 0;
  border-radius: inherit;
  background: var(--dsw-specific-menu);
  backdrop-filter: var(--dsw-menu-backdrop-filter);
  content: '';
  pointer-events: none;
}
.dsh-btw-card-bar {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 36px;
  padding: 4px 5px 4px 12px;
}
.dsh-btw-mark { display: block; flex: none; color: var(--dsw-alias-label-tertiary); }
.dsh-btw-title-label {
  flex: none;
  max-width: 35%;
  overflow: hidden;
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  line-height: 24px;
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsh-btw-question {
  flex: 1 1 auto;
  min-width: 0;
  margin: 0;
  overflow: hidden;
  color: var(--dsw-alias-label-primary-dimmed);
  font-size: 13px;
  font-weight: 400;
  line-height: 20px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsh-btw-actions { display: flex; flex: none; align-items: center; gap: 8px; }
@media (max-width: 420px) { .dsh-btw-actions { gap: 4px; } }
.dsh-btw-icon-button {
  display: inline-flex;
  flex: none;
  width: 28px;
  height: 28px;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 0;
  border-radius: 50%;
  corner-shape: round;
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  cursor: pointer;
}
.dsh-btw-icon-button:disabled { opacity: .4; cursor: default; }
.dsh-btw-icon-button:focus-visible, .dsh-btw-row:focus-visible, .dsh-btw-retry:focus-visible {
  outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: -2px;
}
@media (hover: hover) {
  .dsh-btw-icon-button:hover:not(:disabled), .dsh-btw-row:hover, .dsh-btw-retry:hover {
    background: var(--dsw-alias-interactive-bg-hover);
    color: var(--dsw-alias-label-primary);
  }
  .dsh-btw-card .dsh-btw-icon-button:hover:not(:disabled) { color: var(--dsw-alias-label-secondary); }
}
.dsh-btw-inline-reply {
  --dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2);
  --dsh-scrollbar-thumb-hover: var(--dsw-alias-scrollbar-hover-l2);
  max-height: min(220px, 29dvh);
  overflow: auto;
  overscroll-behavior: contain;
  padding: 5px 12px 8px;
  color: var(--dsw-alias-label-primary);
  font-size: var(--dsh-content-font-size-secondary, 13px);
  line-height: calc(20px + var(--dsh-content-font-delta, 0px));
  overflow-wrap: anywhere;
}
.dsh-btw-inline-rule { margin-inline: 12px; border-top: 1px solid var(--dsw-alias-border-l1); }
.dsh-btw-waiting {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--dsw-alias-label-secondary);
}
/* DSH 0.2.2-rc.5 StateDot ongoing styles, scoped to BTW (see NOTICE). */
.dsh-btw-waiting-spinner { flex: none; color: var(--dsw-alias-label-tertiary); }
.dsh-btw-spinner-motion {
  transform-origin: center;
  animation: dsh-btw-spinner-spin 1.5s linear infinite;
}
.dsh-btw-spinner-track, .dsh-btw-spinner-arc {
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
}
.dsh-btw-spinner-track { opacity: .25; }
.dsh-btw-spinner-arc {
  stroke-dasharray: 12 150;
  animation: dsh-btw-spinner-dash 1.5s ease-in-out infinite;
}
@keyframes dsh-btw-spinner-spin { to { transform: rotate(360deg); } }
@keyframes dsh-btw-spinner-dash {
  0% { stroke-dasharray: 12 150; stroke-dashoffset: 0; }
  50% { stroke-dasharray: 24 150; stroke-dashoffset: -6; }
  to { stroke-dasharray: 12 150; stroke-dashoffset: 0; }
}
@media (prefers-reduced-motion: reduce) {
  .dsh-btw-spinner-motion, .dsh-btw-spinner-arc { animation: none; }
  .dsh-btw-spinner-arc { stroke-dasharray: 18 150; stroke-dashoffset: -3; }
}
.dsh-btw-inline-reply [data-markdown-variant='compact'],
.dsh-btw-message-assistant [data-markdown-variant='compact'] {
  color: var(--dsw-alias-label-primary);
  font-size: inherit;
  line-height: inherit;
}
.dsh-btw-plain { white-space: pre-wrap; overflow-wrap: anywhere; }
.dsh-btw-pane {
  box-sizing: border-box;
  display: flex;
  flex: 1 1 0;
  flex-direction: column;
  width: 100%;
  min-height: 0;
  min-width: 0;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-base);
  container: dsh-btw-side / inline-size;
}
.dsh-btw-bar {
  display: flex;
  flex: none;
  align-items: center;
  gap: 8px;
  min-height: 38px;
  padding-inline: 10px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
}
.dsh-btw-bar-title {
  min-width: 0;
  margin: 0;
  overflow: hidden;
  font-size: var(--dsh-content-font-size-secondary, 13px);
  font-weight: 500;
  line-height: 1.5;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsh-btw-list, .dsh-btw-thread {
  flex: 1 1 0;
  min-width: 0;
  min-height: 0;
  overflow: auto;
  overscroll-behavior: contain;
}
.dsh-btw-list { padding: 10px 8px 12px; }
.dsh-btw-history { display: grid; gap: 2px; margin: 0; padding: 0; list-style: none; }
.dsh-btw-row {
  display: grid;
  width: 100%;
  min-height: 36px;
  grid-template-columns: minmax(0, 1fr) auto 12px;
  align-items: center;
  gap: 8px;
  padding: 5px 8px;
  border: 0;
  border-radius: var(--dsw-radius-sm);
  background: transparent;
  color: var(--dsw-alias-label-primary);
  text-align: start;
  font: inherit;
  font-size: var(--dsh-content-font-size-secondary, 13px);
  cursor: pointer;
}
.dsh-btw-row-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-btw-row > svg, .dsh-btw-time { color: var(--dsw-alias-label-tertiary); }
.dsh-btw-time { font-size: 11px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.dsh-btw-row { box-sizing: border-box; }
@container dsh-btw-side (max-width: 240px) {
  .dsh-btw-row { grid-template-columns: minmax(0, 1fr) 12px; column-gap: 5px; row-gap: 1px; }
  .dsh-btw-row-time { grid-column: 1; grid-row: 2; min-width: 0; }
  .dsh-btw-row-time .dsh-btw-time { white-space: normal; overflow-wrap: anywhere; }
  .dsh-btw-row > svg { grid-column: 2; grid-row: 1 / 3; }
}
.dsh-btw-thread { padding: 14px 12px; }
.dsh-btw-turn { display: flex; min-width: 0; flex-direction: column; align-items: stretch; gap: 12px; }
.dsh-btw-turn + .dsh-btw-turn { margin-top: 16px; }
.dsh-btw-message-user { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; min-width: 0; }
.dsh-btw-user-fallback {
  box-sizing: border-box;
  max-width: 100%;
  border-radius: var(--dsw-radius-xl);
  corner-shape: superellipse(1.5);
  padding: 10px 16px;
  background: var(--dsw-specific-bubble);
  font-size: var(--dsh-content-font-size, 14px);
  line-height: calc(22px + var(--dsh-content-font-delta, 0px));
}
.dsh-btw-message-assistant {
  min-width: 0;
  color: var(--dsw-alias-label-primary);
  font-size: var(--dsh-content-font-size, 14px);
  line-height: calc(24px + var(--dsh-content-font-delta, 0px));
  overflow-wrap: anywhere;
}
.dsh-btw-message-actions {
  display: flex;
  align-items: center;
  height: calc(28px + var(--dsh-content-font-delta, 0px));
  gap: 8px;
  color: var(--dsw-alias-label-tertiary);
}
.dsh-btw-message-actions .dsh-btw-icon-button {
  width: calc(28px + var(--dsh-content-font-delta, 0px));
  height: calc(28px + var(--dsh-content-font-delta, 0px));
  padding: 6px;
  border-radius: var(--dsw-radius-sm);
  corner-shape: inherit;
}
.dsh-btw-message-actions .dsh-btw-icon-button:hover:not(:disabled) { color: var(--dsw-alias-label-secondary); }
.dsh-btw-message-actions .dsh-btw-time {
  font-size: var(--dsh-content-font-size-secondary, 13px);
  line-height: calc(24px + var(--dsh-content-font-delta, 0px));
  font-variant-numeric: normal;
}
.dsh-btw-message-user .dsh-btw-message-actions { justify-content: flex-end; }
.dsh-btw-message-user .dsh-btw-time { padding-inline-end: 12px; }
.dsh-btw-message-assistant .dsh-btw-message-actions { margin-block-start: 16px; margin-inline-start: -6px; }
.dsh-btw-message-end-info { display: inline-flex; align-items: center; gap: 8px; min-width: 0; margin-inline-start: 8px; }
.dsh-btw-message-end-info .dsh-btw-time { color: inherit; font-size: calc(var(--dsh-content-font-size-secondary, 13px) - 1px); }
@media (hover: hover) {
  [data-btw-actions-reveal='hover']:not(:hover):not(:focus-within) .dsh-btw-message-actions:not(:has([aria-expanded='true'])) { opacity: 0; }
}
@media (hover: hover) and (prefers-reduced-motion: no-preference) {
  [data-btw-actions-reveal='hover'] .dsh-btw-message-actions { transition: opacity 80ms ease; }
}
.dsh-btw-message-user .dsh-btw-icon-button svg {
  width: calc(15px + var(--dsh-content-font-delta, 0px));
  height: calc(15px + var(--dsh-content-font-delta, 0px));
}
.dsh-btw-message-assistant .dsh-btw-icon-button svg {
  width: calc(17px + var(--dsh-content-font-delta, 0px));
  height: calc(17px + var(--dsh-content-font-delta, 0px));
}
.dsh-btw-turn-usage {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  height: calc(28px + var(--dsh-content-font-delta, 0px));
  padding: 6px 8px;
  border: 0;
  border-radius: var(--dsw-radius-sm);
  background: transparent;
  color: inherit;
  cursor: pointer;
  font-size: calc(var(--dsh-content-font-size-secondary, 13px) - 1px);
  font-variant-numeric: tabular-nums;
  line-height: calc(24px + var(--dsh-content-font-delta, 0px));
  white-space: nowrap;
}
.dsh-btw-turn-usage:focus-visible {
  outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: -2px;
}
.dsh-btw-turn-usage svg {
  flex: none;
  width: calc(15px + var(--dsh-content-font-delta, 0px));
  height: calc(15px + var(--dsh-content-font-delta, 0px));
}
.dsh-btw-turn-usage span { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.dsh-btw-turn-usage[aria-expanded='true'] { background: var(--dsw-alias-interactive-bg-hover); }
@media (hover: hover) {
  .dsh-btw-turn-usage:hover { background: var(--dsw-alias-interactive-bg-hover); }
}
@container dsh-btw-side (max-width: 300px) {
  .dsh-btw-turn-usage { justify-content: center; width: calc(28px + var(--dsh-content-font-delta, 0px)); padding: 6px; }
  .dsh-btw-turn-usage span { display: none; }
}
.dsh-btw-turn-usage-panel { margin: 6px 0 0; border-radius: var(--dsw-radius-sm); }
.dsh-btw-turn-usage-panel .dsh-btw-stat-details { padding: 8px 10px; font-size: var(--dsh-content-font-size-secondary, 13px); }
.dsh-btw-context-track, .dsh-btw-context-fill { fill: none; stroke-width: 2; }
.dsh-btw-context-track { stroke: var(--dsw-alias-border-l3); }
.dsh-btw-context-fill { stroke: var(--dsw-alias-label-tertiary); stroke-linecap: round; }
/* Match the native file sidebar's loading note. */
.dsh-btw-list:has(> .dsh-btw-loading-note) { padding-block-start: 8px; }
.dsh-btw-loading-note {
  margin: 0;
  padding: 3px 10px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 1.5;
}
.dsh-btw-feedback { margin: 6px 8px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.dsh-btw-turn-feedback { margin: 3px 0 0; }
.dsh-btw-failure { color: var(--dsw-alias-state-error-primary); }
.dsh-btw-retry {
  margin-inline-start: 6px;
  padding: 2px 6px;
  border: 0;
  border-radius: var(--dsw-radius-sm);
  background: transparent;
  color: var(--dsw-alias-state-business-primary);
  font: inherit;
  cursor: pointer;
}
.dsh-btw-reply-dock { box-sizing: border-box; flex: none; min-width: 0; padding: 0 10px max(4px, env(safe-area-inset-bottom)); }
.dsh-btw-audit {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-wrap: wrap;
  gap: 0 12px;
  min-height: calc(22px + var(--dsh-content-font-delta-secondary, 0px));
  max-width: 100%;
  padding-top: 4px;
  font-size: calc(var(--dsh-content-font-size-secondary, 13px) - 1px);
  line-height: calc(20px + var(--dsh-content-font-delta-secondary, 0px));
  font-variant-numeric: tabular-nums;
}
.dsh-btw-stat { display: flex; min-width: 0; max-width: 100%; }
.dsh-btw-stat-trigger {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  max-width: 100%;
  box-sizing: border-box;
  padding: 1px 8px;
  border: 0;
  border-radius: var(--dsw-radius-sm);
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  font: inherit;
  white-space: nowrap;
}
summary.dsh-btw-stat-trigger { cursor: pointer; }
.dsh-btw-stat-trigger::-webkit-details-marker { display: none; }
.dsh-btw-stat-trigger:focus-visible {
  outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: -2px;
}
.dsh-btw-stat-trigger svg { flex: none; display: block; }
.dsh-btw-stat[open] > .dsh-btw-stat-trigger {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-secondary);
}
@media (hover: hover) {
  summary.dsh-btw-stat-trigger:hover {
    background: var(--dsw-alias-interactive-bg-hover);
    color: var(--dsw-alias-label-secondary);
  }
}
.dsh-btw-stat-label { min-width: 0; text-align: start; white-space: normal; overflow-wrap: anywhere; }
.dsh-btw-stat-reading { display: inline-block; max-width: 100%; }
.dsh-btw-stat-sep { margin-inline: 6px; color: var(--dsw-alias-separator-primary); }
.dsh-btw-stat-panel {
  position: absolute;
  z-index: 1;
  inset-inline: 0;
  bottom: calc(100% + 8px);
  box-sizing: border-box;
  width: min(100%, 440px);
  max-height: 45dvh;
  margin-inline: auto;
  overflow: auto;
  padding: 16px;
  border-radius: var(--dsw-radius-lg);
  background: var(--dsw-specific-menu);
  backdrop-filter: var(--dsw-menu-backdrop-filter);
  --dsw-elevation-stroke-color: var(--dsw-alias-border-l1);
  box-shadow: var(--dsw-elevation-prominent);
  color: var(--dsw-alias-label-secondary);
  line-height: 18px;
}
.dsh-btw-stat-heading {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0 0 10px;
  padding-bottom: 8px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l2);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-weight: 500;
}
.dsh-btw-stat-heading svg { flex: none; }
.dsh-btw-stat-details {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 6px 16px;
  margin: 0;
  color: var(--dsw-alias-label-tertiary);
}
.dsh-btw-stat-details dd { margin: 0; text-align: end; color: var(--dsw-alias-label-secondary); }
@container dsh-btw-side (max-width: 300px) {
  .dsh-btw-audit { gap: 0 4px; }
  .dsh-btw-stat-trigger { padding-inline: 4px; }
}

.dsh-btw-form {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: 100%;
  padding-top: 8px;
  border: 0;
  --dsw-elevation-stroke-color: var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-panel);
  corner-shape: superellipse(1.5);
  background: var(--dsw-specific-input-major);
  box-shadow: var(--dsw-elevation-soft);
  font-size: var(--dsh-content-font-size, 14px);
  line-height: calc(24px + var(--dsh-content-font-delta, 0px));
  --dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2);
  --dsh-scrollbar-thumb-hover: var(--dsw-alias-scrollbar-hover-l2);
}
.dsh-btw-input {
  display: block;
  box-sizing: border-box;
  width: calc(100% - 4px);
  min-height: 36px;
  max-height: min(var(--dsh-composer-text-max-height, 336px), max(42px, 28dvh));
  margin-inline-end: 4px;
  padding: 4px 8px 0 14px;
  resize: none;
  border: none;
  background: transparent;
  color: inherit;
  caret-color: var(--dsw-alias-state-business-primary);
  font: inherit;
  font-weight: 400;
}
.dsh-btw-input:focus { outline: none; }
.dsh-btw-input:disabled { color: var(--dsw-alias-label-tertiary); opacity: .6; }
@supports (field-sizing: content) { .dsh-btw-input { field-sizing: content; } }
.dsh-btw-input::placeholder { color: var(--dsw-alias-label-caption); font: inherit; opacity: 1; }
@media (pointer: coarse) {
  .dsh-btw-form { font-size: max(16px, var(--dsh-content-font-size, 14px)); }
  .dsh-btw-input { max-height: min(var(--dsh-composer-text-max-height, 336px), max(42px, 22dvh)); }
}
.dsh-btw-form-actions { display: flex; justify-content: flex-end; align-items: center; gap: 8px; padding: 2px 8px 6px; }
.dsh-btw-mic { color: var(--dsw-alias-label-primary); }
.dsh-btw-mic[data-recording='true'] { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-btw-send {
  width: 34px;
  height: 34px;
  color: var(--dsw-alias-label-on-color);
  background: var(--dsw-alias-button-info-fill);
  transform: translateY(-2px);
}
.dsh-btw-send:disabled[data-sending='true'] { opacity: 1; cursor: progress; }
@media (hover: hover) {
  .dsh-btw-send:hover:not(:disabled) { color: var(--dsw-alias-label-on-color); background: var(--dsw-alias-button-info-hover); }
}
.dsh-btw-sr {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  border: 0;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
`;

const emptyRecord = Object.freeze({});
const emptySnapshot = Object.freeze({ cards: emptyRecord, pane: null, notice: emptyRecord });
const noSubscribe = () => () => {};
const noImage = async () => undefined;
const emptyContent = Object.freeze([]);
const alwaysNearBottom = 42;

export function orderHistory(rows) {
  return [...rows].sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
}

function isRunning(status) {
  return status === 'generating' || status === 'running' || status === 'streaming' || status === 'pending';
}

// Like DSH's token meter, omitted cache buckets count as zero for reported usage.
export function summarizeUsage(turns) {
  let uncached = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let output = 0;
  let totalOnly = 0;
  for (const { usage, status } of turns) {
    if (!usage || isRunning(status)) continue;
    uncached += usage.inputTokens ?? 0;
    cacheRead += usage.cacheReadTokens ?? 0;
    cacheWrite += usage.cacheWriteTokens ?? 0;
    output += usage.outputTokens ?? 0;
    if (usage.inputTokens === undefined && usage.cacheReadTokens === undefined &&
        usage.cacheWriteTokens === undefined && usage.outputTokens === undefined) {
      totalOnly += usage.totalTokens ?? 0;
    }
  }
  const prompt = uncached + cacheRead + cacheWrite;
  return { uncached, cacheRead, cacheWrite, output, total: prompt + output + totalOnly,
    cacheRatio: prompt > 0 ? cacheRead / prompt : null };
}

export function formatTokenCount(value) {
  const format = amount => String(amount >= 100 ? Math.round(amount) : Math.round(amount * 10) / 10);
  if (value < 1_000) return String(value);
  if (value < 1_000_000) return `${format(value / 1_000)}K`;
  return `${format(value / 1_000_000)}M`;
}

export function contextReading(context) {
  const { estimatedTokens: used, contextWindow } = context ?? {};
  if (!Number.isSafeInteger(contextWindow) || contextWindow <= 0 || !Number.isSafeInteger(used) || used < 0) return null;
  return { used, contextWindow, percent: Math.min(100, Math.round(used / contextWindow * 100)) };
}

export function formatMessageTime(value, language, now = Date.now()) {
  if (value === undefined || value === null) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const today = new Date(now);
  const pad = number => String(number).padStart(2, '0');
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  if (date.toDateString() === today.toDateString()) return clock;
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const sameYear = year === today.getFullYear();
  const label = language?.startsWith('zh')
    ? `${sameYear ? '' : `${year}年`}${month}月${day}日`
    : sameYear ? `${month}/${day}` : `${year}-${month}-${day}`;
  return `${label} ${clock}`;
}

function formatCacheRatio(ratio, language, decimals = 0) {
  if (ratio === null) return null;
  const format = digits => new Intl.NumberFormat(language || undefined, { style: 'percent', maximumFractionDigits: digits }).format(ratio);
  const rounded = format(decimals);
  if (ratio === 1 || rounded !== new Intl.NumberFormat(language || undefined, { style: 'percent' }).format(1)) return rounded;
  // Keep genuine partial hits distinct from 100% even at high precision.
  return format(Math.min(15, Math.max(decimals + 1, Math.ceil(-Math.log10((1 - ratio) * 100)))));
}

function turnStatus(status) {
  if (status === 'interrupted' || status === 'cancelled') return 'interrupted';
  if (status === 'error' || status === 'failed') return 'replyFailed';
  return '';
}

function acceptDetail(previous, next) {
  if (!next || !Array.isArray(next.turns)) return previous;
  if (previous && next.version < previous.version) return previous;
  return next;
}

function formatTime(value, language) {
  if (value === undefined || value === null) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const full = { dateStyle: 'medium', timeStyle: 'short' };
  const short = { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' };
  const options = date.getFullYear() === new Date().getFullYear() ? short : full;
  return {
    dateTime: date.toISOString(),
    text: date.toLocaleString(language || undefined, options),
    title: date.toLocaleString(language || undefined, full),
  };
}

function releaseCapture(active) {
  if (!active) return;
  clearTimeout(active.timer);
  const { recorder, stream } = active;
  if (recorder?.state === 'recording') {
    try { recorder.stop(); } catch { /* Device already ended. */ }
  }
  stream?.getTracks().forEach(track => track.stop());
}

// Speech Remote expects 16 kHz mono PCM16 WAV. Only browser capture is local.
async function transcodeWav(blob, maxDurationSeconds, signal) {
  const rate = 16_000;
  const context = new OfflineAudioContext(1, 1, rate);
  const decoded = await context.decodeAudioData(await blob.arrayBuffer());
  signal.throwIfAborted();
  const count = Math.min(decoded.length, Math.floor(rate * maxDurationSeconds));
  if (!count) throw new Error('empty');
  const offline = new OfflineAudioContext(1, count, rate);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start();
  const mono = (await offline.startRendering()).getChannelData(0);
  signal.throwIfAborted();
  const bytes = new Uint8Array(44 + mono.length * 2);
  const view = new DataView(bytes.buffer);
  const writeAscii = (offset, text) => {
    for (let index = 0; index < text.length; index += 1) bytes[offset + index] = text.charCodeAt(index);
  };
  writeAscii(0, 'RIFF');
  view.setUint32(4, bytes.length - 8, true);
  writeAscii(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, 'data');
  view.setUint32(40, mono.length * 2, true);
  for (let index = 0; index < mono.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, mono[index]));
    view.setInt16(44 + index * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
  }
  return new Blob([bytes], { type: 'audio/wav' });
}

// Tabler Icons v3.31.0, message-circle-question (MIT; see NOTICE).
const sideQuestionPaths = [
  'M15.02 19.52c-2.341 .736 -5 .606 -7.32 -.52l-4.7 1l1.3 -3.9c-2.324 -3.437 -1.426 -7.872 2.1 -10.374c3.526 -2.501 8.59 -2.296 11.845 .48c1.649 1.407 2.575 3.253 2.742 5.152',
  'M19 22v.01',
  'M19 19a2.003 2.003 0 0 0 .914 -3.782a1.98 1.98 0 0 0 -2.414 .483',
];

// Reference ui-theme's live sprite for ordinary controls.
const glyphs = {
  up: ['chevron-up-outline-regular', 14],
  down: ['chevron-down-outline-regular', 14],
  right: ['chevron-right-outline-regular', 14],
  back: ['chevron-left-outline-regular', 14],
  close: ['close-outline-regular', 14],
  open: ['share-outline-regular', 14],
  copy: ['copy-outline-regular', 14],
  check: ['check-outline-regular', 14],
  mic: ['microphone-outline-regular', 18],
  stop: ['stop-fill-regular', 14],
  send: ['send-outline-medium', 16],
  database: ['database-outline-regular', 14],
  gauge: ['gauge-outline-regular', 14],
};

// Match native StateDot's document-time phase when the SVG mounts or its CSS restarts.
function pinSpinner(element) {
  for (const animation of element.getAnimations?.({ subtree: true }) ?? []) animation.startTime = 0;
}

function syncSpinner(element) {
  if (!element) return;
  pinSpinner(element);
  element.addEventListener('animationstart', restartSpinner);
}

function restartSpinner(event) {
  pinSpinner(event.currentTarget);
}

export function createViews(React) {
  const {
    Fragment, createElement: h, useCallback, useEffect, useId, useLayoutEffect,
    useMemo, useRef, useState, useSyncExternalStore,
  } = React;

  function useSnapshot(controller) {
    const { subscribe, getSnapshot } = useMemo(() => controller ? {
      subscribe: listener => controller.subscribe(listener),
      getSnapshot: () => controller.getSnapshot(),
    } : { subscribe: noSubscribe, getSnapshot: () => emptySnapshot }, [controller]);
    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  }

  function SideQuestionIcon({ className, size = 14 }) {
    return h('svg', {
      className, width: size, height: size, viewBox: '0 0 24 24',
      fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
      'aria-hidden': true, focusable: false,
    }, sideQuestionPaths.map(path => h('path', { key: path, d: path })));
  }

  function WaitingSpinner() {
    return h('svg', {
      ref: syncSpinner, className: 'dsh-btw-waiting-spinner', 'data-state': 'ongoing',
      width: 14, height: 14, viewBox: '0 0 24 24', 'aria-hidden': true,
    }, h('g', { className: 'dsh-btw-spinner-motion' },
      h('circle', { className: 'dsh-btw-spinner-track', cx: 12, cy: 12, r: 9.5 }),
      h('circle', { className: 'dsh-btw-spinner-arc', cx: 12, cy: 12, r: 9.5 })));
  }

  function Icon({ name, className, size }) {
    const [symbol, edge] = glyphs[name];
    return h('svg', {
      className, width: size ?? edge, height: size ?? edge, 'data-icon': symbol,
      'aria-hidden': true, focusable: false,
    }, h('use', { href: `#dsw-icon-${symbol}` }));
  }

  function IconButton({ icon, label, className, children, ...props }) {
    return h('button', {
      type: 'button', className: `dsh-btw-icon-button${className ? ` ${className}` : ''}`,
      'aria-label': label, title: label, ...props,
    }, children ?? h(Icon, { name: icon }));
  }

  function Time({ value, language, message = false }) {
    const date = formatTime(value, language);
    if (!date) return null;
    return h('time', { className: 'dsh-btw-time', dateTime: date.dateTime, title: date.title },
      message ? formatMessageTime(value, language) : date.text);
  }

  function LoadingNote({ t }) {
    return h('p', { className: 'dsh-btw-loading-note', role: 'status' }, t('loading'));
  }

  function Feedback({ text, onRetry, t, error = false, inline = false, id }) {
    return h('div', { id, className: `dsh-btw-feedback${error ? ' dsh-btw-failure' : ''}${inline ? ' dsh-btw-turn-feedback' : ''}`, role: 'status' },
      text, onRetry && h('button', { type: 'button', className: 'dsh-btw-retry', onClick: onRetry }, t('retry')));
  }

  function Markdown({ text, running, renderFactorySlot }) {
    const fallback = h('div', { className: 'dsh-btw-plain' }, text);
    return renderFactorySlot?.('conversation.chat.reasoning.content', { text, running }, { fallback }) ?? fallback;
  }

  function UserMessage({ turn, t, language, renderFactorySlot, actionsReveal }) {
    const text = turn.question;
    const fallback = h('div', { className: 'dsh-btw-plain dsh-btw-user-fallback' }, text);
    const bubble = renderFactorySlot?.('conversation.chat.user.content', {
      content: { text, attachments: emptyContent, extraBlocks: emptyContent },
      loadImage: noImage, facts: emptyRecord, interactive: false,
    }, { fallback }) ?? fallback;
    return h('div', { className: 'dsh-btw-message-user', role: 'group', 'aria-label': t('userMessage'),
      'data-btw-actions-reveal': actionsReveal }, bubble,
      h('div', { className: 'dsh-btw-message-actions' },
        h(Time, { value: turn.createdAt, language, message: true }),
        h(CopyMessage, { text, t })));
  }

  function CopyMessage({ text, t }) {
    const [result, setResult] = useState('');
    const live = useRef(false);
    const timeout = useRef();
    useEffect(() => {
      live.current = true;
      return () => { live.current = false; clearTimeout(timeout.current); };
    }, []);

    async function copy() {
      let next = 'copied';
      try { await navigator.clipboard.writeText(text); }
      catch { next = 'copyFailed'; }
      if (!live.current) return;
      clearTimeout(timeout.current);
      setResult(next);
      timeout.current = setTimeout(() => setResult(''), 1800);
    }

    return h(Fragment, null,
      h(IconButton, { icon: result === 'copied' ? 'check' : 'copy', label: t(result || 'copy'), onClick: copy }),
      result && h('span', { className: 'dsh-btw-sr', role: 'status' }, t(result)));
  }

  function ReplyActions({ turn, t, language, performanceUsage }) {
    const [open, setOpen] = useState(false);
    const trigger = useRef(null);
    const id = useId();
    const { uncached, cacheRead, cacheWrite, output, total, cacheRatio } = summarizeUsage([turn]);
    const enabled = performanceUsage !== 'compact' && total > 0;
    const number = new Intl.NumberFormat(language || undefined);
    const reading = t('auditSpent', { total: `${formatTokenCount(total)} tok` });
    const cache = formatCacheRatio(cacheRatio, language, 1);
    const rows = [[t('auditTotal'), number.format(total)]];
    if (cache !== null) rows.push([t('auditCacheHit'), cache]);
    if (turn.usage?.inputTokens !== undefined) rows.push([t('auditInput'), number.format(uncached)]);
    if (turn.usage?.cacheReadTokens !== undefined) rows.push([t('auditCacheRead'), number.format(cacheRead)]);
    if (turn.usage?.cacheWriteTokens !== undefined) rows.push([t('auditCacheWrite'), number.format(cacheWrite)]);
    if (turn.usage?.outputTokens !== undefined) rows.push([t('auditOutput'), number.format(output)]);
    if (turn.usage?.reasoningTokens !== undefined) rows.push([t('auditReasoning'), number.format(turn.usage.reasoningTokens)]);
    useEffect(() => { if (!enabled) setOpen(false); }, [enabled]);
    return h('div', { onKeyDown: event => {
      if (event.key === 'Escape' && open) {
        event.stopPropagation();
        setOpen(false);
        trigger.current?.focus();
      }
    } },
    h('div', { className: 'dsh-btw-message-actions' },
      h(CopyMessage, { text: turn.reply, t }),
      h('span', { className: 'dsh-btw-message-end-info' },
        enabled && h('button', { type: 'button', className: 'dsh-btw-turn-usage',
          ref: trigger, title: reading, 'aria-label': `${t('auditTurn')} · ${reading}`, 'aria-expanded': open,
          'aria-controls': open ? id : undefined, onClick: () => setOpen(value => !value) },
        h(Icon, { name: 'database' }), h('span', null, reading)),
        h(Time, { value: turn.finishedAt, language, message: true }))),
    enabled && open && h('div', { id, className: 'dsh-btw-turn-usage-panel' },
      h('dl', { className: 'dsh-btw-stat-details' }, rows.map(([title, value]) => h(Fragment, { key: title },
        h('dt', null, title), h('dd', null, value))))));
  }

  function Reply({ turn, t, renderFactorySlot, inline = false, language, performanceUsage, streamFailed = false, overflowNotice }) {
    const running = !turn || isRunning(turn.status);
    const text = turn?.reply ?? '';
    const state = turnStatus(turn?.status);
    if (running && !text.trim()) {
      if (streamFailed) return null;
      return h('div', { className: 'dsh-btw-waiting', role: 'status' },
        h(WaitingSpinner),
        h('span', null, t('waiting')));
    }
    const overflow = turn?.error === CONTEXT_OVERFLOW;
    const failure = overflow ? 'contextOverflow' : state || (!text.trim() ? 'replyFailed' : '');
    return h(Fragment, null,
      text && h(Markdown, { text, running, renderFactorySlot }),
      failure && h(Feedback, { id: overflow ? overflowNotice : undefined,
        text: t(failure), t, error: overflow || failure === 'replyFailed', inline: true }),
      turn?.saveError && h(Feedback, { text: t('archiveWriteFailed'), t, error: true, inline: true }),
      !inline && !running && text && h(ReplyActions, { turn, t, language, performanceUsage }));
  }

  function DockCard({ detail, controller, sessionId, t, renderFactorySlot }) {
    const [expanded, setExpanded] = useState(true);
    const [liveDetail, setLiveDetail] = useState(detail);
    const [failed, setFailed] = useState(false);
    const [sidebarFailed, setSidebarFailed] = useState(false);
    const [retry, setRetry] = useState(0);
    const contentId = useId();
    const id = detail.id;
    const current = acceptDetail(liveDetail, detail.version > liveDetail.version ? detail : null);
    const firstTurn = current.turns[0];
    const running = isRunning(firstTurn?.status);

    useEffect(() => {
      if (!running) return undefined;
      let mounted = true;
      let close;
      setFailed(false);
      try {
        close = controller.watch(sessionId, id, next => {
          if (mounted && next?.sessionId === sessionId && next.id === id) {
            setLiveDetail(previous => acceptDetail(previous, next));
          }
        }, () => { if (mounted) setFailed(true); });
      } catch { setFailed(true); }
      return () => { mounted = false; close?.(); };
    }, [controller, id, retry, running, sessionId]);

    return h('article', { className: 'dsh-btw-card', 'aria-label': t('title') },
      h('header', { className: 'dsh-btw-card-bar' },
        h(SideQuestionIcon, { className: 'dsh-btw-mark' }),
        h('span', { className: 'dsh-btw-title-label' }, t('title')),
        h('div', { className: 'dsh-btw-question', title: detail.question }, detail.question),
        h('div', { className: 'dsh-btw-actions' },
          h(IconButton, { icon: expanded ? 'up' : 'down', label: t(expanded ? 'collapse' : 'expand'), 'aria-expanded': expanded,
            'aria-controls': contentId, onClick: () => setExpanded(value => !value) }),
          h(IconButton, { icon: 'open', label: t('openSidebar'), onClick: () => {
            try { setSidebarFailed(!controller.moveCardToSidebar(sessionId, id)); }
            catch { setSidebarFailed(true); }
          } }),
          h(IconButton, { icon: 'close', label: t('dismiss'), onClick: () => controller.dismiss(sessionId) }))),
      sidebarFailed && h(Feedback, { text: t('sidebarUnavailable'), t, error: true }),
      expanded && h('div', { className: 'dsh-btw-inline-rule', 'aria-hidden': true }),
      h('div', { id: contentId, hidden: !expanded, className: expanded ? 'dsh-btw-inline-reply' : undefined }, expanded && h(Fragment, null,
        firstTurn && h(Reply, { turn: firstTurn, t, renderFactorySlot, inline: true, streamFailed: failed }),
        running && failed && h(Feedback, { text: t('streamFailed'), t, inline: true, error: true,
          onRetry: () => setRetry(value => value + 1) }))));
  }

  function Dock({ controller, sessionId, t, renderFactorySlot }) {
    const snapshot = useSnapshot(controller);
    useEffect(() => { void controller.restoreCard(sessionId); }, [controller, sessionId]);
    const card = snapshot.cards?.[sessionId];
    const notice = snapshot.notice?.[sessionId];
    if (!sessionId || (!card && !notice)) return null;
    return h('div', { className: 'dsh-btw-dock' },
      h('style', null, styles),
      notice && h(Feedback, { text: t(notice), t, error: true }),
      card && h(DockCard, { key: card.id, detail: card, controller, sessionId, t, renderFactorySlot }));
  }

  function List({ controller, sessionId, t, language, focusId, listRevision }) {
    const [load, setLoad] = useState({});
    const [retry, setRetry] = useState(0);
    const scroller = useRef(null);
    const positioned = useRef(false);
    const focusTarget = useRef(null);
    const scopeId = useId();
    useEffect(() => {
      let alive = true;
      Promise.resolve().then(() => controller.call('list', sessionId)).then(rows => {
        if (alive) setLoad({ rows: orderHistory(rows ?? []) });
      }, () => { if (alive) setLoad({ failed: true }); });
      return () => { alive = false; };
    }, [controller, sessionId, retry, listRevision]);
    useLayoutEffect(() => {
      const list = scroller.current;
      if (!load.rows || !list || positioned.current) return;
      positioned.current = true;
      list.scrollTop = list.scrollHeight;
      const previousRow = focusTarget.current;
      if (focusId && previousRow) {
        const rowBounds = previousRow.getBoundingClientRect();
        const listBounds = list.getBoundingClientRect();
        const visible = rowBounds.top >= listBounds.top && rowBounds.bottom <= listBounds.bottom;
        const target = visible ? previousRow : list.querySelector('li:last-child > button');
        target?.focus({ preventScroll: true });
      }
    }, [focusId, load.rows]);
    const reload = () => { setLoad({}); setRetry(value => value + 1); };
    return h(Fragment, null,
      h('header', { className: 'dsh-btw-bar' },
        h(SideQuestionIcon, { className: 'dsh-btw-mark' }),
        h('h2', { id: scopeId, className: 'dsh-btw-bar-title' }, t('listTitle'))),
      h('section', { className: 'dsh-btw-list', ref: scroller, 'aria-labelledby': scopeId },
        load.failed ? h(Feedback, { text: t('loadFailed'), t, onRetry: reload, error: true }) :
          !load.rows ? h(LoadingNote, { t }) :
            load.rows.length === 0 ? h(Feedback, { text: t('emptyList'), t }) :
              h('ul', { className: 'dsh-btw-history' }, load.rows.map(row =>
                h('li', { key: row.id }, h('button', {
                  type: 'button', className: 'dsh-btw-row', title: row.question,
                  ref: focusId === row.id ? focusTarget : null, onClick: () => controller.navigate(sessionId, row.id),
                },
                h('span', { className: 'dsh-btw-row-text' }, row.question),
                h('span', { className: 'dsh-btw-row-time' }, h(Time, { value: row.createdAt ?? row.updatedAt, language })),
                h(Icon, { name: 'right' })))))));
  }

  function useDetail({ controller, sessionId, id, revision, reload }) {
    const [loaded, setLoaded] = useState(null);
    const [failure, setFailure] = useState('');
    const [contextSample, setContextSample] = useState(null);
    const detail = loaded?.revision === revision ? loaded.detail : undefined;
    const context = contextSample?.revision === revision ? contextSample.value : null;
    const turnIndex = detail ? detail.turns.length - 1 : -1;
    const running = isRunning(detail?.turns[turnIndex]?.status);

    useEffect(() => {
      let alive = true;
      setFailure('');
      Promise.resolve().then(() => controller.call('get', sessionId, id)).then(next => {
        if (!alive) return;
        if (next?.id === id && next.sessionId === sessionId) setLoaded({ detail: next, revision });
        else setFailure('missingThread');
      }, () => { if (alive) setFailure('loadFailed'); });
      return () => { alive = false; };
    }, [controller, id, revision, sessionId]);

    useEffect(() => {
      if (turnIndex < 0) return undefined;
      const request = new AbortController();
      Promise.resolve().then(() => controller.call('contextCapacity', sessionId, id, request.signal)).then(result => {
        if (!request.signal.aborted) setContextSample({ revision, value: result });
      }, () => {});
      return () => request.abort();
    }, [controller, id, revision, running, sessionId, turnIndex]);

    useEffect(() => {
      if (!running) return undefined;
      // Use the version at subscription start. Applying a delta must not reconnect the stream.
      return controller.watchReply(sessionId, id, turnIndex, detail.version, update => {
        setLoaded(previous => previous?.revision === revision
          ? { ...previous, detail: applyReply(previous.detail, turnIndex, update) } : previous);
      }, () => setFailure('streamFailed'));
    }, [controller, id, revision, running, sessionId, turnIndex]);

    function accept(receipt) {
      const next = appendTurn(detail, receipt);
      if (next === detail) {
        // Another client can have added a turn between this pane's read and our send.
        reload();
        return;
      }
      setFailure('');
      setLoaded({ detail: next, revision });
    }
    return { detail, context, failure, accept };
  }

  function Thread({ detail, renderFactorySlot, t, language, scrollRef, followRef, streamFailed, performanceUsage, overflowNotice }) {
    useLayoutEffect(() => {
      const thread = scrollRef.current;
      if (thread && followRef.current) thread.scrollTop = thread.scrollHeight;
    }, [detail, followRef, scrollRef]);
    return h('div', {
      className: 'dsh-btw-thread', ref: scrollRef, role: 'region', 'aria-label': t('history'), tabIndex: 0,
      onScroll: event => {
        const node = event.currentTarget;
        followRef.current = node.scrollHeight - node.scrollTop - node.clientHeight <= alwaysNearBottom;
      },
    }, detail.turns.map((turn, index) => {
      const latest = index === detail.turns.length - 1;
      return h('div', { className: 'dsh-btw-turn', key: index },
        h(UserMessage, { turn, t, language, renderFactorySlot, actionsReveal: latest ? 'always' : 'hover' }),
        h('div', { className: 'dsh-btw-message-assistant', role: 'group', 'aria-label': t('assistantMessage'),
          'data-btw-actions-reveal': latest && turn.status === 'completed' && turn.reply.trim() ? 'always' : 'hover' },
        h(Reply, { turn, renderFactorySlot, t, language, performanceUsage, streamFailed: streamFailed && latest,
          overflowNotice: latest ? overflowNotice : undefined })));
    }));
  }

  function useDictation(enabled, controller, insert) {
    const active = useRef(null);
    const [phase, setPhase] = useState('');
    const stop = useCallback(() => {
      const capture = active.current;
      active.current = null;
      capture?.abort.abort();
      releaseCapture(capture);
    }, []);
    const cancel = useCallback(() => { stop(); setPhase(''); }, [stop]);
    useEffect(() => {
      if (!enabled) { cancel(); return undefined; }
      const blur = () => { if (active.current?.phase === 'micRecording') cancel(); };
      const visibility = () => {
        if (document.hidden && active.current && active.current.phase !== 'micTranscribing') cancel();
      };
      const escape = event => {
        if (event.key === 'Escape' && active.current) { event.preventDefault(); cancel(); }
      };
      window.addEventListener('blur', blur);
      document.addEventListener('visibilitychange', visibility);
      document.addEventListener('keydown', escape);
      return () => {
        window.removeEventListener('blur', blur);
        document.removeEventListener('visibilitychange', visibility);
        document.removeEventListener('keydown', escape);
        stop();
      };
    }, [enabled, cancel, stop]);

    async function finish(capture) {
      if (active.current !== capture || capture.phase !== 'micRecording') return;
      capture.phase = 'micTranscribing';
      setPhase(capture.phase);
      clearTimeout(capture.timer);
      try {
        const blob = await new Promise((resolve, reject) => {
          const { recorder, abort } = capture;
          abort.signal.addEventListener('abort', () => reject(abort.signal.reason), { once: true });
          recorder.onstop = () => resolve(new Blob(capture.chunks, { type: recorder.mimeType }));
          recorder.onerror = reject;
          recorder.stop();
        });
        releaseCapture(capture);
        if (capture.abort.signal.aborted) return;
        if (!blob.size) { setPhase('micEmpty'); return; }
        const wav = await transcodeWav(blob, capture.dictation.maxDurationSeconds, capture.abort.signal);
        const text = await capture.dictation.transcribe(wav, capture.abort.signal);
        if (active.current !== capture) return;
        if (typeof text === 'string' && text.trim()) {
          insert(text, capture.selection);
          setPhase('');
        } else setPhase('micEmpty');
      } catch (failure) {
        if (active.current === capture) setPhase(failure?.code === 'btw/recording-too-large' ? 'micTooLarge' : 'micFailed');
      } finally {
        if (active.current === capture) active.current = null;
        releaseCapture(capture);
      }
    }

    async function toggle(selection) {
      if (!enabled) return;
      if (active.current) {
        if (active.current.phase === 'micRecording') await finish(active.current);
        return;
      }
      const dictation = controller.beginDictation();
      if (!dictation) { setPhase('micFailed'); return; }
      const capture = { abort: new AbortController(), chunks: [], selection, dictation, phase: 'micRequesting' };
      active.current = capture;
      setPhase(capture.phase);
      try {
        capture.stream = await navigator.mediaDevices.getUserMedia(dictation.constraints);
        if (active.current !== capture) { releaseCapture(capture); return; }
        const interrupted = () => {
          if (active.current !== capture || capture.phase === 'micTranscribing') return;
          stop();
          setPhase('micInterrupted');
        };
        for (const track of capture.stream.getTracks()) track.addEventListener('ended', interrupted, { signal: capture.abort.signal });
        const recorder = new MediaRecorder(capture.stream);
        capture.recorder = recorder;
        recorder.ondataavailable = event => { if (event.data.size && !capture.abort.signal.aborted) capture.chunks.push(event.data); };
        recorder.onerror = interrupted;
        recorder.onstop = interrupted;
        recorder.start();
        capture.phase = 'micRecording';
        setPhase(capture.phase);
        capture.timer = setTimeout(() => { void finish(capture); }, capture.dictation.maxDurationSeconds * 1000);
      } catch (failure) {
        if (active.current !== capture) { releaseCapture(capture); return; }
        stop();
        if (failure?.name === 'NotAllowedError') setPhase('micPermission');
        else if (['NotFoundError', 'OverconstrainedError'].includes(failure?.name)) setPhase('micMissing');
        else setPhase('micFailed');
      }
    }

    return { toggle, phase, cancel };
  }

  function Composer({ controller, sessionId, id, t, busy, overflowed, overflowNotice,
    dictationAvailable, speechMounted, speechSettings, draftState }) {
    const { text: draft, saving, error } = draftState;
    const [micHelp, setMicHelp] = useState('');
    const [retainedTranscript, setRetainedTranscript] = useState('');
    const input = useRef(null);
    const form = useRef(null);
    const composing = useRef(false);
    const pendingTranscript = useRef(null);
    const selectionAfterInsert = useRef(null);
    const live = useRef(false);
    const inputId = useId();
    useEffect(() => {
      live.current = true;
      return () => { live.current = false; };
    }, []);

    function insertSpeech(text, selection) {
      const node = input.current;
      if (!node || node.disabled) return;
      if (composing.current) {
        pendingTranscript.current = { text, selection };
        return;
      }
      if (selection.revision !== controller.getDraft(sessionId, id).revision) {
        setRetainedTranscript(text);
        return;
      }
      const { start, end } = selection;
      const next = `${node.value.slice(0, start)}${text}${node.value.slice(end)}`;
      const cursor = start + text.length;
      if (next === node.value) {
        node.setSelectionRange(cursor, cursor);
        return;
      }
      selectionAfterInsert.current = cursor;
      controller.setDraft(sessionId, id, next);
    }

    const canRecord = typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia) &&
      typeof MediaRecorder !== 'undefined' && typeof OfflineAudioContext !== 'undefined';
    const locked = overflowed || error === 'contextOverflow';
    const dictation = useDictation(!locked && dictationAvailable && canRecord, controller, insertSpeech);
    useEffect(() => {
      if (dictationAvailable) setMicHelp(current => current === 'micSetup' ? '' : current);
    }, [dictationAvailable]);
    const dictating = ['micRequesting', 'micRecording', 'micTranscribing'].includes(dictation.phase);
    const sendBlocked = locked || busy || saving || dictating || !draft.trim();

    const resize = useCallback(() => {
      if (globalThis.CSS?.supports('field-sizing', 'content')) return;
      const node = input.current;
      if (!node) return;
      const scrollTop = node.scrollTop;
      node.style.height = '0px';
      node.style.height = `${node.scrollHeight}px`;
      if (scrollTop) node.scrollTop = scrollTop;
    }, []);
    useLayoutEffect(() => {
      resize();
      if (selectionAfterInsert.current !== null) {
        input.current?.setSelectionRange(selectionAfterInsert.current, selectionAfterInsert.current);
        selectionAfterInsert.current = null;
      }
    }, [draft, resize]);
    useEffect(() => {
      const element = form.current;
      if (typeof ResizeObserver === 'undefined' || !element) return undefined;
      let lastWidth;
      const observer = new ResizeObserver(([entry]) => {
        if (lastWidth !== entry.contentRect.width) {
          lastWidth = entry.contentRect.width;
          resize();
        }
      });
      observer.observe(element);
      return () => observer.disconnect();
    }, [resize]);

    function submit(event) {
      event.preventDefault();
      if (sendBlocked || composing.current) return;
      void controller.submitDraft(sessionId, id).catch(() => {});
    }

    function keyDown(event) {
      if (event.key === 'Escape' && dictating) {
        event.preventDefault();
        event.stopPropagation();
        dictation.cancel();
      }
      if (locked || event.key !== 'Enter' || event.shiftKey || composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
      event.preventDefault();
      if (!sendBlocked && !event.repeat) form.current?.requestSubmit();
    }

    function finishComposition() {
      composing.current = false;
      const pending = pendingTranscript.current;
      pendingTranscript.current = null;
      if (pending && !locked) queueMicrotask(() => { if (live.current && !input.current?.disabled) insertSpeech(pending.text, pending.selection); });
    }

    function toggleMic() {
      if (locked || saving) return;
      if (!dictationAvailable) {
        setMicHelp(current => current === 'micSetup' ? '' : 'micSetup');
        return;
      }
      if (!canRecord) { setMicHelp('micUnavailable'); return; }
      setMicHelp('');
      const node = input.current;
      if (node) {
        setRetainedTranscript('');
        void dictation.toggle({ start: node.selectionStart, end: node.selectionEnd, revision: controller.getDraft(sessionId, id).revision });
      }
    }

    const composerOverflow = error === 'contextOverflow' && !overflowed;
    return h(Fragment, null,
      error && (!overflowed || error !== 'contextOverflow') && h(Feedback, {
        id: composerOverflow ? overflowNotice : undefined, text: t(error), t, error: true,
      }),
      !locked && micHelp && h('div', { className: 'dsh-btw-feedback' }, h('span', { role: 'status' }, t(micHelp)),
        micHelp === 'micSetup' && speechSettings && h('button', { type: 'button', className: 'dsh-btw-retry',
          onClick: speechSettings }, t('micSettings'))),
      !locked && retainedTranscript && h('div', { className: 'dsh-btw-feedback' },
        h('span', { role: 'status' }, t('micChanged')),
        h('button', { type: 'button', className: 'dsh-btw-retry', onClick: () => {
          const node = input.current;
          if (!node) return;
          insertSpeech(retainedTranscript, { start: node.selectionStart, end: node.selectionEnd, revision: controller.getDraft(sessionId, id).revision });
          setRetainedTranscript('');
        } }, t('micInsert'))),
      !locked && dictation.phase && h(Feedback, { text: t(dictation.phase), t,
        error: ['micFailed', 'micMissing', 'micPermission', 'micTooLarge', 'micInterrupted'].includes(dictation.phase) }),
      h('form', { className: 'dsh-btw-form', ref: form, onSubmit: submit, 'aria-busy': saving,
        'aria-describedby': locked ? overflowNotice : undefined },
        h('label', { className: 'dsh-btw-sr', htmlFor: inputId }, t('input')),
        h('textarea', {
          id: inputId, ref: input, className: 'dsh-btw-input', rows: 1, placeholder: t('placeholder'), value: draft,
          disabled: locked,
          onChange: event => controller.setDraft(sessionId, id, event.target.value),
          onKeyDown: keyDown, onCompositionStart: () => { composing.current = true; }, onCompositionEnd: finishComposition,
        }),
        h('div', { className: 'dsh-btw-form-actions' },
          !locked && dictating && h(IconButton, { icon: 'close', label: t('micCancel'), onClick: dictation.cancel }),
          speechMounted && h(IconButton, {
            className: 'dsh-btw-mic', icon: dictation.phase === 'micRecording' ? 'stop' : 'mic',
            label: t(dictation.phase === 'micRecording' ? 'micStop' : dictationAvailable ? 'micStart' : 'micSettings'),
            disabled: locked || saving || dictation.phase === 'micRequesting' || dictation.phase === 'micTranscribing',
            'data-recording': dictation.phase === 'micRecording', onMouseDown: event => event.preventDefault(), onClick: toggleMic,
          }),
          h(IconButton, { className: 'dsh-btw-send', icon: 'send', label: t('send'), type: 'submit', disabled: sendBlocked,
            'data-sending': saving, 'aria-busy': saving }))));
  }

  function ContextRing({ percent }) {
    const circumference = 2 * Math.PI * 5.5;
    return h('svg', { width: 14, height: 14, viewBox: '0 0 14 14', 'aria-hidden': true, focusable: false },
      h('circle', { className: 'dsh-btw-context-track', cx: 7, cy: 7, r: 5.5 }),
      percent > 0 && h('circle', { className: 'dsh-btw-context-fill', cx: 7, cy: 7, r: 5.5,
        strokeDasharray: `${circumference * percent / 100} ${circumference}`, transform: 'rotate(-90 7 7)' }));
  }

  function AuditPill({ icon, iconElement, title, headline, secondary, rows, group }) {
    const disclosure = useRef(null);
    const trigger = useRef(null);
    const [open, setOpen] = useState(false);
    useEffect(() => {
      if (!open) return;
      const root = disclosure.current;
      if (!root) return;
      const closeOutside = event => {
        if (!event.composedPath().includes(root)) root.open = false;
      };
      const document = root.ownerDocument;
      document.addEventListener('pointerdown', closeOutside, true);
      return () => document.removeEventListener('pointerdown', closeOutside, true);
    }, [open]);
    const label = headline + (secondary ? ` · ${secondary}` : '');
    const marker = iconElement ?? h(Icon, { name: icon });
    const content = h(Fragment, null,
      marker,
      h('span', { className: 'dsh-btw-stat-label' },
        h('span', { className: 'dsh-btw-stat-reading' }, headline),
        secondary && h('span', { className: 'dsh-btw-stat-reading' },
          h('span', { className: 'dsh-btw-stat-sep', 'aria-hidden': true }, '·'), secondary)));
    if (!rows.length) return h('span', { className: 'dsh-btw-stat-trigger', title: label }, content);
    return h('details', {
      className: 'dsh-btw-stat', name: group, ref: disclosure,
      onToggle: event => setOpen(event.currentTarget.open),
      onBlur: event => {
        if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false;
      },
      onKeyDown: event => {
        if (event.key !== 'Escape' || !event.currentTarget.open) return;
        event.stopPropagation();
        event.currentTarget.open = false;
        trigger.current?.focus();
      },
    },
    h('summary', { ref: trigger, className: 'dsh-btw-stat-trigger', title: label,
      'aria-label': `${title} · ${label}` }, content),
    h('div', { className: 'dsh-btw-stat-panel' },
      h('h3', { className: 'dsh-btw-stat-heading' }, marker, title),
      h('dl', { className: 'dsh-btw-stat-details' }, rows.map(([title, value]) => h(Fragment, { key: title },
        h('dt', null, title), h('dd', null, value))))));
  }

  function UsageAudit({ turns, contextSample, performanceUsage, t, language }) {
    const group = useId();
    const compact = performanceUsage === 'compact';
    const settled = turns.filter(turn => !isRunning(turn.status));
    const { uncached, cacheRead, cacheWrite, output, total, cacheRatio } = summarizeUsage(settled);
    let modelMs = 0;
    let firstMs = 0;
    let firstCount = 0;
    let decodeMs = 0;
    let decodeTokens = 0;
    // Native session stats only add timing when an assistant message was committed.
    for (const { timing, usage, status } of settled) {
      if (!timing || status !== 'completed') continue;
      modelMs += timing.requestMs;
      if (timing.firstTokenMs === undefined) continue;
      firstCount += 1;
      firstMs += timing.firstTokenMs;
      const elapsed = timing.requestMs - timing.firstTokenMs;
      if (usage?.outputTokens !== undefined) {
        decodeMs += elapsed;
        decodeTokens += usage.outputTokens;
      }
    }
    const locale = language || undefined;
    const number = new Intl.NumberFormat(locale);
    // Match DSH Chat's compact duration display; its formatter is Client-private.
    const duration = ms => {
      if (ms < 60_000) return t('auditSeconds', { seconds: Math.round(ms / 100) / 10 });
      const seconds = Math.round(ms / 1_000);
      return t('auditMinutes', { minutes: Math.floor(seconds / 60), seconds: seconds % 60 });
    };
    const tokensPerSecond = decodeTokens * 1000 / decodeMs;
    const speed = decodeMs > 0 ? `${tokensPerSecond >= 10 ? Math.round(tokensPerSecond) : Math.round(tokensPerSecond * 10) / 10} tok/s` : null;
    const cache = formatCacheRatio(cacheRatio, locale);
    const cacheText = cache === null ? null : `${t('auditCacheHit')} ${cache}`;
    const counts = `${number.format(settled.length)} ${t('auditRounds')}`;
    const activityRows = [];
    if (modelMs > 0) activityRows.push([t('auditModelTime'), duration(modelMs)]);
    if (firstCount) activityRows.push([t('auditFirstToken'), duration(firstMs / firstCount)]);
    if (speed !== null) activityRows.push([t('auditRate'), speed]);
    const usageRows = [[t('auditTotal'), number.format(total)]];
    if (cache !== null) usageRows.push([t('auditCacheHit'), cache]);
    if (cacheRatio !== null) {
      usageRows.push([t('auditInput'), number.format(uncached)], [t('auditCacheRead'), number.format(cacheRead)]);
      if (cacheWrite > 0) usageRows.push([t('auditCacheWrite'), number.format(cacheWrite)]);
    }
    if (cacheRatio !== null || output > 0) usageRows.push([t('auditOutput'), number.format(output)]);
    const context = contextReading(contextSample);
    return h('div', { className: 'dsh-btw-audit' },
      (compact ? speed !== null : settled.length > 0) && h(AuditPill, {
        icon: 'gauge', title: t('auditActivity'), headline: compact ? speed : counts,
        secondary: compact ? null : speed, rows: compact ? [] : activityRows, group }),
      (compact ? cacheText !== null : total > 0) && h(AuditPill, {
        icon: 'database', title: t('audit'), headline: compact ? cacheText : `${formatTokenCount(total)} tok`,
        secondary: compact ? null : cacheText, rows: compact ? [] : usageRows, group }),
      context && h(AuditPill, { title: t('auditContext'), headline: `${context.percent}%`,
        iconElement: h(ContextRing, { percent: context.percent }), group, rows: [
          [t('auditContextInput'), `${number.format(context.used)} tok`],
          [t('auditContextWindow'), `${number.format(context.contextWindow)} tok`],
        ] }));
  }

  function Chat({ controller, sessionId, id, t, renderFactorySlot, language, dictationAvailable, speechMounted, speechSettings, performanceUsage, pane, onBack }) {
    const [revision, setRevision] = useState(0);
    const reload = () => setRevision(value => value + 1);
    const { detail, context, failure, accept } = useDetail({ controller, sessionId, id, revision, reload });
    const readDraft = useCallback(() => controller.getDraft(sessionId, id), [controller, sessionId, id]);
    const draftState = useSyncExternalStore(controller.subscribeDrafts, readDraft, readDraft);
    const appliedReceipt = useRef(null);
    const heading = useRef(null);
    const scroll = useRef(null);
    const follow = useRef(true);
    useEffect(() => {
      const { receipt } = draftState;
      if (!receipt || !detail || appliedReceipt.current === receipt) return;
      appliedReceipt.current = receipt;
      if (receipt.turnIndex < detail.turns.length) return;
      follow.current = true;
      accept(receipt);
    }, [draftState.receipt, detail, accept]);
    useLayoutEffect(() => { if (!pane.restored) heading.current?.focus({ preventScroll: true }); }, [pane]);
    const question = detail?.question ?? t('title');
    const last = detail?.turns.at(-1);
    const overflowed = last?.error === CONTEXT_OVERFLOW;
    const overflowNotice = useId();
    return h(Fragment, null,
      h('header', { className: 'dsh-btw-bar' },
        h(IconButton, { icon: 'back', label: t('back'), onClick: onBack }),
        h('h2', { className: 'dsh-btw-bar-title', ref: heading, tabIndex: -1, title: question }, question)),
      failure && h(Feedback, { text: t(failure), t, error: true, onRetry: reload }),
      !detail ? !failure && h('div', { className: 'dsh-btw-list' }, h(LoadingNote, { t })) : h(Fragment, null,
        h(Thread, { detail, renderFactorySlot, t, language, scrollRef: scroll, followRef: follow, performanceUsage,
          streamFailed: failure === 'streamFailed', overflowNotice }),
        h('div', { className: 'dsh-btw-reply-dock' },
          h(Composer, { controller, sessionId, id, t,
            busy: isRunning(last?.status) || (draftState.receipt?.turnIndex ?? -1) >= detail.turns.length,
            overflowed, overflowNotice, dictationAvailable, speechMounted, speechSettings, draftState }),
          h(UsageAudit, { turns: detail.turns, contextSample: context, performanceUsage, t, language }))));
  }

  function OpenPane({ controller, sessionId, t, renderFactorySlot, pane, dictationAvailable, speechMounted, speechSettings, language, listRevision, performanceUsage }) {
    const focusId = useRef(null);
    const id = pane.id;
    return h('section', { className: 'dsh-btw-pane', 'aria-label': t('title'), lang: language },
      h('style', null, styles),
      id ? h(Chat, {
        key: id, controller, sessionId, id, pane,
        t, renderFactorySlot, language, dictationAvailable, speechMounted, speechSettings, performanceUsage,
        onBack: () => { focusId.current = id; controller.navigate(sessionId, null); },
      }) : h(List, { key: pane.listOpenedAt, controller, sessionId, t, language, focusId: focusId.current, listRevision }));
  }

  function Pane({ controller, sessionId, t, renderFactorySlot, language }) {
    const snapshot = useSnapshot(controller);
    if (!sessionId || snapshot.pane?.sessionId !== sessionId) return null;
    return h(OpenPane, {
      key: sessionId, controller, sessionId, t, renderFactorySlot, language,
      pane: snapshot.pane, dictationAvailable: snapshot.dictationAvailable, speechMounted: snapshot.speechMounted,
      speechSettings: snapshot.speechSettings, listRevision: snapshot.listRevision, performanceUsage: snapshot.performanceUsage,
    });
  }

  return { Dock, Pane, CommandIcon: SideQuestionIcon };
}
