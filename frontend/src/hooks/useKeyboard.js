import { useEffect } from "react";
import { PANELS, PANELS_WITH_LIST } from "./useMenuState";

/**
 * Document-level hotkey dispatcher for the NieR-style menu shell.
 *
 * Navigation model:
 *   - Tab          — toggle focus between left and right column within the current panel
 *   - 1-4          — jump directly to that panel (resets side to left)
 *   - ↑/↓          — move left-list cursor; on DAYS right side move activity cursor
 *   - Space        — pick the focused item on FLIGHTS or HOTELS
 *   - ←/→          — reserved for sub-components
 *
 * Overlays (H, S, ?, P, L, F, C) are open-only — Esc closes them.
 * The hook is disabled entirely while any overlay is open so each overlay
 * can own its own keyboard handling without leaking events.
 *
 * Hotkeys are suppressed while the user is typing in an input/textarea.
 */
export function useKeyboard({
  state,
  setPanel,
  setListIndex,
  setSide,
  listSize,
  activityListSize = 0,
  activityIndex = 0,
  setActivityIndex,
  onOpenChat,
  onActivate,
  onBack,
  onToggleMute,
  onOpenHistory,
  onOpenSettings,
  onOpenStatus,
  onUndo,
  onRedo,
  onOpenHelp,
  onOpenPrint,
  onOpenChecklist,
  onOpenFavorites,
  enabled = true,
}) {
  useEffect(() => {
    if (!enabled) return;

    const handleKey = (e) => {
      // Suppress hotkeys while typing; allow Esc to escape inputs.
      const target = e.target;
      const tag = target?.tagName;
      const isTypingField =
        tag === "INPUT" || tag === "TEXTAREA" || target?.isContentEditable;
      if (isTypingField && e.key !== "Escape") return;
      if (isTypingField && e.key === "Escape") {
        target.blur();
        return;
      }

      // Number keys → jump to panel N
      const num = parseInt(e.key, 10);
      if (!Number.isNaN(num) && num >= 1 && num <= PANELS.length) {
        e.preventDefault();
        setPanel(PANELS[num - 1]);
        return;
      }

      switch (e.key) {
        // Tab toggles focus between left and right column within the current panel.
        case "Tab":
          e.preventDefault();
          setSide(state.side === "left" ? "right" : "left");
          break;

        // ↑/↓: on DAYS right side → navigate activities; otherwise → move left list cursor.
        case "ArrowUp":
          if (state.side === "right" && state.panel === "DAYS" && activityListSize > 0) {
            if (activityIndex > 0) {
              e.preventDefault();
              setActivityIndex?.(activityIndex - 1);
            }
          } else if (PANELS_WITH_LIST.has(state.panel) && listSize > 0) {
            if (state.listIndex > 0) {
              e.preventDefault();
              setListIndex(state.listIndex - 1);
            }
          }
          break;

        case "ArrowDown":
          if (state.side === "right" && state.panel === "DAYS" && activityListSize > 0) {
            if (activityIndex < activityListSize - 1) {
              e.preventDefault();
              setActivityIndex?.(activityIndex + 1);
            }
          } else if (PANELS_WITH_LIST.has(state.panel) && listSize > 0) {
            if (state.listIndex < listSize - 1) {
              e.preventDefault();
              setListIndex(state.listIndex + 1);
            }
          }
          break;

        // Space picks the focused item on FLIGHTS or HOTELS.
        case " ":
          if (state.panel === "FLIGHTS" || state.panel === "HOTELS") {
            e.preventDefault();
            onActivate?.();
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
          e.preventDefault();
          onOpenHelp?.();
          break;

        case "l":
        case "L":
          if (!e.metaKey && !e.ctrlKey) {
            e.preventDefault();
            onOpenChecklist?.();
          }
          break;

        case "f":
        case "F":
          if (!e.metaKey && !e.ctrlKey) {
            e.preventDefault();
            onOpenFavorites?.();
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

        case "c":
        case "C":
          if (!e.metaKey && !e.ctrlKey) {
            e.preventDefault();
            onOpenStatus?.();
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
    state.panel,
    state.listIndex,
    state.side,
    listSize,
    activityListSize,
    activityIndex,
    setPanel,
    setListIndex,
    setSide,
    setActivityIndex,
    onOpenChat,
    onActivate,
    onBack,
    onToggleMute,
    onOpenHistory,
    onOpenSettings,
    onOpenStatus,
    onUndo,
    onRedo,
    onOpenHelp,
    onOpenPrint,
    onOpenChecklist,
    onOpenFavorites,
  ]);
}
