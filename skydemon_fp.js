/* skydemon_fp.js — SkyDemon .flightplan (and GPX) ⇄ NAV Plan route rows.
   Pure helpers, no DOM state. Loaded by the three NAV Plan pages and exposed
   as window.velisFp.

   The .flightplan format is SkyDemon's own XML (root <DivelementsFlightPlanner>):

     <PrimaryRoute Start="N465000.00 E0081050.00" Level="4000" Rules="Vfr" …>
       <RhumbLineRoute To="N470121.00 E0082237.00" Level="MSL" LevelChange="B" />
       <RhumbLineRoute To="…" Level="5000" LevelChange="B" UserName="Brünig" />
       <Alternate To="…" Level="…" />
       <ReferencedAirfields />
     </PrimaryRoute>
     <WaypointNameHints><Hint Location="N465000.00 E0081050.00" Name="Kägiswil" /></WaypointNameHints>

   Coordinates are DDMMSS.ss / DDDMMSS.ss with hemisphere prefix. A leg's
   Level is the level flown on that leg; "MSL" means "route default level".
   There is no published schema — the reader is deliberately lenient and the
   writer emits only the subset SkyDemon is known to accept. */
window.velisFp = (function(){
  'use strict';

  /* ─── coordinates ─── */
  const SD_RE=/^([NS])(\d{2})(\d{2})(\d{2}(?:\.\d+)?)\s*([EW])(\d{3})(\d{2})(\d{2}(?:\.\d+)?)$/;
  function parseSdCoord(s){
    const m=String(s||'').trim().match(SD_RE);
    if(!m) return null;
    const lat=(+m[2]+ +m[3]/60+ +m[4]/3600)*(m[1]==='S'?-1:1);
    const lon=(+m[6]+ +m[7]/60+ +m[8]/3600)*(m[5]==='W'?-1:1);
    if(!(Math.abs(lat)<=90&&Math.abs(lon)<=180)) return null;
    return [lat,lon];
  }
  function _dms(v,w,dec){
    v=Math.abs(v);
    let d=Math.floor(v), m=Math.floor((v-d)*60), s=((v-d)*60-m)*60;
    s=dec?Math.round(s*100)/100:Math.round(s);
    if(s>=60){s-=60;m++;}
    if(m>=60){m-=60;d++;}
    const ss=dec?((s<10?'0':'')+s.toFixed(2)):String(s).padStart(2,'0');
    return String(d).padStart(w,'0')+String(m).padStart(2,'0')+ss;
  }
  // SkyDemon form, 2-decimal seconds: "N465000.00 E0081050.00"
  const fmtSdCoord=(lat,lon)=>(lat>=0?'N':'S')+_dms(lat,2,true)+' '+(lon>=0?'E':'W')+_dms(lon,3,true);
  // NAV Plan row form (whole seconds): "N465000 E0081050" — what parseCoordStr() reads
  const fmtNavCoord=(lat,lon)=>(lat>=0?'N':'S')+_dms(lat,2,false)+' '+(lon>=0?'E':'W')+_dms(lon,3,false);

  /* ─── geometry (same formulas as the NAV Plan map) ─── */
  const R_NM=3440.065, RAD=Math.PI/180;
  function distNm(a,b){
    const dLat=(b[0]-a[0])*RAD, dLon=(b[1]-a[1])*RAD;
    const h=Math.sin(dLat/2)**2+Math.cos(a[0]*RAD)*Math.cos(b[0]*RAD)*Math.sin(dLon/2)**2;
    return 2*R_NM*Math.asin(Math.sqrt(h));
  }
  function bearing(a,b){
    const y=Math.sin((b[1]-a[1])*RAD)*Math.cos(b[0]*RAD);
    const x=Math.cos(a[0]*RAD)*Math.sin(b[0]*RAD)-Math.sin(a[0]*RAD)*Math.cos(b[0]*RAD)*Math.cos((b[1]-a[1])*RAD);
    return (Math.atan2(y,x)/RAD+360)%360;
  }
  const pad3=n=>String(((Math.round(n)%360)+360)%360).padStart(3,'0');

  /* ─── identity ─── */
  const baseName=f=>String(f||'').replace(/\.[^.]+$/,'').trim();
  // Stable key for "the same SkyDemon route" across re-exports: the file's
  // base name (SkyDemon names routes "LSPG - LSZF" style, users may rename).
  const sourceKey=f=>baseName(f).toLowerCase().replace(/\s+/g,' ');
  const coordKey=ll=>ll?ll[0].toFixed(4)+','+ll[1].toFixed(4):'';   // ~10 m

  // "4000" | "4000 ft" | "FL065" | "MSL"/anything else → fallback
  function parseLevel(v,fallback){
    const s=String(v||'').trim();
    const fl=s.match(/^FL\s*(\d{2,3})$/i);
    if(fl) return +fl[1]*100;
    const n=parseFloat(s.replace(/[’',]/g,''));
    return isFinite(n)&&n>0?Math.round(n):fallback;
  }

  /* ─── reading ─── */
  // → { format:'flightplan'|'gpx', name, key, level, rules,
  //     points:[{ll:[lat,lon], name, isAirfield, level, levelChange}],
  //     alternate:{ll,name,level}|null, aircraft:{name,registration,type}|null }
  function parseFlightplan(text,fileName){
    const src=String(text||'').replace(/^﻿/,'');
    const doc=new DOMParser().parseFromString(src,'application/xml');
    if(doc.getElementsByTagName('parsererror').length||!doc.documentElement) throw new Error('This is not a valid XML file.');
    const root=doc.documentElement;
    const tag=root.localName||root.tagName;
    if(/^gpx$/i.test(tag)) return parseGpx(doc,fileName);
    if(!/^(DivelementsFlightPlanner|SkyAngel)$/.test(tag)) throw new Error('Not a SkyDemon .flightplan file (root element <'+tag+'>).');
    const route=root.querySelector('PrimaryRoute')||root.querySelector('Route');
    if(!route) throw new Error('No route found in the file.');

    // Names: WaypointNameHints (what SkyDemon writes), UserName on the leg,
    // and — shape unverified, so scanned generically — ReferencedAirfields.
    const names=new Map(), idents=new Map(), airfields=new Set();
    root.querySelectorAll('WaypointNameHints > Hint').forEach(h=>{
      const ll=parseSdCoord(h.getAttribute('Location'));
      const n=(h.getAttribute('Name')||'').trim();
      if(ll&&n) names.set(coordKey(ll),n);
    });
    const ra=root.querySelector('ReferencedAirfields');
    if(ra) ra.querySelectorAll('*').forEach(el=>{
      let ll=null, ident='', name='';
      for(const a of el.attributes){
        const v=a.value.trim();
        if(!ll&&parseSdCoord(v)) ll=parseSdCoord(v);
        else if(/^(ident|icao|code|identifier)$/i.test(a.name)&&/^[A-Z0-9]{3,4}$/.test(v)) ident=v;
        else if(/^name$/i.test(a.name)) name=v;
      }
      if(!ll) return;
      const k=coordKey(ll);
      airfields.add(k);
      if(ident) idents.set(k,ident);
      if(name&&!names.has(k)) names.set(k,name);
    });

    const routeLevel=parseLevel(route.getAttribute('Level'),null);
    const points=[];
    const push=(coordStr,el,isStart)=>{
      const ll=parseSdCoord(coordStr);
      if(!ll) return;
      const k=coordKey(ll);
      const type=el.getAttribute(isStart?'StartType':'ToType')||'';
      let name=names.get(k)||(el.getAttribute('UserName')||'').trim();
      const ident=idents.get(k)||'';
      if(ident&&!name.toUpperCase().startsWith(ident.toUpperCase())) name=(ident+' '+name).trim();
      points.push({ll,name,type,isAirfield:/aerodrome|airfield|airport/i.test(type)||airfields.has(k),
        level:isStart?null:parseLevel(el.getAttribute('Level'),routeLevel),
        levelChange:el.getAttribute('LevelChange')||''});
    };
    push(route.getAttribute('Start'),route,true);
    for(const el of route.children){
      if(/^(RhumbLineRoute|GreatCircleRoute|Leg)$/.test(el.localName)) push(el.getAttribute('To'),el,false);
    }
    if(points.length<2) throw new Error('The route needs at least a departure and a destination.');

    let alternate=null;
    const altEl=[...route.children].find(el=>el.localName==='Alternate');
    if(altEl){
      const ll=parseSdCoord(altEl.getAttribute('To'));
      if(ll) alternate={ll,name:names.get(coordKey(ll))||(altEl.getAttribute('UserName')||'').trim(),level:parseLevel(altEl.getAttribute('Level'),routeLevel)};
    }
    const acEl=root.querySelector('Aircraft, AircraftReference');
    const aircraft=acEl?{name:acEl.getAttribute('Name')||'',registration:acEl.getAttribute('Registration')||'',type:acEl.getAttribute('Type')||''}:null;
    const name=baseName(fileName)||[points[0].name,points[points.length-1].name].filter(Boolean).join(' - ')||'Route';
    return {format:'flightplan',name,key:sourceKey(fileName)||name.toLowerCase(),level:routeLevel,
      rules:route.getAttribute('Rules')||'',points,alternate,aircraft};
  }

  function parseGpx(doc,fileName){
    const rte=doc.querySelector('rte');
    let els=rte?[...rte.querySelectorAll('rtept')]:[];
    if(els.length<2) els=[...doc.querySelectorAll('wpt')];
    if(els.length<2){const seg=doc.querySelector('trkseg');if(seg) els=[...seg.querySelectorAll('trkpt')];}
    const points=els.map(el=>{
      const lat=parseFloat(el.getAttribute('lat')), lon=parseFloat(el.getAttribute('lon'));
      if(!isFinite(lat)||!isFinite(lon)) return null;
      const nm=el.querySelector('name'), ele=el.querySelector('ele');
      const e=ele?parseFloat(ele.textContent):NaN;
      return {ll:[lat,lon],name:nm?nm.textContent.trim():'',type:'',isAirfield:false,level:isFinite(e)&&e>0?Math.round(e*3.28084):null,levelChange:''};
    }).filter(Boolean);
    if(points.length<2) throw new Error('No route with at least two points found in the GPX file.');
    const rn=rte&&rte.querySelector('name');
    const name=(rn&&rn.textContent.trim())||baseName(fileName)||'Route';
    return {format:'gpx',name,key:sourceKey(fileName)||name.toLowerCase(),level:null,rules:'',points,alternate:null,aircraft:null};
  }

  // Parsed route → the row shape every NAV Plan import path feeds into
  // wpFromSkyDemon(): {name, elev, coord, data:{level,trk,hdg,dist,…}|null}.
  // DIST and HDG (true track, no wind) come from the coordinates — the file
  // carries neither. Unnamed turn points are named by their coordinate, as
  // with a pasted nav log.
  function toParsedRows(fp){
    const pts=fp.points;
    return pts.map((p,i)=>{
      const coord=fmtNavCoord(p.ll[0],p.ll[1]);
      if(i===0) return {name:p.name||coord,elev:'',coord,data:null};
      const prev=pts[i-1].ll, b=pad3(bearing(prev,p.ll));
      return {name:p.name||coord,elev:'',coord,data:{msa:'',level:p.level!=null?String(p.level):'',tas:'',
        trk:b,wind:'',hdg:b,gs:'',dist:distNm(prev,p.ll).toFixed(1),eet:''}};
    });
  }
  // Alternate as a parsed row (DIST/HDG measured from the destination), or null.
  function toAltnRow(fp){
    const a=fp.alternate;
    if(!a) return null;
    const dest=fp.points[fp.points.length-1].ll, b=pad3(bearing(dest,a.ll));
    const coord=fmtNavCoord(a.ll[0],a.ll[1]);
    return {name:a.name||coord,elev:'',coord,data:{msa:'',level:a.level!=null?String(a.level):'',tas:'',
      trk:b,wind:'',hdg:b,gs:'',dist:distNm(dest,a.ll).toFixed(1),eet:''}};
  }

  /* ─── writing ─── */
  // opts: { points:[{ll, name, isAirfield, alt:number|null}], level:number|null,
  //         alternate:{ll, name, alt}|null }
  // Only the subset SkyDemon is known to open: PrimaryRoute + RhumbLineRoute
  // legs + name hints. No aircraft block — SkyDemon applies its own selected
  // aircraft, which is what the pilot expects.
  function buildFlightplan(opts){
    // Turn points named by their coordinate (how the NAV Plan labels unnamed
    // SkyDemon points) go out unnamed — SkyDemon shows its own label.
    const isCoordName=s=>/^[NS]\d{6}(?:\.\d+)?\s+[EW]\d{7}(?:\.\d+)?$/.test(String(s||'').trim());
    const pts=(opts.points||[]).filter(p=>p&&p.ll).map(p=>isCoordName(p.name)?{...p,name:''}:p);
    if(pts.length<2) throw new Error('Need at least two waypoints with coordinates.');
    const n=pts.length;
    const esc=s=>String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    const sd=p=>fmtSdCoord(p.ll[0],p.ll[1]);
    const enroute=pts.slice(1,n-1).map(p=>p.alt).filter(a=>a!=null&&a>0);
    const routeLevel=opts.level||(enroute.length?Math.max(...enroute):3000);
    // The leg arriving at row i is flown at that row's ALT. On the destination
    // row the ALT is usually the airfield elevation (lower than the last
    // enroute level) — then the last leg keeps the enroute level; a higher
    // value is a genuine last-leg level and is kept. A direct DEP→DEST leg
    // uses the route level.
    const legLevel=i=>{
      if(i===n-1) return n>2?(Math.max(pts[n-2].alt||0,pts[n-1].alt||0)||routeLevel):routeLevel;
      return pts[i].alt||routeLevel;
    };
    const out=['<?xml version="1.0" encoding="utf-8"?>','<DivelementsFlightPlanner>',
      `  <PrimaryRoute CourseType="GreatCircle" Start="${sd(pts[0])}" Level="${routeLevel}" Rules="Vfr">`];
    for(let i=1;i<n;i++){
      const p=pts[i];
      const un=!p.isAirfield&&p.name?` UserName="${esc(p.name)}"`:'';
      out.push(`    <RhumbLineRoute To="${sd(p)}" Level="${legLevel(i)}" LevelChange="B"${un} />`);
    }
    const alt=opts.alternate&&opts.alternate.ll?opts.alternate:null;
    if(alt) out.push(`    <Alternate To="${sd(alt)}" Level="${alt.alt||routeLevel}" LevelChange="B" />`);
    out.push('    <ReferencedAirfields />','  </PrimaryRoute>');
    const hints=pts.concat(alt?[alt]:[]).filter(p=>p.name);
    if(hints.length){
      out.push('  <WaypointNameHints>');
      hints.forEach(p=>out.push(`    <Hint Location="${sd(p)}" Name="${esc(p.name)}" />`));
      out.push('  </WaypointNameHints>');
    }
    out.push('</DivelementsFlightPlanner>','');
    return out.join('\n');
  }

  /* ─── in-place update ─── */
  // Re-importing a newer version of the same route: keep what the pilot typed
  // on rows that are still the same waypoint (same coordinate within ~0.1 nm,
  // else same name). Leg-dependent cells (EET, wind) survive only when the
  // leg's start point is unchanged too. parseCoord is the page's
  // parseCoordStr (NAV row coord → [lat,lon]).
  function mergeRoute(oldRows,newRows,parseCoord){
    const PILOT=['freq','freqR','remark','ato','asoc'];
    const used=new Set();
    const nameKey=r=>String((r.wp||'').trim()||(r.ident||'').trim()).toLowerCase();
    let prevMatch=-1;
    return newRows.map((nr,i)=>{
      const nll=parseCoord(nr.coord);
      let m=-1;
      if(nll) m=oldRows.findIndex((o,i)=>{
        if(used.has(i)) return false;
        const oll=parseCoord(o.coord);
        return !!oll&&distNm(oll,nll)<0.1;
      });
      if(m<0&&nameKey(nr)) m=oldRows.findIndex((o,i)=>!used.has(i)&&nameKey(o)===nameKey(nr));
      if(m<0){prevMatch=-1;return nr;}
      used.add(m);
      const o=oldRows[m], out={...nr};
      PILOT.forEach(f=>{if(!out[f]&&o[f]) out[f]=o[f];});
      if(!out.ident&&o.ident) out.ident=o.ident;
      // A re-export never carries names: keep the one looked up or typed last time.
      if((!out.wp||parseSdCoord(out.wp))&&o.wp&&!parseSdCoord(o.wp)) out.wp=o.wp;
      // DEP / DEST rows hold the airfield elevation, which the file never has.
      if((i===0||i===newRows.length-1)&&o.alt) out.alt=o.alt;
      if(m===prevMatch+1){
        if(!out.eet&&o.eet) out.eet=o.eet;
        if(!out.wind&&o.wind) out.wind=o.wind;
      }
      prevMatch=m;
      return out;
    });
  }


  /* ─── enrichment: names, winds aloft, headings and times ───
     A real SkyDemon export carries only coordinates, point types and the
     route level (no names, no wind, no times — those are rendered by
     SkyDemon from its own data). The NAV Plan fills them in after import:
       · aerodromes → openAIP through the backend proxy /api/aip/airports
         (ICAO, name, elevation, magnetic declination); openAIP refuses
         cross-origin browser reads, hence the proxy;
       · other points → OpenStreetMap Nominatim reverse geocoding, paced at
         one request per second as its usage policy asks;
       · winds → Open-Meteo pressure-level forecast at each leg midpoint,
         interpolated to the leg altitude with the model's geopotential
         heights (no ISA assumption);
       · HDG (°M), GS and EET → wind triangle at the pilot's cruise TAS. */
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  const windFmt=(dir,kt)=>pad3(dir)+'/'+String(Math.round(kt)).padStart(2,'0');

  // windDir = direction the wind blows FROM (°true). Returns the wind
  // correction angle, true heading and ground speed.
  function windTriangle(trkTrue,tas,windDir,windKt){
    const rel=(windDir-trkTrue)*RAD;
    const s=Math.max(-1,Math.min(1,windKt*Math.sin(rel)/tas));
    const wca=Math.asin(s);
    const gs=tas*Math.cos(wca)-windKt*Math.cos(rel);
    return {wca:wca/RAD,hdgTrue:(trkTrue+wca/RAD+360)%360,gs:Math.max(1,gs)};
  }

  // HDG / WIND / EET strings for one leg. decl = magnetic declination (°, east
  // positive); wind = {dir,kt} or null; tas in kt.
  function legFromWind(from,to,wind,tas,decl){
    const trk=bearing(from,to), d=distNm(from,to), v=decl||0;
    if(!wind||!(tas>0)){
      return {hdg:pad3(trk-v),wind:wind?windFmt(wind.dir,wind.kt):'',eet:tas>0?String(Math.max(1,Math.round(d/tas*60))):''};
    }
    const t=windTriangle(trk,tas,wind.dir,wind.kt);
    return {hdg:pad3(t.hdgTrue-v),wind:windFmt(wind.dir,wind.kt),eet:String(Math.max(1,Math.round(d/t.gs*60)))};
  }

  // Wind at an altitude from a profile [{ft,dir,kt}] sorted by ft —
  // linear in u/v between the bracketing levels, clamped outside.
  function windAtAlt(prof,ft){
    if(!prof.length) return null;
    const first=prof[0], last=prof[prof.length-1];
    if(ft==null||ft<=first.ft) return {dir:first.dir,kt:first.kt};
    if(ft>=last.ft) return {dir:last.dir,kt:last.kt};
    let i=1; while(prof[i].ft<ft) i++;
    const a=prof[i-1], b=prof[i], t=(ft-a.ft)/(b.ft-a.ft);
    const u=w=>-w.kt*Math.sin(w.dir*RAD), v=w=>-w.kt*Math.cos(w.dir*RAD);
    const uu=u(a)+(u(b)-u(a))*t, vv=v(a)+(v(b)-v(a))*t;
    return {kt:Math.hypot(uu,vv),dir:(Math.atan2(-uu,-vv)/RAD+360)%360};
  }

  const PLEVELS=[1000,975,950,925,900,850,800,700,600,500];
  // points:[{ll,altFt}] → [{dir,kt}|null] for the UTC hour of `when` (Date).
  async function fetchWindsAloft(points,when){
    if(!points.length) return [];
    const hourly=[];
    PLEVELS.forEach(p=>hourly.push('wind_speed_'+p+'hPa','wind_direction_'+p+'hPa','geopotential_height_'+p+'hPa'));
    hourly.push('wind_speed_10m','wind_direction_10m');
    const day=when.toISOString().slice(0,10), hi=when.getUTCHours();
    const url='https://api.open-meteo.com/v1/forecast?latitude='+points.map(p=>p.ll[0].toFixed(4)).join(',')
      +'&longitude='+points.map(p=>p.ll[1].toFixed(4)).join(',')+'&hourly='+hourly.join(',')
      +'&wind_speed_unit=kn&timezone=UTC&start_date='+day+'&end_date='+day;
    const r=await fetch(url);
    if(!r.ok) throw new Error('Open-Meteo answered '+r.status);
    let data=await r.json();
    if(!Array.isArray(data)) data=[data];
    return points.map((p,i)=>{
      const d=data[i], h=d&&d.hourly;
      if(!h) return null;
      const prof=[];
      const num=(a)=>a&&isFinite(a[hi])?+a[hi]:null;
      PLEVELS.forEach(pl=>{
        const z=num(h['geopotential_height_'+pl+'hPa']), kt=num(h['wind_speed_'+pl+'hPa']), dir=num(h['wind_direction_'+pl+'hPa']);
        if(z!=null&&kt!=null&&dir!=null) prof.push({ft:z*3.28084,kt,dir});
      });
      const s10=num(h.wind_speed_10m), d10=num(h.wind_direction_10m);
      if(s10!=null&&d10!=null) prof.push({ft:(+d.elevation||0)*3.28084+33,kt:s10,dir:d10});
      prof.sort((a,b)=>a.ft-b.ft);
      return windAtAlt(prof,p.altFt);
    });
  }

  // Terrain elevation (ft) at each point from Open-Meteo's 90 m DEM — the
  // fallback for an aerodrome elevation when openAIP cannot be asked.
  async function fetchElevationFt(lls){
    if(!lls.length) return [];
    const r=await fetch('https://api.open-meteo.com/v1/elevation?latitude='+lls.map(l=>l[0].toFixed(5)).join(',')+'&longitude='+lls.map(l=>l[1].toFixed(5)).join(','));
    if(!r.ok) throw new Error('Open-Meteo elevation answered '+r.status);
    const e=(await r.json()).elevation||[];
    return lls.map((_,i)=>isFinite(e[i])?Math.round(e[i]*3.28084):null);
  }

  async function nominatim(ll,zoom,extra){
    const r=await fetch('https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat='+ll[0].toFixed(5)+'&lon='+ll[1].toFixed(5)+'&zoom='+zoom+(extra?'&extratags=1':''));
    if(!r.ok) throw new Error('OpenStreetMap answered '+r.status);
    return r.json();
  }
  // Candidate names for a point, most fitting first. kind 'town' starts at
  // municipality level (zoom 10), 'place' at the nearest hamlet/village
  // (zoom 14); `zoom` overrides for the finer retries used to avoid
  // duplicate names on one route. Returns [] when nothing usable comes back.
  async function reverseGeocode(ll,kind,zoom){
    const z=zoom||(kind==='town'?10:14);
    const j=await nominatim(ll,z,false), a=j.address||{};
    const order=kind==='town'?['town','village','city','municipality','hamlet']
                             :['hamlet','village','neighbourhood','locality','isolated_dwelling','suburb','town','city','municipality'];
    const out=[];
    if(z>=16&&j.name&&/^(place|natural|landuse|amenity|tourism|man_made|railway|aeroway)$/.test(j.category||'')) out.push(String(j.name));
    for(const k of order) if(a[k]&&!out.includes(String(a[k]))) out.push(String(a[k]));
    return out;
  }
  // Nearest named map feature for a user waypoint (Photon, komoot's OSM
  // geocoder): passes, peaks, hamlets, villages, localities… within `maxNm`.
  // Buildings, roads, streams and the like are ignored. Returns '' when
  // nothing fitting is close — the row then keeps its coordinates.
  const PHOTON_OK=[[/^mountain_pass$/,/.*/,0],[/^natural$/,/^(saddle|peak|volcano|cape|bay|water|lake|glacier)$/,0],
    [/^place$/,/^(hamlet|village|town|city|suburb|quarter|neighbourhood)$/,0],[/^place$/,/^(locality|isolated_dwelling|farm|islet|island)$/,0.08],
    [/^aeroway$/,/^(aerodrome|heliport|airfield)$/,0],[/^man_made$/,/^(tower|lighthouse|mast|chimney)$/,0.05],[/^historic$/,/^(castle|monastery)$/,0.05],
    [/^amenity$/,/^(place_of_worship|monastery)$/,0.08],[/^tourism$/,/^(alpine_hut|viewpoint)$/,0.08]];
  async function photonNearest(ll,maxNm){
    const tags=['place','natural','mountain_pass','aeroway','man_made','historic','tourism'].map(t=>'&osm_tag='+t).join('');
    const r=await fetch('https://photon.komoot.io/reverse?lat='+ll[0].toFixed(5)+'&lon='+ll[1].toFixed(5)+'&radius='+Math.max(1,Math.ceil(maxNm*1.852))+'&limit=30'+tags);
    if(!r.ok) throw new Error('Photon answered '+r.status);
    const feats=((await r.json()).features||[]);
    let best=null;
    feats.forEach(f=>{
      const pr=f.properties||{}, nm=String(pr.name||'').trim();
      if(!nm||!f.geometry) return;
      const rule=PHOTON_OK.find(([k,v])=>k.test(pr.osm_key||'')&&v.test(pr.osm_value||''));
      if(!rule) return;
      const c=f.geometry.coordinates, d=distNm(ll,[c[1],c[0]])+rule[2];
      if(d<=maxNm&&(!best||d<best.d)) best={d,name:nm};
    });
    return best?best.name:'';
  }

  // Aerodrome by OpenStreetMap: the airfield polygon at the point (zoom 18).
  // → {icao,name,elevFt:null}|null. Common "Flugplatz …" prefixes are dropped.
  async function osmAerodrome(ll){
    const j=await nominatim(ll,18,true);
    if(!/^aeroway$/.test(j.category||'')||!/aerodrome|airfield|airport|heliport/.test(j.type||'')) return null;
    const x=j.extratags||{};
    let name=String(j.name||'').replace(/^(Flugplatz|Flugfeld|Flughafen|Regionalflugplatz|Aérodrome d[eu']\s?|Aéroport d[eu']\s?|Aeroporto di|Aeródromo de)\s*/i,'').replace(/\s+(Airport|Airfield|Aerodrome)$/i,'').trim();
    const icao=String(x.icao||x['icao_code']||'').toUpperCase();
    return name||icao?{icao:/^[A-Z]{4}$/.test(icao)?icao:'',name,elevFt:null}:null;
  }

  // Nearest aerodrome → {icao,name,elevFt,decl}|null. openAIP's CDN refuses
  // requests from server IPs (HTTP 403 for any key), so the browser asks
  // openAIP directly with the key it already holds for the map tiles; the
  // backend proxy is the fallback when there is no key in the browser.
  function aipItem(a){
    const el=a.elevation||{}, ev=el.value;
    const elevFt=typeof ev==='number'?(el.unit===1?Math.round(ev):Math.round(ev*3.28084)):null;   // openAIP: 0 = m, 1 = ft
    const c=(a.geometry&&a.geometry.coordinates)||[];
    return {icao:a.icaoCode||'',name:a.name||'',elevFt,decl:typeof a.magneticDeclination==='number'?a.magneticDeclination:null,lat:c[1],lon:c[0]};
  }
  async function lookupAerodrome(ll,opts){
    const pos=ll[0].toFixed(5)+','+ll[1].toFixed(5);
    if(opts.aipKey){
      try{
        const r=await fetch('https://api.core.openaip.net/api/airports?pos='+pos+'&dist=3000&limit=5',{headers:{'x-openaip-api-key':opts.aipKey,'Accept':'application/json'}});
        if(r.ok){
          const items=((await r.json()).items||[]).map(aipItem).filter(a=>isFinite(a.lat)&&isFinite(a.lon));
          items.sort((a,b)=>distNm(ll,[a.lat,a.lon])-distNm(ll,[b.lat,b.lon]));
          return items[0]||null;
        }
      }catch(e){/* CORS or network — fall through to the proxy */}
    }
    const headers={};
    if(opts.aipKey) headers['X-OpenAIP-Key']=opts.aipKey;
    const r=await fetch(opts.apiBase+'/aip/airports?lat='+ll[0].toFixed(5)+'&lon='+ll[1].toFixed(5)+'&dist=3000',{headers,credentials:'include'});
    if(r.status===401) throw new Error('sign in first — ICAO codes and elevations come from openAIP');
    if(!r.ok){let m='';try{m=(await r.json()).error||'';}catch(e){}throw new Error(m||('backend answered '+r.status));}
    const j=await r.json();
    return (j.items&&j.items[0])||null;
  }

  // points: fp.points ([{ll,name,type,isAirfield}]);
  // opts: {apiBase, aipKey, onStatus(msg)}.
  // → {names:[{ident,name,elevFt}|null], decl:number|null, errors:[string]}
  // Points that already carry a name are left alone. Names are kept unique
  // along the route (a second point in the same village gets a finer name,
  // or stays a coordinate).
  async function lookupNames(points,opts){
    const out=points.map(()=>null), errors=[], seen=new Map();
    const status=opts.onStatus||(()=>{});
    const used=new Set(points.map(p=>p.name).filter(Boolean));
    let decl=null, aipDown=false, osmCalls=0, osmDown=false;
    const osm=async fn=>{ if(osmCalls++) await sleep(1100); return fn(); };
    for(let i=0;i<points.length;i++){
      const p=points[i];
      if(!p.isAirfield) continue;
      const k=coordKey(p.ll);
      if(seen.has(k)){out[i]=seen.get(k);continue;}
      status('Looking up airfield '+(i+1)+'/'+points.length+'…');
      let res=null;
      if(!aipDown){
        try{
          const a=await lookupAerodrome(p.ll,opts);
          if(a){res={ident:a.icao||'',name:a.name||'',elevFt:isFinite(a.elevFt)?a.elevFt:null};
            if(isFinite(a.decl)&&decl==null) decl=+a.decl;}
        }catch(e){aipDown=true;errors.push('openAIP: '+e.message);}
      }
      if(!res&&!osmDown){
        try{res=await osm(()=>osmAerodrome(p.ll));}
        catch(e){osmDown=true;errors.push('OpenStreetMap: '+e.message);}
      }
      if(res&&res.name) used.add(res.name);
      seen.set(k,res); out[i]=res;
    }
    let photonDown=false;
    for(let i=0;i<points.length;i++){
      const p=points[i];
      if(p.isAirfield||p.name) continue;
      const k=coordKey(p.ll);
      if(seen.has(k)){out[i]=seen.get(k);continue;}
      status('Looking up place name '+(i+1)+'/'+points.length+'…');
      const town=/town|city|village/i.test(p.type||'');
      let name='';
      try{
        if(town){ if(!osmDown) name=(await osm(()=>reverseGeocode(p.ll,'town'))).find(n=>!used.has(n))||''; }
        else if(!photonDown){ name=await photonNearest(p.ll,0.6); if(used.has(name)) name=''; }
      }catch(e){
        if(town){osmDown=true;errors.push('OpenStreetMap: '+e.message);}
        else{photonDown=true;errors.push('Photon: '+e.message);}
      }
      const res=name?{ident:'',name,elevFt:null}:null;
      if(name) used.add(name);
      seen.set(k,res); out[i]=res;
    }
    if(aipDown&&out.some((r,i)=>points[i].isAirfield&&r&&r.name&&r.ident)) errors.splice(errors.findIndex(e=>/^openAIP/.test(e)),1);   // OSM covered it, ICAO included
    return {names:out,decl,errors};
  }

  return {parseSdCoord,fmtSdCoord,fmtNavCoord,distNm,bearing,sourceKey,
    parseFlightplan,toParsedRows,toAltnRow,buildFlightplan,mergeRoute,
    windTriangle,legFromWind,windAtAlt,fetchWindsAloft,fetchElevationFt,reverseGeocode,photonNearest,osmAerodrome,lookupNames};
})();
