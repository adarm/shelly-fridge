// Shelly 1 Gen4 script. Connect to Wi-Fi; relay must NOT power the fridge.
// HTTP POST /tick every 60 seconds. OAuth secrets are never stored here.
let WORKER = 'https://shelly-sabbath-bridge.YOUR_SUBDOMAIN.workers.dev';
let SHELLY_KEY = 'PASTE_SHELLY_KEY_SECRET';
let busy = false;
function tick() {
  if (busy) return;
  busy = true;
  Shelly.call('HTTP.Request', {
    url: WORKER + '/tick', method: 'POST',
    headers: {'x-shelly-key': SHELLY_KEY, 'content-type':'application/json'},
    body: '{}', timeout: 20
  }, function(result, error_code, error_message) {
    busy = false;
    if (error_code !== 0) {
      print('Bridge unreachable:', error_message);
      return;
    }
    if (result.code !== 200) {
      print('Bridge HTTP error:', result.code, result.body);
      return;
    }
    try {
      let info = JSON.parse(result.body);
      if (!info.ok) print('Fridge automation failed:', result.body);
      else if (info.action === 'sent') print('Fridge command:', info.desired);
    } catch (e) { print('Invalid bridge JSON response'); }
  });
}
Timer.set(60000, true, tick);
Timer.set(3000, false, tick);
