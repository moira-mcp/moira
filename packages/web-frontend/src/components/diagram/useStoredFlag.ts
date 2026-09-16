/** A boolean the reader toggles and the browser remembers (localStorage, try/catch around it). */

import { useCallback, useState } from "react";

export function useStoredFlag(key: string, initial = false): [boolean, () => void] {
  const [value, setValue] = useState<boolean>(() => {
    try {
      const stored = window.localStorage.getItem(key);
      return stored === null ? initial : stored === "1";
    } catch {
      return initial;
    }
  });
  const toggle = useCallback(() => {
    setValue((was) => {
      try {
        window.localStorage.setItem(key, was ? "0" : "1");
      } catch {
        // storage unavailable: the choice lives for this page only
      }
      return !was;
    });
  }, [key]);
  return [value, toggle];
}
