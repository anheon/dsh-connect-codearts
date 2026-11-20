/**
 * 组件样式。
 *
 * 参考：dsh-connect-workbuddy（MIT, LaoDing）`src/client/styles.ts` — 前缀化
 *       class 名（`dsm-*`）避免与宿主样式互相污染，以及用 CSS 变量继承宿主
 *       主题色的做法。
 * 改动：前缀改成 `dsc-*`；只保留面板与胶囊两部分，全局 inject 一次，
 *       用 `data-dsc-theme` 挂在根节点上做作用域隔离。
 *
 * @module dsh-connect-codearts/client/styles
 */

/** 注入点的 DOM id。重复挂载时靠它去重。 */
export const CODEARTS_STYLE_ID = 'dsh-connect-codearts-styles'

/**
 * 面板样式。
 *
 * 全部走宿主的 CSS 变量（`--dsh-*`）并给出兜底色值：宿主的浅色/深色主题会
 * 覆盖它们，兜底值只在变量缺席时生效，因此不需要自己写两套主题。
 */
const PANEL_CSS = `
.dsc-panel {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 16px;
  font-size: 13px;
  line-height: 1.55;
  color: var(--dsh-text-primary, #1f2328);
}
.dsc-tabs {
  display: flex;
  gap: 4px;
  border-bottom: 1px solid var(--dsh-border-subtle, rgba(127,127,127,0.22));
}
.dsc-tab {
  padding: 6px 12px;
  border: none;
  background: none;
  color: var(--dsh-text-secondary, #59636e);
  font-size: 13px;
  cursor: pointer;
  border-radius: 6px 6px 0 0;
}
.dsc-tab:hover { background: var(--dsh-surface-hover, rgba(127,127,127,0.08)); }
.dsc-tab[aria-selected='true'] {
  color: var(--dsh-text-primary, #1f2328);
  font-weight: 600;
  box-shadow: inset 0 -2px 0 var(--dsh-accent, #2f6feb);
}
.dsc-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.dsc-section-title {
  font-weight: 600;
  font-size: 13px;
  color: var(--dsh-text-primary, #1f2328);
}
.dsc-welfare-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px 16px;
}
.dsc-switch {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 4px 2px;
  color: inherit;
  font: inherit;
  border: 0;
  border-radius: 4px;
  background: transparent;
  cursor: pointer;
}
.dsc-switch:focus-visible {
  outline: 2px solid var(--dsh-accent, #2f6feb);
  outline-offset: 2px;
}
.dsc-switch:disabled { opacity: 0.55; cursor: default; }
.dsc-switch-track {
  position: relative;
  inline-size: 30px;
  block-size: 16px;
  border-radius: 999px;
  background: var(--dsh-text-tertiary, #6e7781);
}
.dsc-switch-track::after {
  position: absolute;
  inset-block-start: 2px;
  inset-inline-start: 2px;
  inline-size: 12px;
  block-size: 12px;
  border-radius: 50%;
  background: #fff;
  content: '';
}
.dsc-switch[aria-checked='true'] .dsc-switch-track { background: var(--dsh-accent, #2f6feb); }
.dsc-switch[aria-checked='true'] .dsc-switch-track::after { inset-inline-start: 16px; }
.dsc-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-height: 22px;
}
.dsc-label {
  flex: 0 0 96px;
  color: var(--dsh-text-secondary, #59636e);
}
.dsc-value {
  flex: 1 1 auto;
  word-break: break-all;
}
.dsc-mono { font-family: var(--dsh-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); }
.dsc-dim { color: var(--dsh-text-tertiary, #6e7781); }
.dsc-ok { color: var(--dsh-success, #1a7f37); }
.dsc-fail { color: var(--dsh-danger, #cf222e); }
.dsc-pill {
  display: inline-block;
  padding: 1px 7px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  background: var(--dsh-surface-raised, rgba(127,127,127,0.12));
  color: var(--dsh-text-secondary, #59636e);
}
.dsc-pill.accent { background: var(--dsh-accent-soft, rgba(47,111,235,0.14)); color: var(--dsh-accent, #2f6feb); }
.dsc-pill.warn { background: var(--dsh-warning-soft, rgba(154,103,0,0.14)); color: var(--dsh-warning, #9a6700); }
.dsc-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.dsc-table th {
  text-align: left;
  font-weight: 600;
  padding: 6px 8px;
  color: var(--dsh-text-secondary, #59636e);
  border-bottom: 1px solid var(--dsh-border-subtle, rgba(127,127,127,0.22));
  white-space: nowrap;
}
.dsc-table td {
  padding: 5px 8px;
  border-bottom: 1px solid var(--dsh-border-faint, rgba(127,127,127,0.12));
  vertical-align: top;
}
.dsc-table tr:hover td { background: var(--dsh-surface-hover, rgba(127,127,127,0.06)); }
.dsc-num { text-align: right; font-variant-numeric: tabular-nums; }
.dsc-input {
  flex: 1 1 auto;
  padding: 5px 8px;
  border: 1px solid var(--dsh-border-default, rgba(127,127,127,0.32));
  border-radius: 6px;
  background: var(--dsh-surface-input, transparent);
  color: var(--dsh-text-primary, #1f2328);
  font-size: 12px;
  font-family: var(--dsh-font-mono, ui-monospace, monospace);
}
.dsc-btn {
  padding: 5px 12px;
  border: 1px solid var(--dsh-border-default, rgba(127,127,127,0.32));
  border-radius: 6px;
  background: var(--dsh-surface-raised, rgba(127,127,127,0.08));
  color: var(--dsh-text-primary, #1f2328);
  font-size: 12px;
  cursor: pointer;
}
.dsc-btn:hover:not(:disabled) { background: var(--dsh-surface-hover, rgba(127,127,127,0.16)); }
.dsc-btn:disabled { opacity: 0.5; cursor: default; }
.dsc-btn.primary {
  background: var(--dsh-accent, #2f6feb);
  border-color: var(--dsh-accent, #2f6feb);
  color: #fff;
}
.dsc-hint {
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--dsh-surface-raised, rgba(127,127,127,0.08));
  font-size: 12px;
  line-height: 1.7;
}
.dsc-hint ol { margin: 6px 0 0; padding-left: 18px; }
.dsc-hint li { margin: 2px 0; }
.dsc-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.dsc-checks { display: flex; flex-direction: column; gap: 6px; }
.dsc-check { display: flex; gap: 8px; align-items: baseline; }
.dsc-check-name { flex: 0 0 108px; color: var(--dsh-text-secondary, #59636e); }
/* 模型可见性：勾选列、按钮行、隐藏行淡化。 */
.dsc-check {
  vertical-align: middle;
  accent-color: currentColor;
}
.dsc-btn-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
}
.dsc-row-hidden {
  opacity: 0.55;
}

`

/** 输入框右侧胶囊。必须极窄，否则会把模型选择器挤走。 */
const CHIP_CSS = `
.dsc-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11px;
  line-height: 18px;
  white-space: nowrap;
  background: var(--dsh-surface-raised, rgba(127,127,127,0.1));
  color: var(--dsh-text-secondary, #59636e);
  cursor: default;
  user-select: none;
}
.dsc-chip[data-state='ready'] { color: var(--dsh-text-primary, #1f2328); }
.dsc-chip[data-state='error'] { color: var(--dsh-danger, #cf222e); }
.dsc-chip-dot { width: 5px; height: 5px; border-radius: 50%; background: currentColor; opacity: 0.65; }
.dsc-chip-num { font-variant-numeric: tabular-nums; font-weight: 600; }
`

/** 完整样式表。 */
export const CODEARTS_CSS = `${PANEL_CSS}${CHIP_CSS}`

/**
 * 把样式挂到 document 上。幂等：同一个 id 已存在就跳过，因此热重载不会
 * 堆出十几个 `<style>`。
 */
export const ensureStyles = (doc: Document): void => {
  if (doc.getElementById(CODEARTS_STYLE_ID) !== null) return
  const style = doc.createElement('style')
  style.id = CODEARTS_STYLE_ID
  style.textContent = CODEARTS_CSS
  doc.head.append(style)
}
