import { defineConfig } from "vite";
import { resolve } from "path";
import { readFileSync } from "fs";

// version.json: the live build number, so the extension can tell when a newer one is out
const build = Number(readFileSync(resolve(__dirname, "src/build.ts"), "utf8").match(/BUILD = (\d+)/)?.[1] ?? 0);
const versionFile = {
  name: "version-json",
  generateBundle(this: { emitFile: (f: { type: "asset"; fileName: string; source: string }) => void }) {
    this.emitFile({ type: "asset", fileName: "version.json", source: JSON.stringify({ build }) });
  },
};

// Relative base so the built files work whether they're hosted at a domain
// root (Cloudflare Pages, Vercel) or under a sub-path (GitHub Pages project
// sites, e.g. https://you.github.io/obr-dicecloud-sync/).
export default defineConfig({
  base: "./",
  plugins: [versionFile],
  build: {
    rollupOptions: {
      input: {
        popover: resolve(__dirname, "pop.html"),
        background: resolve(__dirname, "bg.html"),
        dmPanel: resolve(__dirname, "dm-panel.html"),
        dice: resolve(__dirname, "dice.html"),
        strip: resolve(__dirname, "strip.html"),
        castPicker: resolve(__dirname, "cast-picker.html"),
        fx: resolve(__dirname, "fx.html"),
        card: resolve(__dirname, "card.html"),
        clock: resolve(__dirname, "clock.html"),
      },
    },
  },
});
