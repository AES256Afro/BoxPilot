# The hosted demo

BoxPilot's demo, frozen so it can be served from a CDN instead of a Node process.

`scripts/demo-bundle.mjs` starts the real demo, asks it for every route in every world, and writes
the answers to `demo-data.json`. Asking the running app rather than rebuilding its fixtures is
deliberate: a second copy of what a route is believed to return is the thing that drifts, and this
repository has been bitten by exactly that more than once.

`worker.js` serves that bundle and the built front end. It mirrors the demo rather than improving on
it, including the 404 for anything outside it, so the hosted copy behaves like the one used for
review.

Nothing here belongs to anybody. Every value is invented, and no request reaches a real machine.

The looks' mockups (`docs/design-directions/05-looks.html`) are served beside the app at
`/mockups/`.

## The password

Everything here, the app, its API, the frozen data and the mockups, is behind one password so
scrapers and AI crawlers get a form and nothing else (`gate.js`). It is the Worker's secret
`DEMO_PASSWORD`, never a file in this repository, and without it every page stays closed rather than
opening up. Unlocking keeps a cookie for 30 days; changing the password signs everyone out. For
`wrangler dev`, put `DEMO_PASSWORD=…` in `demo-site/.dev.vars`, which git ignores.

## Publishing

```sh
npm run demo:publish                        # front end, mockups, assets, frozen API
cd demo-site
npx wrangler secret put DEMO_PASSWORD       # once, or to change it; it asks for the value
npx wrangler deploy
```

`demo:publish` is one command because the copy of the built front end into `public/` used to be a
step people were expected to remember, and the demo has served a page older than the bundle it was
meant to be showing more than once. The precompressed `.gz` twins the build writes are not copied:
Cloudflare compresses at its own edge, so uploading them would be a second copy of every asset for
nothing.

Two things that have already caught me out. A key written after a `[table]` header in TOML belongs
to that table, so `routes` must come before `[assets]` or it is silently swallowed. And Cloudflare
serves static assets before the Worker unless `run_worker_first` is set, which meant `/` came back
as the bare page with no way to reach the empty or broken worlds.
