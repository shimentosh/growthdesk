import Link from "next/link";
import { Slot } from "radix-ui";
import type { ButtonHTMLAttributes, MouseEventHandler, ReactNode, Ref } from "react";
import { LoaderCircle } from "lucide-react";
import { cn } from "@/lib/cn";

/*
 * Buttons. A filled rectangle with a hairline, 32px tall, 13px text.
 *
 *   primary    Apple blue fill — the one action Return would press
 *   secondary  the default: panel face + strong hairline
 *   ghost      no chrome until hovered — toolbars, row actions
 *   danger     soft red — destructive actions (pair with ConfirmDialog)
 *   tinted     soft accent — an action that should stand out without being primary
 */

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "tinted";
export type ButtonSize = "sm" | "md";

const BASE =
  "inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-sm border font-medium tracking-[-0.005em] transition-colors select-none " +
  "disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 [&_svg]:shrink-0";

const SIZES: Record<ButtonSize, string> = {
  md: "h-8 px-3 text-sm [&_svg]:size-4",
  sm: "h-7 px-2.5 text-xs [&_svg]:size-3.5",
};

const VARIANTS: Record<ButtonVariant, string> = {
  primary: "border-transparent bg-accent font-semibold text-on-accent shadow-solid hover:bg-accent-hi active:bg-accent-deep",
  secondary: "border-line-strong bg-ctl-face text-text shadow-sm hover:bg-ctl-hover",
  ghost: "border-transparent bg-transparent text-text-2 hover:bg-hover hover:text-text",
  danger: "border-transparent bg-bad/10 font-semibold text-bad hover:bg-bad/15",
  tinted: "border-transparent bg-accent/10 font-semibold text-accent-hi hover:bg-accent/15",
};

/** The class string, for the rare element that must look like a button but cannot be one. */
export function buttonClass({ variant = "secondary", size = "md", className }: { variant?: ButtonVariant; size?: ButtonSize; className?: string } = {}) {
  return cn(BASE, SIZES[size], VARIANTS[variant], className);
}

export type ButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a spinner in place of the icon and disables the button. */
  loading?: boolean;
  /** Leading icon, e.g. <Plus />. Sized automatically. */
  icon?: ReactNode;
  /** Trailing icon. */
  iconRight?: ReactNode;
  /** Renders a Next <Link> styled as a button. */
  href?: string;
  /** With href: open in a new tab as a plain <a>. */
  external?: boolean;
  /** Merge the button styling onto the single child element instead (Radix Slot). */
  asChild?: boolean;
  children?: ReactNode;
  ref?: Ref<HTMLButtonElement>;
};

/**
 * `type` defaults to "button" so a button inside a form never submits by
 * accident — pass type="submit" for the submit button.
 */
export function Button({
  variant = "secondary",
  size = "md",
  loading = false,
  icon,
  iconRight,
  href,
  external,
  asChild,
  className,
  children,
  disabled,
  type,
  ...rest
}: ButtonProps) {
  const cls = buttonClass({ variant, size, className });
  const lead = loading ? <LoaderCircle aria-hidden className="animate-spin" /> : icon;
  const content = (
    <>
      {lead}
      {children}
      {iconRight}
    </>
  );

  if (href !== undefined) {
    const common = {
      className: cls,
      title: rest.title,
      "aria-label": rest["aria-label"],
      id: rest.id,
      onClick: rest.onClick as unknown as MouseEventHandler<HTMLAnchorElement> | undefined,
    };
    if (disabled || loading) {
      return (
        <span className={cls} title={rest.title} id={rest.id} aria-disabled="true" role="link">
          {content}
        </span>
      );
    }
    if (external) {
      return (
        <a {...common} href={href} target="_blank" rel="noreferrer noopener">
          {content}
        </a>
      );
    }
    return (
      <Link {...common} href={href}>
        {content}
      </Link>
    );
  }

  if (asChild) {
    return (
      <Slot.Root className={cls} {...(rest as Record<string, unknown>)}>
        {children}
      </Slot.Root>
    );
  }

  return (
    <button type={type ?? "button"} className={cls} disabled={disabled || loading} aria-busy={loading || undefined} {...rest}>
      {content}
    </button>
  );
}

export type IconButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> & {
  /** Required: the accessible name (also the hover title). */
  label: string;
  icon: ReactNode;
  variant?: "ghost" | "secondary" | "danger";
  size?: "sm" | "md";
  ref?: Ref<HTMLButtonElement>;
};

const ICON_VARIANTS = {
  ghost: "border-transparent text-text-2 hover:bg-hover hover:text-text",
  secondary: "border-line-strong bg-ctl-face text-text-2 shadow-sm hover:bg-ctl-hover hover:text-text",
  danger: "border-transparent text-bad hover:bg-bad/10",
} as const;

/** A square button holding only an icon — toolbars, row actions, close marks. */
export function IconButton({ label, icon, variant = "ghost", size = "md", className, type, title, ...rest }: IconButtonProps) {
  return (
    <button
      type={type ?? "button"}
      aria-label={label}
      title={title ?? label}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-sm border transition-colors disabled:pointer-events-none disabled:opacity-50 [&_svg]:shrink-0",
        size === "md" ? "size-8 [&_svg]:size-4" : "size-7 [&_svg]:size-3.5",
        ICON_VARIANTS[variant],
        className,
      )}
      {...rest}
    >
      {icon}
    </button>
  );
}
