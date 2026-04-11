import { useEffect } from "react";
import { PANELS, PANELS_WITH_LIST } from "./useMenuState";

/**
 * Document-level hotkey dispatcher for the NieR-style menu shell.
 *
 * Scope model:
 *   - "tabs"  — default. ←/→ cycles tabs.
 *   - "list"  — entered explicitly via Tab key or by clicking a list
 *               item. ←/→ is absorbed (no tab cycling) so the user can
 *               browse the list without accidentally jumping panels.
 *
 * Hotkeys:
 *   1-N        — jump to tab N (always lands in scope=tabs)
 *   ← / →      — cycle tabs ONLY when scope=tabs
 *   ↑ / ↓      — move list cursor (works in any scope on list panels)
 *   Tab        — toggle scope tabs ↔ list (only meaningful on list panels)
 *   T          — open chat popover (was Enter — Enter now free for forms)
 *   Cmd/Ctrl+K — same as T
 *   Space      — activate currently focused item
 *   Esc        — back (closes overlay, then closes popover, then leaves list scope)
 *   M          — toggle mute (auto-TTS)
 *   H          — toggle HISTORY overlay
 *   S          — toggle SETTINGS overlay
 *   E          — handled inside HISTORY overlay only
 *
 * The hook is a passive listener — it calls back into the parent via
 * the handlers object. The parent owns the menu state.
 *
 * Disable hotkeys when the user is typing in an input/textarea by
 * checking the event target's tagName.
 */
export function useKeyboard({
  state,
  setPanel,
  setListIndex,
  setScope,
  listSize, // total items in current panel's left list (for clamping)
  onOpenChat,
  onActivate,
  onBack,
  onToggleMute,
  onOpenHistory,
  onOpenSettings,
  onUndo,
  onRedo,
  onOpenHelp,
  onOpenPrint,
  enabled = true,
}) {
  useEffect(() => {
    if (!enabled) return;

    const handleKey = (e) => {
      // Don't fire hotkeys when the user is typing in an input/textarea
      const target = e.target;
      const tag = target?.tagName;
      const isTypingField =
        tag === "INPUT" || tag === "TEXTAREA" || target?.isContentEditable;
      // Allow Esc to escape inputs but block everything else
      if (isTypingField && e.key !== "Escape") return;

      // Number keys → jump to tab N (clamped to PANELS length)
      const num = parseInt(e.key, 10);
      if (!Number.isNaN(num) && num >= 1 && num <= PANELS.length) {
        e.preventDefault();
        setPanel(PANELS[num - 1]);
        return;
      }

      switch (e.key) {
        // ←/→ cycles tabs ONLY when scope=tabs. When the user has
        // explicitly entered list scope (via Tab key or click), ←/→
        // is absorbed so panels don't get yanked away.
        case "ArrowLeft": {
          if (state.scope !== "tabs") break;
          e.preventDefault();
          const idx = PANELS.indexOf(state.panel);
          const next = (idx - 1 + PANELS.length) % PANELS.length;
          setPanel(PANELS[next]);
          break;
        }

        case "ArrowRight": {
          if (state.scope !== "tabs") break;
          e.preventDefault();
          const idx = PANELS.indexOf(state.panel);
          const next = (idx + 1) % PANELS.length;
          setPanel(PANELS[next]);
          break;
        }

        // ↑/↓ ALWAYS moves the list cursor on a list-bearing panel,
        // regardless of scope. The meaning is unambiguous, so there's
        // no reason to gate it on scope.
        case "ArrowUp":
          if (PANELS_WITH_LIST.has(state.panel) && listSize > 0) {
            e.preventDefault();
            setListIndex(Math.max(0, state.listIndex - 1));
          }
          break;

        case "ArrowDown":
          if (PANELS_WITH_LIST.has(state.panel) && listSize > 0) {
            e.preventDefault();
            setListIndex(Math.min(listSize - 1, state.listIndex + 1));
          }
          break;

        case "Tab":
          // Toggle scope tabs ↔ list. Only meaningful on list panels.
          if (PANELS_WITH_LIST.has(state.panel)) {
            e.preventDefault();
            setScope(state.scope === "tabs" ? "list" : "tabs");
          }
          break;

        case "t":
        case "T":
          if (!e.metaKey && !e.ctrlKey) {
            e.preventDefault();
            onOpenChat?.();
          }
          break;

        case "k":
        case "K":
          if (e.metaKey || e.ctrlKey) {
            e.preventDefault();
            onOpenChat?.();
          }
          break;

        case "z":
        case "Z":
          // Round 12 — Ctrl/Cmd+Z undoes the last flight/hotel pick.
          // Shift+Ctrl/Cmd+Z (or Ctrl+Y) redoes it.
          if (e.metaKey || e.ctrlKey) {
            e.preventDefault();
            if (e.shiftKey) {
              onRedo?.();
            } else {
              onUndo?.();
            }
          }
          break;

        case "y":
        case "Y":
          if (e.metaKey || e.ctrlKey) {
            e.preventDefault();
            onRedo?.();
          }
          break;

        case "?":
          // Round 14 — keyboard help overlay
          e.preventDefault();
          onOpenHelp?.();
          break;

        case "p":
        case "P":
          // Round 17 — open the print-friendly trip view
          if (!e.metaKey && !e.ctrlKey) {
            e.preventDefault();
            onOpenPrint?.();
          }
          break;

        case "h":
        case "H":
          if (!e.metaKey && !e.ctrlKey) {
            e.preventDefault();
            onOpenHistory?.();
          }
          break;

        case "s":
        case "S":
          if (!e.metaKey && !e.ctrlKey) {
            e.preventDefault();
            onOpenSettings?.();
          }
          break;

        case " ":
          if (state.scope === "list") {
            e.preventDefault();
            onActivate?.();
          }
          break;

        case "Escape":
          e.preventDefault();
          onBack?.();
          break;

        case "m":
        case "M":
          if (!e.metaKey && !e.ctrlKey) {
            e.preventDefault();
            onToggleMute?.();
          }
          break;

        default:
          break;
      }
    };

    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [
    enabled,
    state.scope,
    state.panel,
    state.listIndex,
    listSize,
    setPanel,
    setListIndex,
    setScope,
    onOpenChat,
    onActivate,
    onBack,
    onToggleMute,
    onOpenHistory,
    onOpenSettings,
    onUndo,
    onRedo,
    onOpenHelp,
    onOpenPrint,
  ]);
}
