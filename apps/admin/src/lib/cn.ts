import { clsx, type ClassValue } from "clsx";

/**
 * Joins class names. There is no tailwind-merge: a component's `className`
 * prop is for layout (margin, width, flex, grid placement), not for restyling
 * its colours or size — use the component's variants for that.
 */
export function cn(...inputs: ClassValue[]): string {
  return clsx(inputs);
}
