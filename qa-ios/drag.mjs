import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

const driver = 'http://127.0.0.1:4723';
const fixture = 'http://127.0.0.1:8765';
const udid = process.env.QA_PHONE;
let sessionId;

async function call(method, path, body) {
  const response = await fetch(driver + path, { method, headers: {'content-type':'application/json'}, body: JSON.stringify(body) });
  const {value} = await response.json();
  if (!response.ok || value?.error) throw Error(method + ' ' + path + ' ' + JSON.stringify(value).slice(0,2200));
  return value;
}
const cmd = (method, path, body) => call(method, '/session/' + sessionId + path, body);
const mobile = (action, options) => cmd('POST', '/execute/sync', {script:'mobile: ' + action, args:[options]});
const observe = async () => (await fetch(fixture + '/observe')).json();
const openPage = () => execFileSync('xcrun', ['simctl','openurl',udid,fixture+'/start']);
async function waitFor(read, accept, label, seconds = 30) {
  const deadline = Date.now() + seconds*1000;
  let last;
  do {
    try { last = await read(); if (accept(last)) return last; } catch(e) { last = String(e); }
    await delay(400);
  } while(Date.now() < deadline);
  throw Error(label + ' timed out. ' + JSON.stringify(last).slice(0,3300));
}
async function dismissWelcome() {
  const buttons = await cmd('POST','/elements',{using:'-ios predicate string',value:"type == 'XCUIElementTypeButton' AND label IN {'Continue','Start Browsing','Not Now','Done','Get Started','Skip','OK','Continue to Safari'}"});
  if (!buttons.length) return false;
  await cmd('POST','/element/'+Object.values(buttons[0])[0]+'/click',{});
  return true;
}
const sameOrder = items => snapshot => snapshot.order?.join() === items.join() && snapshot.grips?.length === 3;
const before = ['Alpha','Bravo','Charlie'];
const after = ['Charlie','Alpha','Bravo'];
try {
  const session = await call('POST','/session',{capabilities:{alwaysMatch:{
    platformName:'iOS','appium:automationName':'XCUITest','appium:bundleId':'com.apple.mobilesafari',
    'appium:udid':udid,'appium:deviceName':'iPhone','appium:noReset':true,'appium:autoWebview':false,
    'appium:newCommandTimeout':180,'appium:wdaLaunchTimeout':180000
  }}});
  sessionId = session.sessionId;
  const runtimes = JSON.parse(execFileSync('xcrun',['simctl','list','devices','available','-j'])).devices;
  const [runtime, devices] = Object.entries(runtimes).find(([,d])=>d.some(v=>v.udid===udid));
  const device = devices.find(d=>d.udid===udid).name;
  console.log('Native XCTest connected', device, runtime);
  openPage();
  let initial;
  for (let attempt = 0; attempt < 4 && !initial; attempt++) {
    try { initial = await waitFor(observe,sameOrder(before),'open Safari participant page',12); }
    catch(e) { if(attempt === 3) throw e; await dismissWelcome(); openPage(); }
  }
  console.log('Safari rendered', initial.userAgent, initial.order);
  for (const [i,p] of [{x:140,y:330},{x:220,y:410}].entries()) {
    let tapped = false;
    for(let attempt=0; attempt<4 && !tapped; attempt++) {
      await mobile('tap',p);
      try { await waitFor(observe,s=>s.taps?.length>=i+1,'trusted calibration tap',3); tapped=true; }
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
  await mobile('dragFromToForDuration',{duration:.48,fromX:from.x,fromY:from.y,toX:to.x,toY:to.y});
  let moved;
  try { moved=await waitFor(observe,sameOrder(after),'XCTest drag',5); }
  catch(e) {
    const state=await observe();
    if(!sameOrder(before)(state))throw e;
    console.log('Trying a continuous native touch sequence',state.touchTrace?.slice(-8));
    const actions=[{type:'pointerMove',duration:0,...from},{type:'pointerDown',button:0},{type:'pause',duration:220}];
    for(let i=1;i<=12;i++) actions.push({type:'pointerMove',duration:65,x:Math.round(from.x+(to.x-from.x)*i/12),y:Math.round(from.y+(to.y-from.y)*i/12)});
    actions.push({type:'pointerUp',button:0});
    await cmd('POST','/actions',{actions:[{type:'pointer',id:'finger',parameters:{pointerType:'touch'},actions}]});
    moved=await waitFor(observe,sameOrder(after),'continuous native touch reorder');
  }
  assert.deepEqual(moved.values,['1','2','0']);
  assert.ok(['pointerdown','pointermove','pointerup'].every(name=>moved.touchTrace.some(e=>e.name===name && e.type==='touch' && e.trusted)));
  await writeFile('evidence/safari.png', Buffer.from(await cmd('GET','/screenshot'),'base64'));
  await fetch(fixture+'/prepare-submit');
  await delay(1400);
  const save=(await observe()).submit;
  assert.ok(save, 'submit button visible');
  console.log('Saving at',screen(save));
  await mobile('tap',screen(save));
  const readScores=async()=>(await fetch(fixture+'/proof')).json();
  const correct=p=>p.submitted===1 && p.points.Charlie===3 && p.points.Alpha===2 && p.points.Bravo===1;
  let points;
  try { points=await waitFor(readScores,correct,'D1 final scores',6); }
  catch(error) {
    const buttons=await cmd('POST','/elements',{using:'accessibility id',value:'수정 내용 제출'});
    if(!buttons.length)throw error;
    await cmd('POST','/element/'+Object.values(buttons[0])[0]+'/click',{});
    points=await waitFor(readScores,correct,'D1 after tapping accessible submit button');
  }
  const lastPage=(await observe()).pageId;
  await fetch(fixture+'/prepare-reload');
  const restored=await waitFor(observe,s=>s.pageId!==lastPage && sameOrder(after)(s),'reload saved order');
  const proof={device,runtime,userAgent:restored.userAgent,input:'native XCTest touch on Apple iPhone Simulator Safari',inputEvents:[...new Set(moved.touchTrace.filter(e=>e.trusted&&e.type==='touch').map(e=>e.name))],before,after:moved.order,afterReload:restored.order,...points};
  console.log('SAFARI_PROOF',JSON.stringify(proof));
  await writeFile('evidence/safari.json',JSON.stringify(proof,null,2));
} catch(error) {
  if (sessionId) {
    for (const [name,read] of [
      ['failure.json',async()=>JSON.stringify(await observe(),null,2)],
      ['failure.xml',()=>cmd('GET','/source')],
      ['failure.png',async()=>Buffer.from(await cmd('GET','/screenshot'),'base64')]
    ]) {try{await writeFile('evidence/'+name,await read());}catch(e){console.error(String(e));}}
  }
  throw error;
} finally {
  if(sessionId) await cmd('DELETE','').catch(()=>{});
}
