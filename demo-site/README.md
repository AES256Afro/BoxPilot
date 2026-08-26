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

## Publishing

```sh
npm run build                    # the front end
node scripts/demo-bundle.mjs     # the frozen API
cd demo-site && npx wrangler deploy
```

Two things that have already caught me out. A key written after a `[table]` header in TOML belongs
to that table, so `routes` must come before `[assets]` or it is silently swallowed. And Cloudflare
serves static assets before the Worker unless `run_worker_first` is set, which meant `/` came back
as the bare page with no way to reach the empty or broken worlds.
