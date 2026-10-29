# Implementation brief: Shelly 1 Gen4 → Samsung refrigerator Sabbath Mode

**Audience:** Claude Code or another coding agent implementing, testing, and documenting the system.  
**Status (2026-10-18):** Requirements specified; refrigerator API command tested by the owner in SmartThings Advanced; previous prototype source exists but has **not** been deployed or verified end to end. Treat it as a reference, **not** as production-ready code.

## 1. Motivation and objective

The owner has a Samsung smart refrigerator registered with SmartThings. Its mobile app exposes a Sabbath Mode toggle, but the SmartThings Routines UI does **not** expose the toggle as an automation action. In the **SmartThings Advanced Web App**, the owner found the `samsungce.sabbathMode` capability and successfully executed its command. Thus the device supports remote control via this Samsung-specific capability, at least through Advanced.

The objective is to **automatically enable and disable refrigerator Sabbath Mode** for Shabbat and Israeli Yom Tov without manually toggling the app, without adding Home Assistant or a permanently running PC, and without physically switching refrigerator power.

Use an existing **Shelly 1 Gen4**, configured in Jerusalem, as the always-on automation trigger. Use a small **Cloudflare Worker** as a secure bridge to SmartThings and to a Jewish calendar source. **No relay contact may be wired to interrupt power to the refrigerator.**

### Desired behavior

- Every Friday: switch Sabbath Mode **ON 60 minutes before sunset** in Jerusalem.
- Every Saturday: switch **OFF 60 minutes after sunset**, **only if no adjacent Yom Tov continues**.
- Include Israeli Yom Tov, not Diaspora additional days: Rosh Hashanah (two days), Yom Kippur, first and seventh days of Pesach, Shavuot, first day of Sukkot, and Shemini Atzeret/Simchat Torah (one Israeli day).
- Exclude Chol HaMoed weekdays, minor festivals and fast days (unless also Shabbat).
- **Join consecutive observances** into one continuous ON interval: e.g., Yom Tov adjoining Shabbat; Shabbat adjoining Yom Tov; two-day Rosh Hashanah. Never send an intervening OFF command.
- Use the requested **sunset ±60-minute** policy, not necessarily conventional published candle-lighting/Havdalah offsets. Validate actual source event semantics for Jerusalem.
- On failure or uncertainty, **do not make a blind OFF decision**; log and notify, with manual verification available.

## 2. Architecture

```text
Shelly 1 Gen4 (Wi-Fi, always powered)
  └─ periodic HTTPS POST /tick (shared client key)
       └─ Cloudflare Worker + Durable Object
            ├─ Jerusalem / Israel Shabbat & Yom Tov schedule (Hebcal)
            ├─ durable credentials; SmartThings OAuth refresh-token rotation
            ├─ desired-state controller and state reconciliation
            ├─ SmartThings device command API
            └─ health/status/diagnostics/alerts
                    └─ Samsung refrigerator: samsungce.sabbathMode
```

The **Shelly does not directly hold SmartThings OAuth credentials**. Keep them in a protected hosted service. The Worker is the decision-maker and the Shelly polls it (e.g. every 60 seconds). Decide whether an additional Cloudflare scheduled trigger should provide failover if the Shelly is offline; if introduced, document how its precedence and safety work. Do not accidentally create competing schedulers.

**Dependencies:** Shelly power and Wi-Fi; home internet; Cloudflare; SmartThings cloud; refrigerator connectivity; periodically Hebcal (or a cached schedule). Running the schedule locally on Shelly does *not* make the Samsung command offline-capable.

## 3. Equipment and accounts

- Shelly **1 Gen4** (not Shelly 1 Gen1); up-to-date firmware, stable Wi-Fi, reliable power.
- Samsung refrigerator already controlled by SmartThings; its device ID copied from SmartThings Advanced.
- Cloudflare account supporting Workers and Durable Objects, plus a setup computer with Node.js/npm and Wrangler.
- SmartThings developer registration / supported OAuth application type. **Verify the current registration and credential rules** before coding: interface, authorization URL, callback requirements, eligible app types, scopes, expiry, refresh semantics, and any pricing/quotas may change.
- A verified calendar source: Hebcal JSON API using **Israel (`i=on`)** and **Jerusalem (GeoNames `281184`)**, or equivalent reliable data.

Do not ask the owner to paste OAuth secrets or access tokens into ChatGPT/Claude chats or Git repositories.

## 4. Device command confirmed by owner

REST endpoint:

```http
POST https://api.smartthings.com/v1/devices/{DEVICE_ID}/commands
Authorization: Bearer {ACCESS_TOKEN}
Content-Type: application/json
```

Payload for ON:

```json
{
  "commands": [
    {
      "component": "main",
      "capability": "samsungce.sabbathMode",
      "command": "on",
      "arguments": []
    }
  ]
}
```

Use `"command": "off"` for OFF. The owner has already verified **command execution in SmartThings Advanced**; verify that **OAuth-app credentials** can execute exactly the same command against this device. HTTP 200/202 is **not proof** the physical refrigerator changed state. Implement read-back of the capability attribute via the SmartThings device status API if accessible, with a bounded settle interval and clear fault reporting.

## 5. Functional design and calendar correctness

### 5.1 Source schedule

Fetch a rolling horizon spanning at least the current active observance, the previous few days and upcoming months. Cache the **validated, timestamped intervals** durably; prefer a multi-day safety margin beyond the next needed event. Refresh on schedule and before cache expiry, and use previously validated data during transient Hebcal outages.

Hebcal starting point:

```text
https://www.hebcal.com/hebcal?v=1&cfg=json&i=on&maj=on&c=on&b=60&m=60&geo=geoname&geonameid=281184
```

**Important:** The flags alone do not prove the returned `candles` and `havdalah` events implement every desired policy. In particular, check multi-day Yom Tov, `M`/havdalah options, Erev Yom Tov transitions, and the actual 60-minute-offset semantics. Avoid blindly pairing the first candle event with the next Havdalah event. Prefer a formally specified per-day prohibition calendar merged with independently calculated sunset-based boundaries if event ordering is ambiguous. Do not confuse Friday candle-lighting with the subsequent Saturday sunset.

### 5.2 Construct intervals

1. Enumerate actual Shabbat and **Israel** Yom Tov observance dates.
2. Calculate the **start** of each observance at the preceding local Jerusalem sunset minus 60 minutes; calculate the **end** at the ending local sunset plus 60 minutes.
3. Combine all overlapping or directly adjoining observances. Define adjacency using calendar semantics (not an arbitrary fixed-hour gap without tests).
4. Store intervals as timezone-aware timestamps (UTC instants internally; Jerusalem time for display). Handle Israel DST automatically.
5. Check desired state at each poll. Turn ON if now lies in a validated combined interval, otherwise OFF only when schedule data is trustworthy.
6. Never switch OFF inside a combined Shabbat/Yom Tov interval.

### 5.3 Reconciliation and safety

- Persist last successfully attempted action and measured refrigerator state separately.
- At each poll, compare expected state and actual state when API read-back is available; send only necessary commands. Retry with exponential backoff or bounded polling.
- Ensure only one request at a time can refresh **rotating single-use OAuth refresh tokens**; persist the replacement atomically before proceeding. Verify current SmartThings token behavior from official docs; do not hardcode expiry assumptions.
- When remote state cannot be verified, emit an explicit **UNKNOWN** rather than success.
- Never schedule a fixed unconditional Saturday OFF rule alongside holiday logic.
- A SmartThings/Samsung model may automatically exit Sabbath Mode after approximately **85 hours**; independently verify the exact model's timeout. A repeated ON command is **not** an established way to extend it.
- Create notifications for failed scheduled ON/OFF, expired authorization, stale calendars and Shelly inactivity. Manual pre-Shabbat checks and a documented manual fallback remain necessary.
- If Cloudflare runs maintenance with a cron, it must **not** accidentally override the same desired-state decisions.

## 6. Security requirements

- OAuth `ST_CLIENT_ID`, `ST_CLIENT_SECRET` stored as Worker secrets; access and rotating refresh tokens in durable protected storage (Durable Object is one option).
- Separate random 32+-byte credentials for administrator and Shelly client. Restrict route methods, validate authentication, and rate-limit abuse where possible.
- OAuth authorization-code callback with exact registered redirect URI and short-lived unpredictable `state` verified once. Assess additional PKCE requirements based on current SmartThings docs.
- No secrets in query strings, plaintext logs, source control, example screenshots, or diagnostics responses.
- Use HTTPS with certificate validation from Shelly; avoid disabling TLS verification to make a prototype work.
- Narrow SmartThings scopes to the minimum supported for reading device state and executing its commands; validate whether `r:devices:*` and `x:devices:*` are applicable to the selected app type.
- Provide key rotation/revocation and backup/recovery instructions; control endpoints should not be publicly executable without authorization.

## 7. Implementation work breakdown for Claude Code

### Phase A — Validate APIs and constraints (research + tests)

1. Verify scripting and `HTTP.Request` syntax/limitations for **Shelly 1 Gen4**, including persistent script, startup behavior, request timeout, heap limits and SSL support.
2. Verify current SmartThings OAuth application registration, supported scopes, authorization and refresh endpoints, whether its tokens can address `samsungce.sabbathMode`, and current SmartThings account/API plan constraints.
3. Test actual Hebcal JSON for ordinary Shabbat and each applicable holiday configuration; inspect response categories and timestamps.
4. Write a risk report if one of these assumptions fails. **Do not silently substitute an undocumented API or claim production readiness.**

### Phase B — Implement Worker backend

1. Create `wrangler.jsonc` and `package.json`; bind Worker and Durable Object (or another single-writer durable store).
2. Implement secure OAuth `/start` and `/oauth/callback`; token refresh transaction and stateful durable storage.
3. Implement a calendar module that produces verified intervals. Cache and expose sanitized inspection output.
4. Implement SmartThings `on/off` commands, status read-back if possible, backoff, and idempotent reconciliation.
5. Implement admin endpoints (`/status`, `/inspect`, manual test ON/OFF) and authenticated Shelly `/tick`; add clear status codes.
6. Implement monitoring/alerts and maintenance; avoid logging tokens.
7. Write automated calendar tests and HTTP/OAuth mocks before deployment.

### Phase C — Implement Shelly Gen4 client

1. Script configurable `WORKER_URL`, `SHELLY_KEY` and polling interval (default 60 seconds).
2. Send authenticated `POST /tick` from Shelly with request timeout, error logging, and prevention of overlapping requests.
3. Check startup behavior, restart recovery and time sync. **Do not actuate the Shelly relay.**
4. Document installation at `http://SHELLY_IP` → Scripts → Create → Save → Run → Run on startup.

### Phase D — Deploy and authorize

1. Create Cloudflare account, install Node.js, `npm install`, `npx wrangler login`, deploy Worker.
2. Set real `DEVICE_ID` and Worker `PUBLIC_URL` / exact OAuth callback.
3. Register the applicable SmartThings OAuth application using up-to-date SmartThings docs/CLI.
4. Install secrets using `npx wrangler secret put ...` for `ST_CLIENT_ID`, `ST_CLIENT_SECRET`, `ADMIN_KEY`, `SHELLY_KEY`.
5. Complete browser authorization; verify auth persists and refreshes.
6. Perform **weekday** `/test-on` and `/test-off`, observing physical refrigerator state; restore original state afterward.
7. Verify `/inspect` outputs for Jerusalem before enabling unattended behavior.
8. Load script on Shelly and enable startup only after all required checks pass.

### Phase E — Test and handover

- Run automated unit tests and a staging dry-run mode that sends **no** device commands.
- Test one ordinary Friday/Saturday, both Rosh Hashanah days, Yom Kippur, Pesach day 1/7, Shavuot, Sukkot day 1, Shemini Atzeret/Simchat Torah.
- Include examples where Shabbat precedes Yom Tov, Yom Tov precedes Shabbat, and Yom Tov falls Thursday/Friday; assert no intermediate OFF transition.
- Assert Chol HaMoed-only weekday is OFF; check Jerusalem daylight-saving transitions and year boundary.
- Test token refresh after expiry; concurrent refresh attempts; Worker restart; Shelly restart; internet loss; Cloudflare/SmartThings/Hebcal failure; stale schedules; manual override; 85-hour timeout risk.
- Verify notifications and a documented manual fallback.
- Deliver exact deployment, rollback, troubleshooting, monitoring and backup steps.

## 8. Acceptance criteria

- [ ] A weekday ON/OFF test controls the **actual physical refrigerator** using the permanent OAuth path.
- [ ] Jerusalem Shabbat schedule consistently uses Friday sunset−60 and Saturday sunset+60.
- [ ] Israel Yom Tov inclusions/exclusions match requirements; day boundaries are verified against authoritative calendar cases.
- [ ] Continuous Shabbat/Yom Tov sequences contain **no OFF in between**.
- [ ] Validated expected-state decisions survive Shelly/Worker restarts and temporary calendar outages.
- [ ] Rotating OAuth tokens renew safely without human intervention under normal conditions.
- [ ] Errors and mismatches are visible and can notify the owner; success is not inferred merely from an HTTP 2xx.
- [ ] Shelly never switches refrigerator mains electricity.
- [ ] Secrets are isolated and not exposed publicly or committed to source control.
- [ ] Installation, test, rollback, recovery and remaining risks are documented.

## 9. Existing prototype artifact

A prototype was prepared in the earlier conversation: `shelly-sabbath-bridge.zip`, containing `src/worker.js`, `shelly-script.js`, `wrangler.jsonc`, `package.json`, and `README.md`. Claude Code **may use it as reference if provided**, but should audit, test and correct it rather than assuming it is deployable. Known areas needing scrutiny include calendar event pairing/merging, uncertainty handling, command read-back, alerting, OAuth onboarding requirements, and uptime/timeout behavior.

## 10. Official reference documentation

- SmartThings REST API: https://developer.smartthings.com/docs/api/public/
- SmartThings OAuth: https://developer.smartthings.com/docs/service-integrations/oauth
- SmartThings CLI: https://developer.smartthings.com/docs/sdks/cli
- Shelly scripting documentation: https://shelly-api-docs.shelly.cloud/gen2/Scripts/ShellyScriptLanguageFeatures/
- Cloudflare Workers: https://developers.cloudflare.com/workers/
- Cloudflare Durable Objects: https://developers.cloudflare.com/durable-objects/
- Hebcal Jewish Calendar REST API: https://www.hebcal.com/home/195/jewish-calendar-rest-api

## 11. Suggested first instruction to Claude Code

> Implement and test the Shelly 1 Gen4 → Samsung Sabbath Mode solution specified in this document. First validate all current API and calendar assumptions, then create a secure Cloudflare Worker and Shelly script with automated tests, dry-run mode, status verification, and deployment documentation. The existing prototype is reference-only. Do not use real credentials, send commands to a real refrigerator, or deploy to a production account until explicitly authorized. Ensure Israel Yom Tov and contiguous observances are correct; treat reliability and non-interruption of Sabbath Mode as top-priority acceptance criteria.
