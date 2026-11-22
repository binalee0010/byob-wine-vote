import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
const driver='http://127.0.0.1:4723';
let sid;
async function call(method, path, body) {
  const r = await fetch(driver+path, {method, headers:{'content-type':'application/json'}, ...(body===undefined?{}:{body:JSON.stringify(body)})});
  const data=await r.json();
  if (!r.ok || data.value?.error) throw Error(method+' '+path+' '+JSON.stringify(data.value).slice(0,2500));
  return data.value;
}
const cmd=(method,path,body)=>call(method,'/session/'+sid+path,body);
const js=(script,...args)=>cmd('POST','/execute/sync',{script,args});
async function waitFor(fn, label, seconds=25) {
  let last;
  for(let i=0;i<seconds*2;i++){ try{last=await fn();if(last)return last;}catch(e){last=String(e);}await delay(500);}
  throw Error(label+' timed out: '+JSON.stringify(last));
}
try{
  const session=await call('POST','/session',{capabilities:{alwaysMatch:{
    platformName:'iOS',browserName:'Safari','appium:automationName':'XCUITest','appium:udid':process.env.QA_PHONE,
    'appium:deviceName':'iPhone','appium:newCommandTimeout':120,'appium:wdaLaunchTimeout':180000,
    'appium:safariInitialUrl':'http://127.0.0.1:8765/start','appium:showXcodeLog':true,
  }}});
  sid=session.sessionId; console.log('iPhone Safari session',session.capabilities.platformVersion);
  await cmd('POST','/url',{url:'http://127.0.0.1:8765/start'});
  const read=()=>js("return Array.from(document.querySelectorAll('.custom-rank-summary .rank-wine strong'),e=>e.textContent)");
  await waitFor(async()=> (await read()).join(',')==='Alpha,Bravo,Charlie','initial saved order');
  const web=await cmd('GET','/context');
  async function native(method,params){
    await cmd('POST','/context',{name:'NATIVE_APP'});
    try { return await js('mobile: '+method,params); }
    finally { await cmd('POST','/context',{name:web}); }
  }
  await js("document.querySelector('.custom-rank-summary').scrollIntoView({block:'center',behavior:'instant'})");
  await delay(700);
  // Measure the native-screen to CSS-viewport offset without assuming a Safari toolbar height.
  await js("const overlay=document.createElement('div');overlay.id='qa-calibration';overlay.style.cssText='position:fixed;inset:0;z-index:99999;touch-action:none';document.body.append(overlay);window.qaTaps=[];overlay.addEventListener('pointerdown',e=>window.qaTaps.push({x:e.clientX,y:e.clientY,trusted:e.isTrusted,type:e.pointerType}))");
  await native('tap',{x:140,y:330});
  await native('tap',{x:220,y:410});
  const cal=await js("document.getElementById('qa-calibration').remove();return window.qaTaps");
  assert.equal(cal.length,2);assert.ok(cal.every(x=>x.trusted&&x.type==='touch'));
  const sx=80/(cal[1].x-cal[0].x), sy=80/(cal[1].y-cal[0].y);
  assert.ok(sx>.8&&sx<1.3&&sy>.8&&sy<1.3);
  const screen=({x,y})=>({x:Math.round(140+(x-cal[0].x)*sx),y:Math.round(330+(y-cal[0].y)*sy)});
  const grips=await js("window.qaTouches=[];for(const name of ['pointerdown','pointermove','pointerup','pointercancel'])document.addEventListener(name,e=>{if(e.pointerType==='touch')window.qaTouches.push({name,trusted:e.isTrusted,type:e.pointerType})},true);return Array.from(document.querySelectorAll('.custom-rank-summary .rank-grip'),e=>{const b=e.getBoundingClientRect();return {x:b.x+b.width/2,y:b.y+b.height/2}})");
  const from=screen(grips[2]),to=screen(grips[0]);console.log('calibration and drag',cal,from,to);
  await native('dragFromToForDuration',{duration:.55,fromX:from.x,fromY:from.y,toX:to.x,toY:to.y});
  await waitFor(async()=> (await read()).join(',')==='Charlie,Alpha,Bravo','native drag reorder');
  const touches=await js('return window.qaTouches');
  assert.ok(['pointerdown','pointermove','pointerup'].every(name=>touches.some(e=>e.name===name&&e.trusted)));
  const values=await js("return Array.from(document.querySelectorAll('.custom-rank-row select'),s=>s.value)");
  assert.deepEqual(values,['1','2','0']);
  await writeFile('evidence/safari.png',Buffer.from(await cmd('GET','/screenshot'),'base64'));
  const save=await cmd('POST','/element',{using:'css selector',value:'.answer-panel form button.primary'});
  await cmd('POST','/element/'+Object.values(save)[0]+'/click',{});
  const points=await waitFor(async()=>{const r=await(await fetch('http://127.0.0.1:8765/proof')).json();return r.points.Charlie===3&&r.points.Alpha===2&&r.points.Bravo===1&&r.submitted===1?r:null;},'server score');
  await cmd('POST','/refresh',{});
  await waitFor(async()=> (await read()).join(',')==='Charlie,Alpha,Bravo','persisted after reload');
  const proof={runtime:session.capabilities.platformVersion,device:session.capabilities.deviceName,userAgent:await js('return navigator.userAgent'),input:'XCTest native drag on Apple iPhone Simulator',inputEvents:[...new Set(touches.filter(e=>e.trusted).map(e=>e.name))],order:await read(),...points};
  console.log('SAFARI_PROOF',JSON.stringify(proof));
  await writeFile('evidence/safari.json',JSON.stringify(proof,null,2));
}catch(e){
  if(sid){try{console.error('DOM',await js("return {url:location.href,text:document.body.innerText.slice(0,900),touches:window.qaTouches,cal:window.qaTaps}"));await writeFile('evidence/failure.png',Buffer.from(await cmd('GET','/screenshot'),'base64'));}catch{}}
  throw e;
}finally{if(sid)await cmd('DELETE','').catch(()=>{});}
