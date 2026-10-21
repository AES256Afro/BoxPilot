# The hosted demo

BoxPilot's demo, frozen so it can be served from a CDN instead of a Node process.

`scripts/demo-bundle.mjs` starts the real demo, asks it for every route in every world, and writes
the answers to `demo-data.json`. Asking the running app rather than rebuilding its fixtures is
deliberate: a second copy of what a route is believed to return is the thing that drifts, and this
repository has been bitten by exactly that more than once.

`worker.js` serves that bundle and the built front end. It mirrors the demo rather than improving on
it, including the 404 for anything outside it, so the hosted copy behaves like the one used for
review.

Two custom domains are attached to the one Worker, `antifascist.work` and `getnerp.com`, and it
serves the same demo on both: nothing in `worker.js` reads the host, so a visitor keeps the address
they typed through every redirect. Attaching a domain is Cloudflare's to do, and it takes over the
apex's DNS, so whatever that name pointed at before stops being served.

Nothing here belongs to anybody. Every value is invented, and no request reaches a real machine.

The looks' mockups (`docs/design-directions/05-looks.html`) are served beside the app at
`/mockups/`.

## Who may see it

Anyone with the link. From v1.155.0 to 2026-10-12 the whole demo sat behind one password (a
`gate.js` checked on Cloudflare's side) to keep scrapers and AI crawlers out; the owner had it taken
off. Crawlers are still asked to keep out: `robots.txt` disallows everything, and every answer
carries `x-robots-tag: noindex, nofollow, noarchive, nosnippet, noai, noimageai`. The old unlock
form's address (`/__unlock`) sends a stale bookmark to the demo.

## Publishing

```sh
npm run demo:publish                        # front end, mockups, assets, frozen API
cd demo-site
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
