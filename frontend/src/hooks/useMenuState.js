import { useCallback, useState } from "react";

/**
 * Single source of truth for the menu state machine.
 *
 * State shape:
 *   {
 *     panel:     "HOME" | "FLIGHTS" | "HOTELS" | "DAYS",
 *     listIndex: number,   // which item in the left list is highlighted
 *     filter:    object | null,  // optional sort/filter set by the LLM
 *   }
 *
 * Navigation:
 *   - Tab cycles panels forward (HOME → FLIGHTS → HOTELS → DAYS → HOME).
 *   - 1–4 jump directly to a panel.
 *   - ↑/↓ always move the list cursor on list-bearing panels.
 *   - Space activates the focused item (pick flight / hotel).
 *
 * Mutated by:
 *  - Manual user input (clicks, Tab, number presses)
 *  - The LLM via the navigate_menu tool, which emits a `navigate` SSE event
 *    that App.jsx routes through `navigate({panel, item, filter})`
 */
export const PANELS = ["HOME", "FLIGHTS", "HOTELS", "DAYS"];

// All four panels have a left-list cursor (form fields on HOME,
// flight/hotel/day rows on the others).
export const PANELS_WITH_LIST = new Set(["HOME", "FLIGHTS", "HOTELS", "DAYS"]);

const INITIAL_STATE = {
  panel: "HOME",
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
      listIndex: 0,
      filter: null,
    }));
  }, []);

  const setListIndex = useCallback((index) => {
    setState((s) => ({ ...s, listIndex: Math.max(0, index) }));
  }, []);

  /** Programmatic navigation triggered by the LLM via navigate_menu. */
  const navigate = useCallback(
    ({ panel, item, filter } = {}) => {
      setState((s) => ({
        ...s,
        panel: PANELS.includes(panel) ? panel : s.panel,
        listIndex: 0,
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
    navigate,
    reset,
  };
}
