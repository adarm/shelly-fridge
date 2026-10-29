# Shelly 1 Gen4 → SmartThings Samsung Sabbath Mode

**Status:** Source package prepared and syntax-checked; **not deployed or live-tested** with a refrigerator, Samsung OAuth account, or Hebcal's live response. Validate during weekdays before relying on it for Shabbat/Yom Tov.

## Design

- Shelly 1 Gen4 script sends an HTTPS POST to a Cloudflare Worker every 60 seconds.
- A single Cloudflare Durable Object serializes requests, stores SmartThings OAuth access/rotating refresh tokens, downloads/cache Hebcal Israel calendar (Jerusalem), computes periods, and sends Samsung `samsungce.sabbathMode` `on`/`off` commands on transitions.
- Cloudflare daily cron refreshes token and calendar even if the Shelly is offline. It does **not** toggle the fridge: the Shelly is the trigger.
- Hebcal `b=60` and `m=60` with `M=off`; `i=on` Israel; `maj=on` plus timed candle/Havdalah events. Chag and Shabbat that touch stay ON until final Havdalah. Chol HaMoed is not treated as a prohibited day in its own right.
- No electricity to fridge is switched by Shelly. **Do not connect its output relay to the refrigerator's mains.**

## Requirements

1. Shelly 1 Gen4 on reliable Wi-Fi and mains power, firmware current, web UI Scripts working.
2. Cloudflare account with Workers + Durable Objects enabled; Node.js and npm on a setup computer.
3. SmartThings API OAuth-In app registered with `r:devices:*` and `x:devices:*` scopes, allowed callback `https://YOUR_WORKER_URL/oauth/callback`, and client ID/secret. Follow current SmartThings CLI/API Access App instructions. Your specific app registration may need additional SmartThings review/configuration.
4. Refrigerator's **device ID**, not its human-readable name.

## Cloudflare deploy

```sh
cd shelly-sabbath-bridge
npm install
```

Edit `wrangler.jsonc`:

- `DEVICE_ID`: your actual Samsung refrigerator device ID.
- `PUBLIC_URL`: final Worker URL, without a trailing slash.
- If needed, `name` to avoid an existing name conflict.

Login then deploy:

```sh
npx wrangler login
npx wrangler deploy
```

Take note of the printed `https://...workers.dev` URL. Update `PUBLIC_URL` to match **exactly**, then deploy again.

Create *four* secrets (do not put them in wrangler.jsonc, code, Git, or a screenshot):

```sh
npx wrangler secret put ST_CLIENT_ID
npx wrangler secret put ST_CLIENT_SECRET
npx wrangler secret put ADMIN_KEY
npx wrangler secret put SHELLY_KEY
```

Enter each value only when Wrangler prompts. Generate separate random strings (32+ bytes) for `ADMIN_KEY` and `SHELLY_KEY`, e.g. `openssl rand -hex 32` twice. Register the **identical** `PUBLIC_URL/oauth/callback` redirect URL in SmartThings.

SmartThings documentation: https://developer.smartthings.com/docs/getting-started/quickstart and https://developer.smartthings.com/docs/service-integrations/oauth

### Authorize SmartThings

In your local terminal (replace the URL and secret):

```sh
export BASE='https://shelly-sabbath-bridge.YOUR_SUBDOMAIN.workers.dev'
export ADMIN_KEY='your-admin-secret'
curl -sS -D - -o /dev/null -H "Authorization: Bearer $ADMIN_KEY" "$BASE/start"
```

The response contains a `Location: https://api.smartthings.com/v1/oauth/authorize?...` header. Copy that entire location into a **private browser window**, sign in and authorize access. (The authorization URL contains a one-time CSRF state, not your secret, and expires after 10 minutes.)

If SmartThings refuses OAuth, verify that the SmartThings OAuth client is properly enabled and callback URL matches **exactly**. An API Access App may additionally need a working SmartThings lifecycle callback depending on its registration flow; this example uses OAuth-In and does not implement full SmartApp lifecycle webhooks.

### Verify bridge (before starting Shelly)

```sh
curl -sS -H "Authorization: Bearer $ADMIN_KEY" "$BASE/status"
curl -sS -H "Authorization: Bearer $ADMIN_KEY" "$BASE/inspect"
```

The first should show `linked:true`, and the second should list `nextPeriods`, with timestamps expressed in **UTC milliseconds** (JavaScript epoch). Convert them before comparing with Jerusalem wall-clock times. Inspect includes `shouldBeOn` as of now.

A temporary weekday command test (while the Shelly script is STOPPED):

```sh
curl -sS -H "Authorization: Bearer $ADMIN_KEY" "$BASE/test-on"
# Confirm the physical fridge entered Sabbath Mode.
curl -sS -H "Authorization: Bearer $ADMIN_KEY" "$BASE/test-off"
# Confirm it exited Sabbath Mode.
```

Never do weekday tests after Shabbat/Yom Tov has begun; use appropriate manual controls if any API command fails. A returned HTTP 200 is **not** proof that the appliance changed state.

## Shelly script installation

1. Open `http://SHELLY_IP/` from your home network.
2. **Scripts → Create**; paste `shelly-script.js`.
3. Replace `WORKER` with your URL and `SHELLY_KEY` with the secret of the same name.
4. Run the script on a weekday. Observe the Shelly script log and verify `/status` from your desktop.
5. Enable **Run on startup** and confirm script survives a Shelly restart.
6. Do not give the Shelly relay any electrical connection to the refrigerator. Detached switch setting is optional when no physical switch is being used.

On startup the script polls after 3 seconds and subsequently every 60 seconds. It does not attempt to execute SmartThings API commands itself; the Worker holds those credentials.

## Calendar & reliability

- Israel (`i=on`), Jerusalem (GeoNames ID `281184`), start **60 minutes before sunset**, finish **60 minutes after sunset**.
- All Shabbatot and Israeli Yom Tov: two days Rosh Hashanah, Yom Kippur, first and seventh Pesach days, Shavuot, first Sukkot day and Shemini Atzeret/Simchat Torah. **Not** Chol HaMoed, Hanukkah, Purim, or ordinary fasts.
- The Worker merges consecutive candle-lighting events and ends only at an actual Havdalah event. For Yom Tov adjoining Shabbat, inspect manually with `/inspect` for the relevant date; do **not** use an independent Saturday OFF routine.
- On HTTP failures, the script logs errors and retries next minute. A cached calendar is used for 12 hours; if it expires and Hebcal is unreachable, the command fails **without turning the fridge off**. The Worker can refresh credentials via its UTC daily cron even when the Shelly is off.
- The state command is re-issued every 12 hours while active. This is to recover from restarts and manual overrides; it is **not verified** as a fix for Samsung's possible 85-hour Sabbath Mode limit. Check your model.
- Shelly Wi-Fi, Cloudflare, Hebcal, SmartThings, and the refrigerator internet connection all introduce possible failures. Use manual pre-Shabbat confirmation, especially on Yom Tov and after an outage.
- Additional hardening for unattended operation would include a read-back of actual refrigerator capability status, notifications on error, a longer durable calendar cache, and checks for 85-hour timeout. The provided starter **does not include** these enhancements.

## Testing checklist

- [ ] OAuth link completes and `/status` says `linked:true`.
- [ ] `/inspect` shows a current/next interval matching official Jerusalem sunset calculations.
- [ ] Test ON and OFF on a weekday; confirm the fridge itself changes.
- [ ] Shelly `/tick` produces expected action in logs; check restart recovery.
- [ ] Check a regular Friday/Saturday in `/inspect`: Friday sunset−60m through Saturday sunset+60m.
- [ ] Check Rosh Hashanah (two days) and Yom Kippur schedule.
- [ ] Check a Thursday/Friday Yom Tov immediately followed by Shabbat: exactly one continuous ON period.
- [ ] Check Sunday/Monday holidays immediately following Shabbat: no Saturday OFF in the middle.
- [ ] Check a Chol HaMoed weekday is OFF.
- [ ] Verify the 24-hour access token renews after a day and automation survives a Shelly restart.
- [ ] Simulate temporary internet unavailability on a weekday; review failure/recovery behavior.
- [ ] Verify any Samsung 85-hour auto-exit behavior separately.

## Important limitations

- Not field-tested in this environment. Cloudflare and Samsung APIs can change, and some SmartThings app credentials require a specific onboarding procedure.
- The OAuth callback is protected with an unpredictable one-time state; `/start` and diagnostics require `ADMIN_KEY`; `/tick` requires a separate Shelly key.
- Secrets and OAuth tokens are never returned from `/status`; Cloudflare stores rotating tokens in the Durable Object. Restrict Cloudflare account access and avoid logging secrets.
- One-minute polling means switching may be delayed up to approximately a minute plus network latency. Consider a larger start buffer if this is unacceptable.
- The hourly/daily maintenance job is at 02:17 UTC; the Worker only sends fridge commands when polled by Shelly.
- Confirm halachic suitability and manual failover requirements independently.
