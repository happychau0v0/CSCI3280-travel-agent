import TabStrip from "./TabStrip";
import FooterHints from "./FooterHints";

/**
 * The top-level NieR-style menu shell. Renders the tab strip at top, the
 * active panel in the middle, and the footer hint strip at bottom. The
 * globe sits behind everything as a fixed-position background canvas.
 *
 * Props:
 *   state:       menu state from useMenuState
 *   onTabClick:  (panel) => void  manual tab click
 *   muted:       bool — show 🔇 MUTED badge in footer
 *   overlay:     null | "history" | "settings" — for context-aware
 *                FooterHints
 *   children:    the active panel content (rendered in the panel slot)
 */
export default function MenuShell({
  state,
  onTabClick,
  muted,
  overlay = null,
  agentState = "idle",
  toolTimings = [],
  requestStartedAt = null,
  children,
}) {
  return (
    <div className="menu-shell">
      <TabStrip
        activePanel={state.panel}
        scope={state.scope}
        onTabClick={onTabClick}
        agentState={agentState}
        toolTimings={toolTimings}
        requestStartedAt={requestStartedAt}
      />
      <main className={`panel-slot scope-${state.scope}`}>{children}</main>
      <FooterHints
        muted={muted}
        scope={state.scope}
        panel={state.panel}
        overlay={overlay}
      />
    </div>
  );
}
