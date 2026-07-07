/* ═════════════════════════════════════════════════════════════════════
   da20_takeoff_calc.js — DA20-C1 takeoff + landing distance calculations
   and compact SVG pictures. Used by da20_navplan.html for the inline
   TO/LDG pictures on the print. DA20 analogue of takeoff_calc.js, but:
     • takeoff = distance to clear an obstacle only (no ground roll — the
       POH takeoff chart provides no ground-roll figure);
     • landing = over-50ft distance + landing roll (POH Table 4).
   Reads a `da20_takeoff` localStorage state written by da20_takeoff.html.
   ═════════════════════════════════════════════════════════════════════ */
(function(){
  "use strict";

  function lin(xs,ys,x){
    if(x<=xs[0]){const s=(ys[1]-ys[0])/(xs[1]-xs[0]);return ys[0]+s*(x-xs[0]);}
    if(x>=xs[xs.length-1]){const n=xs.length;const s=(ys[n-1]-ys[n-2])/(xs[n-1]-xs[n-2]);return ys[n-1]+s*(x-xs[n-1]);}
    for(let i=0;i<xs.length-1;i++){if(x>=xs[i]&&x<=xs[i+1]){const t=(x-xs[i])/(xs[i+1]-xs[i]);return ys[i]+t*(ys[i+1]-ys[i]);}}
    return ys[ys.length-1];
  }

  let pohPromise=null;
  function loadPOH(){
    if(!pohPromise) pohPromise=Promise.all([
      fetch('da20_c1_takeoff.json').then(r=>r.json()),
      fetch('da20_c1_landing.json').then(r=>r.json())
    ]).then(([T,L])=>({takeoff:buildTakeoff(T), landing:L}));
    return pohPromise;
  }

  // Build the takeoff interpolators from the JSON (mirrors da20_takeoff.html).
  function buildTakeoff(j){
    const rows=Object.keys(j.base_surface_800kg).map(Number).sort((a,b)=>a-b);
    const base_rows={};
    rows.forEach(pa=>{const r=j.base_surface_800kg[String(pa)];base_rows[pa]={oat:r.oat_c,d:r.dist_m};});
    const wk=Object.keys(j.weight_factor).map(Number).sort((a,b)=>a-b);
    const wf=wk.map(k=>j.weight_factor[String(k)]);
    const hk=Object.keys(j.headwind_factor_0kt).map(Number).sort((a,b)=>a-b);
    const hf=hk.map(k=>j.headwind_factor_0kt[String(k)]);
    const oc={},ol=Object.keys(j.obstacle_curves).map(Number).sort((a,b)=>a-b);
    ol.forEach(l=>{const c=j.obstacle_curves[String(l)];const hs=Object.keys(c).map(Number).sort((a,b)=>a-b);oc[l]={hs,vs:hs.map(h=>c[h])};});
    return {rows,base_rows,wk,wf,hk,hf,oc,olabels:ol};
  }
  function toBase(M,oat,pa){
    const rows=M.rows;let p0=rows[0],p1=rows[rows.length-1];
    for(let i=0;i<rows.length-1;i++){if(pa>=rows[i]&&pa<=rows[i+1]){p0=rows[i];p1=rows[i+1];break;}}
    if(pa<rows[0]){p0=rows[0];p1=rows[1];} if(pa>rows[rows.length-1]){p0=rows[rows.length-2];p1=rows[rows.length-1];}
    const r0=M.base_rows[p0],r1=M.base_rows[p1],d0=lin(r0.oat,r0.d,oat),d1=lin(r1.oat,r1.d,oat);
    return p0===p1?d0:d0+(d1-d0)*(pa-p0)/(p1-p0);
  }
  function toObstacle(M,D0,h){
    if(h<=0) return D0;
    const L=M.olabels;let a=L[0],b=L[L.length-1];
    for(let i=0;i<L.length-1;i++){if(D0>=L[i]&&D0<=L[i+1]){a=L[i];b=L[i+1];break;}}
    if(D0<L[0]){a=L[0];b=L[1];} if(D0>L[L.length-1]){a=L[L.length-2];b=L[L.length-1];}
    const oat=(lbl)=>lin(M.oc[lbl].hs,M.oc[lbl].vs,h),va=oat(a),vb=oat(b);
    return a===b?va:va+(vb-va)*(D0-a)/(b-a);
  }

  function readState(){
    try{
      const s=JSON.parse(localStorage.getItem('velis_da20_takeoff')||'{}');
      return {
        pa:+(s.pa!=null?s.pa:0),
        oat:+(s.oat!=null?s.oat:15),
        weight:+(s.weight!=null?s.weight:800),
        hw:+(s.hw!=null?s.hw:0),
        oh:+(s.oh!=null?s.oh:5)
      };
    }catch(e){return {pa:0,oat:15,weight:800,hw:0,oh:5};}
  }

  // Takeoff: distance to clear the obstacle (no ground roll).
  function computeTakeoff(POH, s){
    const M=POH.takeoff;
    const fW=lin(M.wk,M.wf,s.weight), fH0=lin(M.hk,M.hf,0), fH=lin(M.hk,M.hf,s.hw);
    const D0=toBase(M,s.oat,s.pa)*fW*(fH/fH0);
    return {dist:toObstacle(M,D0,s.oh), oh:s.oh};
  }
  // Landing: over-50ft distance + landing roll, POH Table 4 by height MSL.
  function computeLanding(POH, s){
    const L=POH.landing;
    return {
      total: lin(L.height_msl_ft, L.landing_distance_m, s.pa),
      roll:  lin(L.height_msl_ft, L.landing_roll_m, s.pa)
    };
  }

  const n0=v=>Math.round(v);

  // Takeoff picture: V=0 → climb over obstacle. No ground-roll split.
  function drawTakeoff(svg, dist, obsH, opts){
    opts=opts||{};
    const W=opts.W||700,H=opts.H||150,ML=opts.ML||22,MR=opts.MR||120,MT=opts.MT||26,MB=opts.MB||28;
    const fs=opts.fontSize||10.5;
    svg.setAttribute('viewBox',`0 0 ${W} ${H}`);
    const IW=W-ML-MR,runY=H-MB-14,topY=MT+18,fullH=runY-topY,frac=Math.max(0,Math.min(1,obsH/15));
    const obstX=ML+IW,obstY=runY-fullH*frac,ftH=Math.round(obsH*3.28084);
    let h='';
    h+=`<rect x="${ML}" y="${runY}" width="${IW}" height="3" fill="#ccc" rx="1"/>`;
    if(obsH>0.05){
      const c1x=ML+IW*0.55,c2x=obstX-IW*0.12,c2y=runY-fullH*frac*0.35;
      h+=`<path d="M${ML},${runY} C${c1x},${runY} ${c2x},${c2y} ${obstX},${obstY}" fill="none" stroke="#3B6D11" stroke-width="2.5"/>`;
      h+=`<line x1="${obstX}" y1="${runY}" x2="${obstX}" y2="${obstY}" stroke="#EF9F27" stroke-width="1.5" stroke-dasharray="4,3"/>`;
      h+=`<text x="${obstX+8}" y="${(runY+obstY)/2+3}" font-size="${fs}" fill="#EF9F27" font-weight="600">${obsH} m</text>`;
      h+=`<text x="${obstX+8}" y="${(runY+obstY)/2+16}" font-size="${fs-1.5}" fill="#EF9F27">${ftH} ft</text>`;
    }else{
      h+=`<line x1="${ML}" y1="${runY}" x2="${obstX}" y2="${runY}" stroke="#3B6D11" stroke-width="2.5"/>`;
    }
    h+=`<line x1="${ML}" y1="${MT+6}" x2="${obstX}" y2="${MT+6}" stroke="#3B6D11" stroke-width="1"/>`;
    h+=`<polygon points="${ML},${MT+3} ${ML+6},${MT+6} ${ML},${MT+9}" fill="#3B6D11"/>`;
    h+=`<polygon points="${obstX},${MT+3} ${obstX-6},${MT+6} ${obstX},${MT+9}" fill="#3B6D11"/>`;
    h+=`<text x="${(ML+obstX)/2}" y="${MT}" font-size="${fs}" fill="#3B6D11" text-anchor="middle" font-weight="600">To clear ${obsH} m: ${n0(dist)} m</text>`;
    h+=`<text x="${ML}" y="${runY-9}" font-size="${fs-2}" fill="#6b6660" text-anchor="middle">V = 0</text>`;
    h+=`<circle cx="${ML}" cy="${runY}" r="4" fill="#185FA5"/>`;
    h+=`<circle cx="${obstX}" cy="${obstY}" r="4.5" fill="#3B6D11"/>`;
    svg.innerHTML=h;
  }

  // Landing picture: descent over 50ft obstacle → touchdown → roll → stop.
  function drawLanding(svg, total, roll, opts){
    opts=opts||{};
    const W=opts.W||700,H=opts.H||150,ML=opts.ML||22,MR=opts.MR||40,MT=opts.MT||26,MB=opts.MB||42;
    const fs=opts.fontSize||10.5;
    svg.setAttribute('viewBox',`0 0 ${W} ${H}`);
    const IW=W-ML-MR,runY=H-MB-14,topY=MT+18,scale=IW/Math.max(total,1);
    const airborne=Math.max(total-roll,0),tdX=ML+airborne*scale,stopX=ML+total*scale,obstY=topY;
    let h='';
    h+=`<rect x="${ML}" y="${runY}" width="${IW}" height="3" fill="#ccc" rx="1"/>`;
    h+=`<rect x="${tdX}" y="${runY-4}" width="${stopX-tdX}" height="6" fill="#534AB7" rx="2" opacity="0.7"/>`;
    const c1x=ML+airborne*scale*0.45,c1y=obstY+(runY-obstY)*0.35,c2x=tdX-airborne*scale*0.15;
    h+=`<path d="M${ML},${obstY} C${c1x},${c1y} ${c2x},${runY} ${tdX},${runY}" fill="none" stroke="#3B6D11" stroke-width="2.5"/>`;
    h+=`<line x1="${ML}" y1="${runY}" x2="${ML}" y2="${obstY}" stroke="#EF9F27" stroke-width="1.5" stroke-dasharray="4,3"/>`;
    h+=`<text x="${ML+6}" y="${obstY-3}" font-size="${fs}" fill="#EF9F27" font-weight="600">50 ft (15 m)</text>`;
    h+=`<line x1="${ML}" y1="${MT+6}" x2="${stopX}" y2="${MT+6}" stroke="#3B6D11" stroke-width="1"/>`;
    h+=`<polygon points="${ML},${MT+3} ${ML+6},${MT+6} ${ML},${MT+9}" fill="#3B6D11"/>`;
    h+=`<polygon points="${stopX},${MT+3} ${stopX-6},${MT+6} ${stopX},${MT+9}" fill="#3B6D11"/>`;
    h+=`<text x="${(ML+stopX)/2}" y="${MT}" font-size="${fs}" fill="#3B6D11" text-anchor="middle" font-weight="600">Over 50 ft: ${n0(total)} m</text>`;
    if(stopX-tdX>60){
      h+=`<line x1="${tdX}" y1="${runY+16}" x2="${stopX}" y2="${runY+16}" stroke="#534AB7" stroke-width="1"/>`;
      h+=`<polygon points="${tdX},${runY+13} ${tdX+6},${runY+16} ${tdX},${runY+19}" fill="#534AB7"/>`;
      h+=`<polygon points="${stopX},${runY+13} ${stopX-6},${runY+16} ${stopX},${runY+19}" fill="#534AB7"/>`;
      h+=`<text x="${(tdX+stopX)/2}" y="${runY+28}" font-size="${fs-1.5}" fill="#534AB7" text-anchor="middle" font-weight="600">Roll: ${n0(roll)} m</text>`;
    }
    h+=`<text x="${stopX}" y="${runY-9}" font-size="${fs-2}" fill="#6b6660" text-anchor="middle">Stop</text>`;
    h+=`<circle cx="${ML}" cy="${obstY}" r="4.5" fill="#3B6D11"/>`;
    h+=`<circle cx="${tdX}" cy="${runY}" r="4" fill="#534AB7"/>`;
    h+=`<circle cx="${stopX}" cy="${runY}" r="4" fill="#534AB7"/>`;
    svg.innerHTML=h;
  }

  window.da20TakeoffCalc = { loadPOH, readState, computeTakeoff, computeLanding, drawTakeoff, drawLanding };
})();
