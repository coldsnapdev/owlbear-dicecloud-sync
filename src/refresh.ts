// Getting the newest build without waiting out the browser's cache. The scripts have
// versioned names, so only the pages themselves go stale: re-fetching each page with
// cache: "reload" replaces the browser's stored copy, and the next load of that page is
// the new one. Owlbear's frames share one cache, so the popover can refresh the lot.
import { BUILD } from "./build";

export const REFRESH_CHANNEL = "com.abelon.extension/refresh";
const PAGES = ["index.html", "background.html", "pop.html", "bg.html", "strip.html", "dice.html", "dm-panel.html", "manifest.json"];

export async function refreshPages(): Promise<void> {
  await Promise.all(PAGES.map((p) => fetch(new URL(p, location.href).href, { cache: "reload" }).catch(() => undefined)));
}

/** The build number that's actually live on the site right now (undefined if unreachable). */
export async function liveBuild(): Promise<number | undefined> {
  try {
    const r = await fetch(new URL(`version.json?t=${Date.now()}`, location.href).href, { cache: "no-store" });
    return r.ok ? ((await r.json()) as { build?: number }).build : undefined;
  } catch {
    return undefined;
  }
}
export const runningBuild = BUILD;
