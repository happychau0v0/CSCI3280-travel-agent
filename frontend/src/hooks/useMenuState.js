import { useCallback, useState } from "react";

/**
 * Single source of truth for the menu state machine.
 *
 * State shape:
 *   {
 *     panel:     "HOME" | "FLIGHTS" | "HOTELS" | "DAYS",
 *     scope:     "tabs" | "list",             // which area the keyboard cursor is in
 *     listIndex: number,                      // which item in the left list is highlighted
 *     filter:    object | null,               // optional sort/filter set by the LLM
 *   }
 *
 * SETTINGS and HISTORY are NOT tabs — they're hotkey-triggered overlays
 * (S and H respectively) owned at the App level outside this hook.
 *
 * Scope semantics:
 *   - "tabs" is the default scope on entry. ←/→ cycles tabs.
 *   - "list" is entered explicitly via Tab key or by clicking a list
 *     item. ←/→ is absorbed (no tab cycling) so the user can browse the
 *     list without accidentally jumping panels.
 *   - ↑/↓ ALWAYS moves the list cursor on a list-bearing panel,
 *     regardless of scope — the meaning is unambiguous.
 *
 * Mutated by:
 *  - Manual user input (clicks, keyboard arrows, tab number presses)
 *  - The LLM via the navigate_menu tool, which emits a `navigate` SSE event
 *    that App.jsx routes through `navigate({panel, item, filter})`
 */
export const PANELS = ["HOME", "FLIGHTS", "HOTELS", "DAYS"];

// HOME absorbed the editable trip form, so it's a list-bearing panel
// (the form's field cursor uses listIndex). FLIGHTS / HOTELS / DAYS
// remain detail/list views. SETTINGS and HISTORY are no longer tabs
// — they're hotkey-triggered overlays.
export const PANELS_WITH_LIST = new Set(["HOME", "FLIGHTS", "HOTELS", "DAYS"]);

const INITIAL_STATE = {
  panel: "HOME",
  scope: "tabs",
  listIndex: 0,
  filter: null,
};

export function useMenuState() {
  const [state, setState] = useState(INITIAL_STATE);

  const setPanel = useCallback((panel) => {
    if (!PANELS.includes(panel)) return;
    setState((s) => ({
      ...s,
      panel,
      // Reset list cursor and scope when switching panels. Always
      // start in "tabs" scope so ←/→ keeps cycling tabs after a jump
      // — the user has to explicitly Tab/click into list scope.
      listIndex: 0,
      scope: "tabs",
    }));
  }, []);

  const setListIndex = useCallback((index) => {
    setState((s) => ({ ...s, listIndex: Math.max(0, index) }));
  }, []);

  const setScope = useCallback((scope) => {
    setState((s) => ({ ...s, scope }));
  }, []);

  /** Programmatic navigation triggered by the LLM via navigate_menu. */
  const navigate = useCallback(
    ({ panel, item, filter } = {}) => {
      setState((s) => ({
        panel: PANELS.includes(panel) ? panel : s.panel,
        // Always land in tabs scope on programmatic navigation. The
        // LLM may want to drive ←/→ via subsequent navigate calls.
        scope: "tabs",
        listIndex: 0, // item-by-name resolution happens in the panel itself
        filter: filter || null,
      }));
      // Item resolution by name (e.g. "non-stop", "Park Hyatt") is handled
      // inside each panel via a useEffect that watches `filter` and `item`.
    },
    [],
  );

  const reset = useCallback(() => setState(INITIAL_STATE), []);

  return {
    state,
    setPanel,
    setListIndex,
    setScope,
    navigate,
    reset,
  };
}
