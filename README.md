# DiceCloud → Forge sync (Abelon)

A small Owlbear Rodeo extension that watches each party member's DiceCloud v2
character sheet and writes their current HP, max HP, and AC straight into
their Forge! unit token — no manual updates during play.

This is a first working prototype, built from a live investigation (see the
`Wiring Forge to DiceCloud` write-up), not a polished/published extension.
It hasn't been run in a real Owlbear Rodeo room yet — expect to iterate on it
together once you see it in action.

## How it works

- A **background page** (invisible, always running while the extension is
  enabled) polls DiceCloud every 8 seconds per mapped character and writes
  any change straight into the token's existing Forge metadata.
- A **popover** (the toolbar icon) is where you configure the DiceCloud
  reader account and which token maps to which character.
- Sync is **one-way**: DiceCloud → Forge. Editing HP by hand in Forge will
  get overwritten on the next poll if it disagrees with DiceCloud — make
  changes on the sheet, not the token, once this is running.
- Only one browser tab needs the extension enabled for sync to keep running
  (normally the GM's) — Owlbear's own sync fans the update out to everyone
  else automatically.

## One-time setup

### 1. A dedicated DiceCloud "reader" account

Sign up for a throwaway DiceCloud account at dicecloud.com — something like
`abelon-sync`. This account only ever needs read access.

Each player then opens their character sheet's **Share** dialog in DiceCloud
and adds that account as a **Reader**. (Not Writer — it never needs to
change anything.)

### 2. Install and build

```sh
npm install
npm run build
```

This produces a static `dist/` folder — the whole extension is just HTML/JS,
no server required.

### 3. Host it somewhere static

Any static host works: Cloudflare Pages, GitHub Pages, Vercel, Netlify. The
important thing is that Owlbear Rodeo can reach `manifest.json` over HTTPS
— and that what it fetches is the **built** output (`dist/`), not the raw
source. `dist/` is git-ignored, so pushing this repo as-is to GitHub does
not, by itself, publish anything servable.

**Using GitHub Pages:** a workflow is already included at
`.github/workflows/deploy.yml` — it builds the project and deploys `dist/`
automatically on every push to `main`. To turn it on:

1. Push this repo to GitHub.
2. In the repo, go to **Settings → Pages**, and set **Source** to **"GitHub
   Actions"** (not "Deploy from a branch" — that only serves whatever's
   literally committed, and `dist/` isn't committed).
3. Push to `main` (or run the workflow manually from the **Actions** tab).
   Check the **Actions** tab for it to go green — first run takes a minute
   or two.
4. The extension's manifest will then be at
   `https://<your-username>.github.io/<repo-name>/manifest.json` — that
   full URL, including `manifest.json`, is what goes into Owlbear Rodeo's
   "add custom extension" field.
5. If the repo is private: GitHub Pages needs either a public repo, or
   GitHub Pro/Team/Enterprise for a private one, on the free plan a private
   repo's Pages site won't serve at all.

**Using Cloudflare Pages/Vercel/Netlify instead** is often less fuss, since
they build from the repo automatically without a workflow file: create a
project, point it at this repo, set the build command to `npm run build`
and the output directory to `dist`, deploy.

### 4. Add it to your Owlbear Rodeo room

In the room, open the extensions menu and add a custom extension by URL,
pointing at wherever `manifest.json` ended up — e.g.
`https://your-deployment.pages.dev/manifest.json`.

### 5. Configure it

Click the extension's icon in the toolbar to open its popover:

- Enter the reader account's username/email and password, and click **Save
  & test login**. (This is stored only in this browser's local storage —
  it's never written into the room, so no other player can read it out.)
- For each Forge unit listed, paste that character's DiceCloud sheet URL
  and click **Save**. It'll do a live check against DiceCloud and show you
  what it found before saving.

From there, the background sync loop takes over.

## Local development

```sh
npm run dev
```

Vite will print a local dev server URL. Owlbear Rodeo extension URLs
generally need to be HTTPS — `localhost` is sometimes allowed for local
testing, but hasn't been confirmed here; if it's rejected, a tunnel (e.g.
`ngrok`) or just deploying to a real static host and iterating from there is
the fallback.

## A note on `public/manifest.json`

The icon/background/popover paths in the manifest are **full, absolute
URLs** (`https://coldsnapdev.github.io/owlbear-dicecloud-sync/...`), not
relative ones. This isn't a style choice — Owlbear Rodeo doesn't resolve a
relative manifest path the way a browser normally would; it appears to just
concatenate its origin onto whatever string is there, which breaks for any
site (like a GitHub Pages project site) that isn't hosted at a bare domain
root. If this ever moves to a different URL, these four fields need to be
updated to match, by hand.

## Known caveats

- **The Forge metadata keys are specific to this campaign.** `src/forge.ts`
  hardcodes `Z005` / `Z006` / `Z007` as current HP / max HP / AC — these
  were captured by watching Owlbear's own WebSocket traffic while editing a
  unit in Forge (Network tab → Socket filter → the room's websocket →
  Messages tab), and confirmed to match across two different party tokens.
  If the underlying Forge "system" ever changes (attributes reordered or
  added ahead of these three), these keys would need to be re-captured the
  same way.
- **The DiceCloud REST endpoint is unofficial.** It isn't publicly
  documented — this was found by reading DiceCloud's own open-source server
  code and confirmed against a real sheet. It could change without notice.
  See `src/dicecloud.ts` for the exact endpoint and field mapping.
- **Not yet tested end-to-end in a real room.** Everything here builds
  cleanly and type-checks against the actual Owlbear Rodeo SDK, but the
  full loop — popover config, background polling, the actual token update
  landing correctly in Forge's UI — hasn't been run live yet.
- If something misbehaves, the background page's `console.log` output
  (prefixed `[dicecloud-sync]`) is the first place to look — open
  DevTools on the Owlbear Rodeo tab and switch the console's context
  dropdown to the extension's background frame.

## Project layout

```
public/manifest.json   Extension manifest
public/icon.svg         Toolbar icon
background.html         Entry point for the always-on sync loop
index.html               Entry point for the settings popover
src/dicecloud.ts         DiceCloud REST client (login, fetch sheet, parse HP/AC)
src/forge.ts             Forge metadata read/write (the Z005/Z006/Z007 keys)
src/config.ts            Credential storage (local) + token↔character mapping (scene metadata)
src/background.ts        The poll loop
src/popover.ts           Settings UI
```
