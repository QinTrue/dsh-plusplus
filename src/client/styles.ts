/** Only plugin layout and semantic accents; native primitives own their control styles. */
export const clientStyles = `
:where(.dsh-plusplus-settings) {
  max-width: 560px;
  min-width: 0;
  color: var(--dsw-alias-label-primary);
  font: var(--dsw-font-xs-13);
}
:where(.dsh-plusplus-section-heading, .dsh-plusplus-toggle) {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}
:where(.dsh-plusplus-section-heading h3) {
  margin: 0;
  font: var(--dsw-font-base-strong-16);
}
:where(.dsh-plusplus-description) {
  margin: 8px 0 16px;
  color: var(--dsw-alias-label-secondary);
  line-height: 1.6;
}
:where(.dsh-plusplus-caption) {
  color: var(--dsw-alias-label-tertiary);
  font: var(--dsw-font-xxs-12);
  overflow-wrap: anywhere;
}
:where(.dsh-plusplus-settings fieldset) {
  border: 0;
  margin: 0;
  padding: 0;
  min-width: 0;
}
:where(.dsh-plusplus-toggle) {
  padding: 16px 0;
  margin-bottom: 16px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l2);
}
:where(.dsh-plusplus-field) {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 16px;
  min-width: 0;
}
:where(.dsh-plusplus-field > span:first-child) {
  font-weight: 500;
}
:where(.dsh-plusplus-settings input) {
  width: 100%;
  font-family: inherit;
}
:where(.dsh-plusplus-settings input:disabled) { opacity: .5; }
:where(.dsh-plusplus-generated, .dsh-plusplus-archive-target) {
  margin-top: 16px;
  padding: 12px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-layer-1);
}
:where(.dsh-plusplus-generated > button) { margin-right: 8px; }
:where(.dsh-plusplus-settings details) {
  margin-top: 20px;
  border-top: 0.5px solid var(--dsw-alias-border-l2);
  padding-top: 16px;
}
:where(.dsh-plusplus-settings summary) { cursor: pointer; }
:where(.dsh-plusplus-settings details[open] summary) { margin-bottom: 16px; }
:where(.dsh-plusplus-settings-footer) { padding: 16px 0 8px; }
:where(.dsh-plusplus-settings a) { color: var(--dsw-alias-state-business-primary); }
:where(.dsh-plusplus-error), .dsh-plusplus-archive-dialog .dsh-plusplus-danger {
  color: var(--dsw-alias-state-error-primary);
}
.dsh-plusplus-archive-dialog .dsh-plusplus-danger:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover-danger);
}
:where(.dsh-plusplus-error) { overflow-wrap: anywhere; line-height: 1.6; }
:where(.dsh-plusplus-archive-target) {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 0;
  overflow-wrap: anywhere;
}
:where(.dsh-plusplus-archive-dialog) {
  max-height: 100%;
  overflow-y: auto;
}
`

export function registerClientStyles(ctx: { effect(run: () => () => void): unknown }) {
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.dshPlusplus = 'ui'
    style.textContent = clientStyles
    document.head.append(style)
    return () => style.remove()
  })
}
