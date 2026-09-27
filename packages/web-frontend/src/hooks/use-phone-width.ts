import { useEffect, useState } from "react";

/** Below Tailwind's `sm` breakpoint: a phone held upright. */
const PHONE_QUERY = "(max-width: 639px)";

/**
 * Whether the screen is phone-narrow, known on the first render (no flash of the wide layout)
 * and kept current when the window is resized.
 */
export function usePhoneWidth(): boolean {
  const [phone, setPhone] = useState(
    () => typeof window !== "undefined" && window.matchMedia(PHONE_QUERY).matches,
  );
  useEffect(() => {
    const query = window.matchMedia(PHONE_QUERY);
    const onChange = () => setPhone(query.matches);
    onChange();
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return phone;
}
