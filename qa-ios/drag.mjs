import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

const fixture = 'http://127.0.0.1:8765';
const udid = process.env.QA_PHONE;
const axe=(...args)=>execFileSync('axe',[...args.map(String),'--udid',udid],{encoding:'utf8',timeout:60000});
function send(action) {
  try { return action(); }
  catch(e) { console.warn('Simulator command returned before delivery could be confirmed:',String(e).slice(0,240)); }
}
const tap=({x,y})=>send(()=>axe('tap','-x',x,'-y',y));
const screenshot=name=>execFileSync('xcrun',['simctl','io',udid,'screenshot','evidence/'+name]);
const observe = async () => (await fetch(fixture + '/observe')).json();
const openPage = () => send(()=>execFileSync('xcrun', ['simctl','openurl',udid,fixture+'/start'],{timeout:45000}));
async function waitFor(read, accept, label, seconds = 75) {
  const deadline = Date.now() + seconds*1000;
  let last;
  do {
    try { last = await read(); if (accept(last)) return last; } catch(e) { last = String(e); }
    await delay(400);
  } while(Date.now() < deadline);
  throw Error(label + ' timed out. ' + JSON.stringify(last).slice(0,3300));
}
function dismissWelcome() {
  const tree=send(()=>axe('describe-ui')) || '';
  console.log('Safari accessibility tree',tree.slice(0,3000));
  for (const name of ['Continue','Start Browsing','Not Now','Get Started','Continue to Safari','Open','Done','OK','Skip']) {
    if(tree.includes('"'+name+'"')) {
      try { axe('tap','--label',name); return true; } catch {}
    }
  }
  return false;
}
const sameOrder = items => snapshot => snapshot.order?.join() === items.join() && snapshot.grips?.length === 3;
const before = ['Alpha','Bravo','Charlie'];
const after = ['Charlie','Alpha','Bravo'];
try {
  const runtimes = JSON.parse(execFileSync('xcrun',['simctl','list','devices','available','-j'])).devices;
  const [runtime, devices] = Object.entries(runtimes).find(([,d])=>d.some(v=>v.udid===udid));
  const device = devices.find(d=>d.udid===udid).name;
  console.log('Native Simulator HID', device, runtime);
  openPage();
  let initial;
  for (let attempt = 0; attempt < 4 && !initial; attempt++) {
    try { initial = await waitFor(observe,sameOrder(before),'open Safari participant page',75); }
    catch(e) { if(attempt === 3) throw e; dismissWelcome(); openPage(); }
  }
  console.log('Safari rendered', initial.userAgent, initial.order);
  const command=await (await fetch(fixture+'/prepare-calibration')).json();
  await waitFor(observe,s=>s.pageId===initial.pageId && s.calibration===command.calibrate && s.taps.length===0,'fresh touch calibration');
  for (const [i,p] of [{x:140,y:330},{x:220,y:410}].entries()) {
    let tapped = false;
    for(let attempt=0; attempt<4 && !tapped; attempt++) {
      tap(p);
      try { await waitFor(observe,s=>s.taps?.length>=i+1,'trusted calibration tap',35); tapped=true; }
      catch(e) { if(attempt===3) throw e; await dismissWelcome(); }
    }
  }
  const state = await observe();
  const taps = state.taps;
  assert.equal(taps.length,2);
  assert.ok(taps.every(e=>e.trusted && e.type==='touch'));
  const sx = 80/(taps[1].x-taps[0].x), sy = 80/(taps[1].y-taps[0].y);
  assert.ok(sx>.8 && sx<1.3 && sy>.8 && sy<1.3,JSON.stringify(taps));
  const screen = p=>({x:Math.round(140+(p.x-taps[0].x)*sx),y:Math.round(330+(p.y-taps[0].y)*sy)});
  const from=screen(state.grips[2]), to=screen(state.grips[0]);
  console.log('Dragging last grip to first',from,to,taps);
  const endpoints=['--start-x',from.x,'--start-y',from.y,'--end-x',to.x,'--end-y',to.y];
  send(()=>axe('drag',...endpoints,'--duration',.75,'--steps',18,'--hold',.14));
  let moved;
  const finished=s=>sameOrder(after)(s) && s.touchTrace.some(e=>e.wine==='Charlie' && e.name==='pointerup');
  try { moved=await waitFor(observe,finished,'native HID drag'); }
  catch(e) {
    const state=await observe();
    if (finished(state)) moved=state;
    else {
      if(!sameOrder(before)(state))throw e;
      console.log('Trying native swipe',state.touchTrace?.slice(-8));
      send(()=>axe('swipe',...endpoints,'--duration',.8));
      moved=await waitFor(observe,finished,'continuous native touch reorder');
    }
  }
  assert.deepEqual(moved.values,['1','2','0','']);
  assert.ok(['pointerdown','pointermove','pointerup'].every(name=>moved.touchTrace.some(e=>e.name===name && e.type==='touch' && e.trusted)));
  assert.ok(moved.touchTrace.some(e=>e.wine==='Charlie' && e.name==='pointerdown' && e.trusted && e.type==='touch'));
  send(()=>screenshot('safari.png'));
  const prepare=await (await fetch(fixture+'/prepare-submit')).json();
  const save=(await waitFor(observe,s=>s.submitCommand===prepare.submit && s.submit?.y>0 && s.submit.y<s.height,'visible submit button')).submit;
  assert.ok(save, 'submit button visible');
  console.log('Saving at',screen(save));
  tap(screen(save));
  const readScores=async()=>(await fetch(fixture+'/proof')).json();
  const correct=p=>p.submitted===1 && p.points.Charlie===3 && p.points.Alpha===2 && p.points.Bravo===1;
  let points;
  try { points=await waitFor(readScores,correct,'D1 final scores',40); }
  catch(error) {
    send(()=>axe('tap','--label','수정 내용 제출'));
    points=await waitFor(readScores,correct,'D1 after tapping accessible submit button');
  }
  const lastPage=(await observe()).pageId;
  await fetch(fixture+'/prepare-reload');
  const restored=await waitFor(observe,s=>s.pageId!==lastPage && sameOrder(after)(s),'reload saved order');
  const proof={device,runtime,userAgent:restored.userAgent,input:'native HID touch on Apple iPhone Simulator Safari',inputEvents:[...new Set(moved.touchTrace.filter(e=>e.trusted&&e.type==='touch').map(e=>e.name))],before,after:moved.order,afterReload:restored.order,...points};
  console.log('SAFARI_PROOF',JSON.stringify(proof));
  await writeFile('evidence/safari.json',JSON.stringify(proof,null,2));
} catch(error) {
  try { screenshot('failure.png'); } catch {}
  try { await writeFile('evidence/failure-ui.json',axe('describe-ui')); } catch {}
  try { await writeFile('evidence/failure.json',JSON.stringify(await observe(),null,2)); } catch {}
  throw error;
}
