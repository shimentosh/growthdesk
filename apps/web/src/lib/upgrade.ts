/*
 * The "plan limit reached" dialog's store. `showUpgrade(error)` opens it from
 * anywhere (useApiMutation calls it for every 402); <UpgradeDialogHost/>,
 * mounted once by the workspace shell, renders it. With no host mounted (a
 * page outside a workspace) the caller falls back to a toast.
 */
import type { ApiError } from "./api";

type Listener = () => void;

let current: ApiError | null = null;
let hosts = 0;
const listeners = new Set<Listener>();

export const upgradeStore = {
  subscribe(listener: Listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  get: () => current,
  registerHost() {
    hosts++;
    return () => {
      hosts--;
    };
  },
};

/** Opens the upgrade dialog. Returns false when no host is mounted (show something else). */
export function showUpgrade(error: ApiError): boolean {
  if (hosts <= 0) return false;
  current = error;
  listeners.forEach((l) => l());
  return true;
}

export function closeUpgrade() {
  current = null;
  listeners.forEach((l) => l());
}
