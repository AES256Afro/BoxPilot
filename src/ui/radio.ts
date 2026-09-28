import type { KeyboardEvent } from "react";

const forward = new Set(["ArrowRight", "ArrowDown"]);
const backward = new Set(["ArrowLeft", "ArrowUp"]);

/**
 * Arrow keys, Home and End for a role="radiogroup" of role="radio" buttons, as the ARIA radio
 * pattern has it: focus moves to the next option and selects it. Put it on the group's onKeyDown;
 * each option carries its value in data-value and only the checked one has tabIndex 0.
 */
export function handleRadioKeys(event: KeyboardEvent<HTMLElement>, select: (value: string) => void) {
  const { key } = event;
  if (!forward.has(key) && !backward.has(key) && key !== "Home" && key !== "End") return;
  const radios = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]:not([disabled])')];
  if (radios.length === 0) return;
  const at = radios.indexOf(document.activeElement as HTMLElement);
  const next = key === "Home" ? 0
    : key === "End" ? radios.length - 1
      : forward.has(key) ? (at + 1) % radios.length
        : at <= 0 ? radios.length - 1 : at - 1;
  event.preventDefault();
  radios[next].focus();
  const value = radios[next].dataset.value;
  if (value) select(value);
}
