import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

let counter = 0;
/** collision-resistant id without external deps */
export function genId(prefix = "id"): string {
  counter = (counter + 1) % 0xffff;
  return `${prefix}_${Date.now().toString(36)}${counter
    .toString(36)
    .padStart(3, "0")}${Math.random().toString(36).slice(2, 8)}`;
}
