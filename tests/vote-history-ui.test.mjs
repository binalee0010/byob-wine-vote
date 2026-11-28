import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const require=createRequire(import.meta.url);
const bundle=await build({ stdin:{ contents:`export {default as Admin, Progress, RankedResponses} from './Admin';`,resolveDir:fileURLToPath(new URL('../src',import.meta.url)),loader:'tsx'},bundle:true,write:false,format:'esm',platform:'browser',plugins:[{name:'history-test-hooks',setup(builder){
  builder.onResolve({filter:/^react$/},()=>({path:'hooks',namespace:'test'}));
  builder.onLoad({filter:/^hooks$/,namespace:'test'},()=>({contents:`export const useState=v=>globalThis.historyHooks.state(v); export const useRef=v=>globalThis.historyHooks.memo(()=>({current:v}),[]); export const useEffect=(fn,deps)=>globalThis.historyHooks.effect(fn,deps); export const useId=()=>globalThis.historyHooks.memo(()=> 'confirm-history',[]); export const useMemo=(fn,deps)=>globalThis.historyHooks.memo(fn,deps); export const useCallback=(fn,deps)=>globalThis.historyHooks.memo(()=>fn,deps);`}));
  builder.onResolve({filter:/^\.\/App$/},()=>({path:'app',namespace:'test'}));
  builder.onLoad({filter:/^app$/,namespace:'test'},()=>({contents:`export function Notice(props){return props.children};export function PhotoDialog(){return null};export function RankedResultList(){return null};export function Status(){return null}`}));
  builder.onResolve({filter:/^react\/jsx-runtime$/},({path})=>({path:pathToFileURL(require.resolve(path)).href,external:true}));
}}]});
const {Admin,Progress,RankedResponses}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const nodes=tree=>!tree||typeof tree!=='object'?[]:Array.isArray(tree)?tree.flatMap(nodes):[tree,...nodes(tree.props?.children)];
const byType=(tree,type)=>nodes(tree).find(node=>node.type===type);
const byName=(tree,name)=>nodes(tree).find(node=>node.type?.name===name);
const button=(tree,label)=>nodes(tree).find(node=>node.type==='button'&&node.props.children===label);
const settle=()=>new Promise(resolve=>setImmediate(resolve));
function mount(render){let cursor=0;const slots=[],pending=[];const changed=(a,b)=>!a||!b||a.length!==b.length||a.some((v,i)=>!Object.is(v,b[i]));const hooks={
  state(initial){const i=cursor++;if(!(i in slots))slots[i]={value:typeof initial==='function'?initial():initial};return [slots[i].value,value=>{slots[i].value=typeof value==='function'?value(slots[i].value):value}];},
  memo(fn,deps){const i=cursor++;if(!slots[i]||changed(slots[i].deps,deps))slots[i]={value:fn(),deps};return slots[i].value;},
  effect(fn,deps){const i=cursor++;if(!slots[i]||changed(slots[i].deps,deps)){const previous=slots[i];slots[i]={deps};pending.push(()=>{previous?.cleanup?.();slots[i].cleanup=fn()});}},
};return {render(){cursor=0;globalThis.historyHooks=hooks;const tree=render();pending.splice(0).forEach(run=>run());return tree;},close(){slots.forEach(slot=>slot.cleanup?.())}}}
const preventDefault=()=>{};
function environment(){const previous={fetch:globalThis.fetch,window:globalThis.window,document:globalThis.document,hooks:globalThis.historyHooks};globalThis.window={setTimeout,clearTimeout};globalThis.document={getElementById:()=>null};return ()=>{Object.assign(globalThis,{fetch:previous.fetch,window:previous.window,document:previous.document,historyHooks:previous.hooks})}}

const liveState=status=>({event:{title:'현재 투표'},activities:[{id:'byob',title:'질문',revision:7,status,started:status!=='waiting',published:false,resultsLocked:false,resultVisibility:'private',votingMethod:'winner'}],participants:[],rosterRevision:2,submittedCount:3,photoCleanupPending:0,candidates:[{id:'wine-a',number:1,name:'원래 이름',description:'보존할 설명',photoUrl:'/photo-a'}],byobResults:[{id:'wine-a',candidateId:'wine-a',number:1,name:'원래 이름',description:'보존할 설명',photoUrl:'/photo-a',rank:1,votes:3}]});

test('results save changed names once with the existing identity and revision, retain drafts after failures, and honor the live lock',async()=>{
  const restore=environment();const NativeFormData=globalThis.FormData;let fail=true;const requests=[];let state=liveState('closed');
  globalThis.FormData=class extends NativeFormData{constructor(form){super();for(const [key,value] of Object.entries(form))this.set(key,value)}};
  const action=async(path,method,body,feedback)=>{requests.push({path,method,body,success:feedback.success});if(fail){feedback.error('다시 시도해 주세요.');return false}state={...state,candidates:state.candidates.map(row=>({...row,name:body.names[0].name})),byobResults:state.byobResults.map(row=>({...row,name:body.names[0].name}))};return true};
  const app=mount(()=>RankedResponses({state,action,busy:false}));let input;
  try{
    let tree=app.render();assert.ok(!JSON.stringify(tree).includes('기록에 저장'));assert.ok(button(tree,'와인 이름 수정'));
    button(tree,'와인 이름 수정').props.onClick();tree=app.render();const list=byName(tree,'RankedResultList');const before=structuredClone(list.props.rows);
    const editor=list.props.nameEditor(state.byobResults[0]);assert.equal(editor.props.name,'wine-a');assert.equal(editor.props.serverValue,'원래 이름');
    input=mount(()=>editor.type(editor.props));let inputTree=input.render();inputTree.props.onChange({target:{value:'수정할 이름'}});assert.equal(input.render().props.value,'수정할 이름');
    await byType(tree,'form').props.onSubmit({preventDefault,currentTarget:{'wine-a':'수정할 이름'}});tree=app.render();assert.ok(JSON.stringify(tree).includes('다시 시도해 주세요.'));assert.equal(input.render().props.value,'수정할 이름');assert.ok(byName(tree,'RankedResultList').props.nameEditor);
    assert.deepEqual(byName(tree,'RankedResultList').props.rows,before);assert.deepEqual(requests[0],{path:'/admin/candidates/names',method:'PUT',body:{revision:7,names:[{id:'wine-a',name:'수정할 이름'}]},success:'와인 정보 1개를 저장했습니다.'});
    fail=false;let release;const pending=new Promise(resolve=>{release=resolve});const slow=async(...args)=>{await pending;return action(...args)};
    const successApp=mount(()=>RankedResponses({state,action:slow,busy:false}));try{let savedTree=successApp.render();button(savedTree,'와인 이름 수정').props.onClick();savedTree=successApp.render();const submit=byType(savedTree,'form').props.onSubmit;const first=submit({preventDefault,currentTarget:{'wine-a':'최종 이름'}});await submit({preventDefault,currentTarget:{'wine-a':'최종 이름'}});release();await first;savedTree=successApp.render();assert.equal(requests.length,2);assert.equal(byName(savedTree,'RankedResultList').props.nameEditor,undefined);assert.equal(state.candidates[0].name,'최종 이름');assert.deepEqual(state.byobResults[0],{...before[0],name:'최종 이름'});}finally{successApp.close()}
    for(const status of ['waiting','open']){const lockedApp=mount(()=>RankedResponses({state:liveState(status),action,busy:false}));try{const lockedTree=lockedApp.render();assert.equal(!!button(lockedTree,'와인 이름 수정'),status==='waiting')}finally{lockedApp.close()}}
  }finally{input?.close();app.close();globalThis.FormData=NativeFormData;restore()}
});

test('the progress page includes submissions and each poll has its own results',async()=>{
  const restore=environment();const previousLocation=globalThis.location;globalThis.location={origin:'https://vote.test',pathname:'/admin/p/one'};
  const state=liveState('closed'),requests=[];globalThis.fetch=async path=>{requests.push(path);return Response.json(state)};
  const app=mount(()=>Admin({member:{id:'member',email:'m@example.test',role:'member',status:'approved',workspaceSlug:'one'},pollSlug:'one'}));let progress;
  try{
    app.render();await settle();let tree=app.render();const tabs=byType(tree,'nav');
    assert.deepEqual(nodes(tabs).filter(node=>node.type==='button').map(node=>node.props.children),['투표 진행','후보 등록','투표 결과']);
    progress=mount(()=>Progress({state,action:async()=>true,busy:false}));const progressTree=progress.render();
    assert.ok(byName(progressTree,'Participants'));
    const reset=nodes(progressTree).find(node=>node.type?.name==='DestructiveAction'&&node.props.label==='투표 전체 초기화');assert.ok(reset.props.request.description.includes('현재 결과를 삭제'));assert.ok(reset.props.request.description.includes('되돌릴 수 없습니다'));
    button(tree,'투표 결과').props.onClick();tree=app.render();
    const shown=nodes(tree).find(node=>node.type==='div'&&node.props.hidden===false);
    assert.ok(byName(shown,'RankedResponses'));assert.equal(byName(shown,'VoteHistory'),undefined);
    assert.ok(requests.every(path=>!path.includes('/history')));
  }finally{await settle();progress?.close();app.close();globalThis.location=previousLocation;restore()}
});
