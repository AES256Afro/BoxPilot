import { createContext, useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";

/*
 * A place in the top bar that Home and every console page fill (M33.7, M33.8). The study's
 * Launcher names the server at the top left ("homebox · Ubuntu 24.04 · up 23 days") and its
 * Command Center puts the page's name and facts in its one compact bar ("homebox / services"), so
 * each view draws its own start of the shell's bar from the facts it already has. The shell
 * provides the element; a view renders into it with a portal. Without a shell (a test, the
 * gallery) there is no slot, and the view decides whether its piece is drawn in place or not at
 * all.
 */

const SlotContext = createContext<HTMLElement | null>(null);

export const TopBarSlotProvider = SlotContext.Provider;

export function TopBarSlot({ children, inPlace = false }: { children: ReactNode; inPlace?: boolean }) {
  const slot = useContext(SlotContext);
  if (slot) return createPortal(children, slot);
  return inPlace ? <>{children}</> : null;
}

/*
 * The server's name, for the start of the console's bar ("homebox / services"). The shell reads it
 * from the facts Home and Ops share (src/shell/ShellHost.tsx); null until it is known, and in a
 * test that draws a page on its own.
 */
const HostContext = createContext<string | null>(null);

export const ShellHostProvider = HostContext.Provider;

export function useShellHost(): string | null {
  return useContext(HostContext);
}
