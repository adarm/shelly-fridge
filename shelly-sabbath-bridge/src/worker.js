// Single-refrigerator Shelly Gen4 / SmartThings controller.
// Requires SmartThings OAuth-In credentials and Cloudflare Durable Object storage.
const OAUTH = 'https://api.smartthings.com/v1/oauth';
const API = 'https://api.smartthings.com/v1';
const MINUTE = 60000;
const json = (v, status=200) => new Response(JSON.stringify(v), {
  status, headers: {'content-type':'application/json; charset=utf-8','cache-control':'no-store'}
});

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    // No credentials in URLs or logs; header access required for all admin endpoints.
    if (path === '/oauth/callback') {
      return getController(env).fetch(request);
    }
    if (path === '/health') return json({online:true});
    const admin = request.headers.get('authorization') === `Bearer ${env.ADMIN_KEY}`;
    const shelly = request.headers.get('x-shelly-key') === env.SHELLY_KEY;
    if (path === '/tick' && request.method === 'POST' && shelly) {
      return getController(env).fetch(request);
    }
    if (['/start','/status','/inspect','/test-on','/test-off'].includes(path) && admin) {
      return getController(env).fetch(request);
    }
    return json({error:'Not found or unauthorized'},404);
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(getController(env).fetch('https://internal/maintenance'));
  }
};
function getController(env) {
  const id = env.CONTROLLER.idFromName('one-refrigerator');
  return env.CONTROLLER.get(id);
}

export class Controller {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.busy = Promise.resolve();
  }
  // Serialize all operations involving one-time rotating refresh tokens.
  synchronized(fn) {
    const next = this.busy.then(fn, fn);
    this.busy = next.catch(() => {});
    return next;
  }
  async fetch(req) {
    return this.synchronized(async () => {
      try { return await this.handle(req); }
      catch (err) { console.error('Controller error', String(err)); return json({error:String(err)},502); }
    });
  }
  async handle(req) {
    const url = new URL(req.url), path=url.pathname;
    if (path==='/start') {
      const state=crypto.randomUUID();
      await this.ctx.storage.put('oauth_state',{value:state,expires:Date.now()+10*MINUTE});
      const q=new URLSearchParams({client_id:this.env.ST_CLIENT_ID,
        scope:'r:devices:* x:devices:*', response_type:'code',
        redirect_uri:`${this.env.PUBLIC_URL}/oauth/callback`,state});
      return Response.redirect(`${OAUTH}/authorize?${q}`,302);
    }
    if(path==='/oauth/callback') {
      const expected=await this.ctx.storage.get('oauth_state');
      await this.ctx.storage.delete('oauth_state');
      if(!expected || expected.expires<Date.now() || url.searchParams.get('state')!==expected.value)
        return json({error:'OAuth state mismatch/expired'},403);
      const code=url.searchParams.get('code');
      if(!code) return json({error:url.searchParams.get('error')||'No authorization code'},400);
      const t=await this.tokenRequest({grant_type:'authorization_code',code,
        redirect_uri:`${this.env.PUBLIC_URL}/oauth/callback`});
      await this.saveTokens(t);
      return new Response('SmartThings authorized. Close this tab. Use /status to inspect.',
        {headers:{'content-type':'text/plain'}});
    }
    if(path==='/status') {
      const t=await this.ctx.storage.get('tokens');
      const c=await this.ctx.storage.get('calendar');
      const last=await this.ctx.storage.get('last');
      return json({linked:!!t,tokenExpiresAt:t?new Date(t.expiresAt).toISOString():null,
        calendarCachedUntil:c?new Date(c.expiresAt).toISOString():null,
        last:last||null});
    }
    if(path==='/maintenance') {
      await this.accessToken();
      await this.calendar();
      return json({ok:true});
    }
    if(path==='/inspect') {
      const data=await this.calendar();
      const now=Date.now(), period=this.findPeriod(data.periods,now);
      return json({now:new Date(now).toISOString(),shouldBeOn:!!period,
        currentPeriod:period||null,nextPeriods:data.periods.filter(p=>p.end>now).slice(0,8),
        source:'Hebcal Israel, Jerusalem; 60 minutes before/after sunset'});
    }
    if(path==='/tick') {
      const now=Date.now();
      const calendar=await this.calendar();
      const current=this.findPeriod(calendar.periods,now);
      const desired=current?'on':'off';
      const last=await this.ctx.storage.get('last');
      // On state transitions, resend if last attempt wasn't successful.
      // Also re-check at least once every 12 hours (not an 85h timeout solution).
      const due=!last || last.command!==desired || !last.ok ||
        now-last.at>12*60*MINUTE;
      if(!due) return json({ok:true,desired,action:'none',last});
      const result=await this.sendCommand(desired);
      const record={command:desired,at:now,ok:result.ok,http:result.code};
      await this.ctx.storage.put('last',record);
      return json({ok:result.ok,desired,action:'sent',http:result.code});
    }
    if(path==='/test-on'||path==='/test-off') {
      const cmd=path==='/test-on'?'on':'off';
      const result=await this.sendCommand(cmd);
      // Deliberately do not set last: next tick will restore the calendar state.
      return json({test:true,command:cmd,...result});
    }
    return json({error:'not found'},404);
  }
  async tokenRequest(fields) {
    const basic=btoa(`${this.env.ST_CLIENT_ID}:${this.env.ST_CLIENT_SECRET}`);
    const body=new URLSearchParams({...fields,client_id:this.env.ST_CLIENT_ID});
    const r=await fetch(`${OAUTH}/token`,{method:'POST',headers:{
      authorization:`Basic ${basic}`,'content-type':'application/x-www-form-urlencoded',
      accept:'application/json'},body});
    if(!r.ok) throw new Error(`SmartThings token endpoint HTTP ${r.status}`);
    return await r.json();
  }
  async saveTokens(t) {
    if(!t.access_token||!t.refresh_token) throw new Error('Missing OAuth tokens');
    const expiresAt=Date.now()+Number(t.expires_in||86399)*1000;
    await this.ctx.storage.put('tokens',{
      access:t.access_token,refresh:t.refresh_token,expiresAt,
      installedAppId:t.installed_app_id||null});
  }
  async accessToken(force=false) {
    const t=await this.ctx.storage.get('tokens');
    if(!t) throw new Error('Not linked: visit /start first');
    if(!force && t.expiresAt-Date.now()>3*60*60*1000) return t.access;
    const updated=await this.tokenRequest({grant_type:'refresh_token',refresh_token:t.refresh});
    // Persist BOTH tokens together before doing anything else.
    await this.saveTokens(updated);
    return updated.access_token;
  }
  async sendCommand(command) {
    let token=await this.accessToken();
    const endpoint=`${API}/devices/${encodeURIComponent(this.env.DEVICE_ID)}/commands`;
    const body=JSON.stringify({commands:[{component:'main',capability:'samsungce.sabbathMode',
      command,arguments:[]}]});
    let r;
    for(let attempt=0;attempt<2;attempt++) {
      r=await fetch(endpoint,{method:'POST',headers:{authorization:`Bearer ${token}`,
        'content-type':'application/json',accept:'application/json'},body});
      if(r.status!==401 || attempt===1) break;
      token=await this.accessToken(true);
    }
    if(!r.ok) console.error('SmartThings command HTTP',r.status);
    return {ok:r.ok,code:r.status};
  }
  findPeriod(periods,now) { return periods.find(p=>p.start<=now&&now<p.end); }
  async calendar() {
    const cached=await this.ctx.storage.get('calendar');
    if(cached&&cached.expiresAt>Date.now()) return cached;
    // The full requested range contains the current period and future holidays.
    const from=new Date(Date.now()-15*86400000).toISOString().slice(0,10);
    const to=new Date(Date.now()+390*86400000).toISOString().slice(0,10);
    const params=new URLSearchParams({v:'1',cfg:'json',i:'on',maj:'on',c:'on',
      b:'60',m:'60',M:'off',geo:'geoname',geonameid:'281184',start:from,end:to});
    const r=await fetch('https://www.hebcal.com/hebcal?'+params,{headers:{accept:'application/json'}});
    if(!r.ok) throw new Error('Hebcal HTTP '+r.status);
    const data=await r.json();
    const events=(data.items||[]).filter(e=>e.category==='candles'||e.category==='havdalah')
      .map(e=>({category:e.category,at:Date.parse(e.date),title:e.title}))
      .filter(e=>Number.isFinite(e.at)).sort((a,b)=>a.at-b.at);
    // Hebcal includes additional candle-lighting entries inside multi-day periods.
    // Only HAVDALAH closes the active period; candle events within it are ignored.
    const periods=[];let start=null;
    for(const e of events) {
      if(e.category==='candles' && start===null) start=e.at;
      if(e.category==='havdalah' && start!==null && e.at>start) {
        periods.push({start,end:e.at});start=null;
      }
    }
    if(start!==null) throw new Error('Calendar window ends with unclosed candle event');
    // Protect adjoining Shabbat/Yom Tov if a provider emits a short apparent gap.
    // A six-hour merge is deliberately broader than sunset timing differences,
    // while still far narrower than a regular weekday interruption.
    const merged=[];
    for(const p of periods) {
      const prior=merged[merged.length-1];
      if(prior && p.start-prior.end<=6*60*MINUTE) prior.end=Math.max(prior.end,p.end);
      else merged.push({...p});
    }
    if(merged.length<30) throw new Error('Calendar unexpectedly sparse');
    const result={periods:merged,expiresAt:Date.now()+12*60*MINUTE};
    await this.ctx.storage.put('calendar',result);
    return result;
  }
}
