import type { SVGProps } from "react";

/**
 * The few icons the design system draws itself. The rest of the interface names things in words
 * (and two-letter marks in the navigation), so there is no icon library: these are four shapes.
 * They take the text colour and size, and are hidden from assistive technology: whatever they
 * mark is always said in words too.
 */
type IconProps = Omit<SVGProps<SVGSVGElement>, "children">;

function Svg({ children, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...props}>
      {children}
    </svg>
  );
}

export function LockIcon(props: IconProps) {
  return <Svg {...props}><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></Svg>;
}

export function SunIcon(props: IconProps) {
  return <Svg {...props}><circle cx="12" cy="12" r="4" /><path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4" /></Svg>;
}

export function MoonIcon(props: IconProps) {
  return <Svg {...props}><path d="M20 14.6A8 8 0 0 1 9.4 4a8 8 0 1 0 10.6 10.6z" /></Svg>;
}

export function MonitorIcon(props: IconProps) {
  return <Svg {...props}><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></Svg>;
}
