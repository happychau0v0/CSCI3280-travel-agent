import { useEffect } from "react";
import { PANELS, PANELS_WITH_LIST } from "./useMenuState";

/**
 * Document-level hotkey dispatcher for the NieR-style menu shell.
 *
 * Hotkeys:
 *   1-7        — jump to tab N
 *   ← / →      — when scope=tabs, move tab cursor
 *   ↑ / ↓      — when scope=list, move list cursor
 *   Tab        — cycle scope (tabs → list → detail → tabs)
 *   Enter      — open chat popover
 *   Cmd/Ctrl+K — same as Enter
 *   Space      — activate currently focused item
 *   Esc        — back (closes popover, then leaves scope, then no-op)
 *   M          — toggle mute (auto-TTS)
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

      // Number keys 1-7 → jump to tab
      if (/^[1-7]$/.test(e.key)) {
        e.preventDefault();
        setPanel(PANELS[parseInt(e.key, 10) - 1]);
        return;
      }

      switch (e.key) {
        // ←/→ ALWAYS cycle tabs, regardless of current scope. The scope
        // is just a focus indicator for visual feedback — it shouldn't
        // gate basic navigation.
        case "ArrowLeft": {
          e.preventDefault();
          const idx = PANELS.indexOf(state.panel);
          const next = (idx - 1 + PANELS.length) % PANELS.length;
          setPanel(PANELS[next]);
          break;
        }

        case "ArrowRight": {
          e.preventDefault();
          const idx = PANELS.indexOf(state.panel);
          const next = (idx + 1) % PANELS.length;
          setPanel(PANELS[next]);
          break;
        }

        // ↑/↓ ALWAYS move the list cursor when the current panel has a
        // list. No need to first press Tab to "enter" list scope.
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
          e.preventDefault();
          // Cycle: tabs → list (if available) → detail → tabs
          if (state.scope === "tabs") {
            setScope(PANELS_WITH_LIST.has(state.panel) ? "list" : "tabs");
          } else if (state.scope === "list") {
            setScope("detail");
          } else {
            setScope("tabs");
          }
          break;

        case "Enter":
          e.preventDefault();
          onOpenChat?.();
          break;

        case "k":
        case "K":
          if (e.metaKey || e.ctrlKey) {
            e.preventDefault();
            onOpenChat?.();
          }
          break;

        case " ":
          if (state.scope === "list" || state.scope === "detail") {
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
  ]);
}
