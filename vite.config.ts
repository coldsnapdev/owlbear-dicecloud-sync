import { defineConfig } from "vite";
import { resolve } from "path";

// Relative base so the built files work whether they're hosted at a domain
// root (Cloudflare Pages, Vercel) or under a sub-path (GitHub Pages project
// sites, e.g. https://you.github.io/obr-dicecloud-sync/).
export default defineConfig({
  base: "./",
  build: {
    rollupOptions: {
      input: {
        popover: resolve(__dirname, "index.html"),
        background: resolve(__dirname, "background.html"),
      },
    },
  },
});
