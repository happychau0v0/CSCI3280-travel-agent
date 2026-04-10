import { useCallback, useState } from "react";

/**
 * Single source of truth for the menu state machine.
 *
 * State shape:
 *   {
 *     panel:     "MAP" | "TRIP" | "FLIGHTS" | "HOTELS" | "DAYS" | "PROFILE" | "TRANSCRIPT",
 *     scope:     "tabs" | "list" | "detail",  // which area the keyboard cursor is in
 *     listIndex: number,                      // which item in the left list is highlighted
 *     filter:    object | null,               // optional sort/filter set by the LLM
 *   }
 *
 * Mutated by:
 *  - Manual user input (clicks, keyboard arrows, tab number presses)
 *  - The LLM via the navigate_menu tool, which emits a `navigate` SSE event
 *    that App.jsx routes through `navigate({panel, item, filter})`
 */
export const PANELS = [
  "MAP",
  "TRIP",
  "FLIGHTS",
  "HOTELS",
  "DAYS",
  "PROFILE",
  "TRANSCRIPT",
];

export const PANELS_WITH_LIST = new Set(["FLIGHTS", "HOTELS", "DAYS", "PROFILE", "TRANSCRIPT"]);

const INITIAL_STATE = {
  panel: "MAP",
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
      // Reset list cursor and scope when switching panels
      listIndex: 0,
      scope: PANELS_WITH_LIST.has(panel) ? "list" : "tabs",
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
        scope: PANELS_WITH_LIST.has(panel) ? "list" : "tabs",
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
