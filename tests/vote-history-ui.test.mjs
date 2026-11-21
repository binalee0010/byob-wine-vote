import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const require=createRequire(import.meta.url);
const bundle=await build({ stdin:{ contents:`export {default as VoteHistory, VoteHistoryDetail} from './VoteHistory'; export {default as DestructiveAction} from './DestructiveAction'; export {default as Admin, Progress, RankedResponses} from './Admin';`,resolveDir:fileURLToPath(new URL('../src',import.meta.url)),loader:'tsx'},bundle:true,write:false,format:'esm',platform:'browser',plugins:[{name:'history-test-hooks',setup(builder){
  builder.onResolve({filter:/^react$/},()=>({path:'hooks',namespace:'test'}));
  builder.onLoad({filter:/^hooks$/,namespace:'test'},()=>({contents:`export const useState=v=>globalThis.historyHooks.state(v); export const useRef=v=>globalThis.historyHooks.memo(()=>({current:v}),[]); export const useEffect=(fn,deps)=>globalThis.historyHooks.effect(fn,deps); export const useId=()=>globalThis.historyHooks.memo(()=> 'confirm-history',[]); export const useMemo=(fn,deps)=>globalThis.historyHooks.memo(fn,deps); export const useCallback=(fn,deps)=>globalThis.historyHooks.memo(()=>fn,deps);`}));
  builder.onResolve({filter:/^\.\/App$/},()=>({path:'app',namespace:'test'}));
  builder.onLoad({filter:/^app$/,namespace:'test'},()=>({contents:`export function Notice(props){return props.children};export function PhotoDialog(){return null};export function RankedResultList(){return null};export function Status(){return null}`}));
  builder.onResolve({filter:/^react\/jsx-runtime$/},({path})=>({path:pathToFileURL(require.resolve(path)).href,external:true}));
}}]});
const {VoteHistory,VoteHistoryDetail,DestructiveAction,Admin,Progress,RankedResponses}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
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
const savedRecord=()=>({id:'saved/id',version:'base-version',title:'기존 모임',activityTitle:'와인 투표',startedAt:'2026-11-20T10:00:00Z',savedAt:'2026-11-20T12:00:00Z',votingMethod:'full',rankPoints:[],ballotCount:2,rows:[{id:'a',candidateId:'a',number:1,name:'기존 와인',photoUrl:'/api/admin/history/saved/photos/a',rank:1,points:2}]});
const preventDefault=()=>{};
function environment(){const previous={fetch:globalThis.fetch,window:globalThis.window,document:globalThis.document,hooks:globalThis.historyHooks};globalThis.window={setTimeout,clearTimeout};globalThis.document={getElementById:()=>null};return ()=>{Object.assign(globalThis,{fetch:previous.fetch,window:previous.window,document:previous.document,historyHooks:previous.hooks})}}

test('history edit sends one versioned update, preserves drafts on failure, and keeps result fields read-only',async()=>{
  const restore=environment();let record=savedRecord();const requests=[];let fail=true;let deleted;
  globalThis.fetch=async(path,init)=>{requests.push([path,init.method,JSON.parse(init.body)]);if(fail)return Response.json({error:'연결 실패'},{status:503});const body=JSON.parse(init.body);return Response.json({record:{...record,version:'next-version',title:body.title,rows:record.rows.map(row=>({...row,name:body.names[0].name}))}})};
  const app=mount(()=>VoteHistoryDetail({record,onBack(){},onSaved:next=>{record=next},onDeleted:id=>{deleted=id}}));
  try{
    let tree=app.render();button(tree,'기록 수정').props.onClick();tree=app.render();
    const inputs=nodes(tree).filter(node=>node.type==='input');assert.equal(inputs.length,2);assert.ok(inputs.every(input=>input.props.maxLength===160));
    inputs[0].props.onChange({target:{value:'수정한 모임'}});inputs[1].props.onChange({target:{value:'수정한 와인'}});tree=app.render();
    const submit=byType(tree,'form').props.onSubmit;submit({preventDefault});submit({preventDefault});await settle();tree=app.render();
    assert.equal(requests.length,1);assert.deepEqual(requests[0],['/api/admin/history/saved%2Fid','PUT',{expectedVersion:'base-version',title:'수정한 모임',names:[{id:'a',name:'수정한 와인'}]}]);
    assert.deepEqual(nodes(tree).filter(node=>node.type==='input').map(node=>node.props.value),['수정한 모임','수정한 와인']);
    assert.equal(byName(tree,'RankedResultList').props.rows[0].points,2);assert.equal(byName(tree,'RankedResultList').props.rows[0].photoUrl,record.rows[0].photoUrl);
    fail=false;byType(tree,'form').props.onSubmit({preventDefault});await settle();tree=app.render();
    assert.equal(record.title,'수정한 모임');assert.equal(record.rows[0].name,'수정한 와인');assert.equal(record.version,'next-version');assert.equal(byType(tree,'form'),undefined);assert.equal(deleted,undefined);
  }finally{app.close();restore()}
});

test('history conflict retains edits until explicit reload and deletion uses a separate confirmation',async()=>{
  const restore=environment();let record=savedRecord();let deleted;const requests=[];
  globalThis.fetch=async(path,init)=>{requests.push([path,init.method,init.body&&JSON.parse(init.body)]);if(init.method==='PUT')return Response.json({error:'기록 변경',code:'history_changed'},{status:409});if(init.method==='GET')return Response.json({record:{...record,version:'fresh-version',title:'다른 화면의 모임'}});return Response.json({ok:true})};
  const app=mount(()=>VoteHistoryDetail({record,onBack(){},onSaved:next=>{record=next},onDeleted:id=>{deleted=id}}));let confirmation;
  try{
    let tree=app.render();button(tree,'기록 수정').props.onClick();tree=app.render();nodes(tree).find(node=>node.type==='input').props.onChange({target:{value:'남겨둘 초안'}});tree=app.render();byType(tree,'form').props.onSubmit({preventDefault});await settle();tree=app.render();
    assert.equal(nodes(tree).find(node=>node.type==='input').props.value,'남겨둘 초안');assert.ok(button(tree,'최신 기록 불러오기'));
    button(tree,'최신 기록 불러오기').props.onClick();await settle();tree=app.render();assert.equal(record.version,'fresh-version');assert.equal(nodes(tree).find(node=>node.type==='input').props.value,'다른 화면의 모임');
    button(tree,'수정 취소').props.onClick();tree=app.render();const deleteProps=byName(tree,'DestructiveAction').props;
    assert.deepEqual(deleteProps.request.body,{expectedVersion:'fresh-version',confirm:'delete-history'});assert.equal(requests.filter(row=>row[1]==='DELETE').length,0);
    confirmation=mount(()=>DestructiveAction(deleteProps));let dialog=confirmation.render();button(dialog,'기록 삭제').props.onClick();dialog=confirmation.render();assert.ok(byType(dialog,'dialog'));button(dialog,'취소').props.onClick();dialog=confirmation.render();assert.equal(byType(dialog,'dialog'),undefined);assert.equal(deleted,undefined);
    button(dialog,'기록 삭제').props.onClick();dialog=confirmation.render();byType(dialog,'form').props.onSubmit({preventDefault});await settle();assert.equal(deleted,record.id);assert.equal(requests.filter(row=>row[1]==='DELETE').length,1);
  }finally{confirmation?.close();app.close();restore()}
});

test('history save and delete immediately update the loaded list without another request',async()=>{
  const restore=environment();const record=savedRecord();let calls=0;
  globalThis.fetch=async(path)=>{calls++;return Response.json(path.endsWith('/admin/history')?{records:[record]}:{record})};
  const app=mount(VoteHistory);
  try{
    app.render();await settle();let tree=app.render();nodes(tree).find(node=>node.type==='button'&&node.props.id==='history-entry-'+record.id).props.onClick();app.render();await settle();tree=app.render();
    let detail=byName(tree,'VoteHistoryDetail');detail.props.onSaved({...record,title:'바로 바뀐 모임',version:'saved-version'});detail.props.onBack();tree=app.render();assert.ok(JSON.stringify(tree).includes('바로 바뀐 모임'));assert.equal(calls,2);
    nodes(tree).find(node=>node.type==='button'&&node.props.id==='history-entry-'+record.id).props.onClick();app.render();await settle();tree=app.render();detail=byName(tree,'VoteHistoryDetail');detail.props.onDeleted(record.id);tree=app.render();assert.equal(tree,null);assert.equal(calls,3);
  }finally{app.close();restore()}
});

test('archived description edits preserve the name, photo and saved result fields',async()=>{
  const restore=environment();let record=savedRecord();record.rows[0].description='기존 설명';let submitted;
  globalThis.fetch=async(path,init)=>{submitted=JSON.parse(init.body);return Response.json({record:{...record,version:'description-version',rows:record.rows.map(row=>({...row,description:submitted.names.find(change=>change.id===row.id)?.description??row.description}))}})};
  const original={...record.rows[0]};const app=mount(()=>VoteHistoryDetail({record,onBack(){},onSaved:next=>{record=next},onDeleted(){}}));
  try{
    let tree=app.render();button(tree,'기록 수정').props.onClick();tree=app.render();
    const description=byType(tree,'textarea');assert.equal(description.props.value,'기존 설명');description.props.onChange({target:{value:'상품, 음식과 여행지 설명'}});
    tree=app.render();byType(tree,'form').props.onSubmit({preventDefault});await settle();
    assert.deepEqual(submitted.names,[{id:'a',name:original.name,description:'상품, 음식과 여행지 설명'}]);
    assert.deepEqual(record.rows[0],{...original,description:'상품, 음식과 여행지 설명'});
  }finally{app.close();restore()}
});

for (const change of ['title-only', 'one-name', 'all-names']) test(`101-wine history sends only changed names (${change})`,async()=>{
  const restore=environment();let record=savedRecord();
  record.rows=Array.from({length:101},(_,index)=>({...record.rows[0],id:`wine-${index}`,candidateId:`wine-${index}`,number:index+1,name:`기존 와인 ${index+1}`}));
  let submitted;
  globalThis.fetch=async(path,init)=>{submitted=JSON.parse(init.body);const changes=new Map(submitted.names.map(row=>[row.id,row.name]));return Response.json({record:{...record,version:'updated-version',title:submitted.title,rows:record.rows.map(row=>({...row,name:changes.get(row.id)??row.name}))}})};
  const app=mount(()=>VoteHistoryDetail({record,onBack(){},onSaved:next=>{record=next},onDeleted(){}}));
  try{
    let tree=app.render();button(tree,'기록 수정').props.onClick();tree=app.render();
    const inputs=nodes(tree).filter(node=>node.type==='input');assert.equal(inputs.length,102);
    if(change==='title-only')inputs[0].props.onChange({target:{value:'제목만 수정'}});
    else if(change==='one-name')inputs[51].props.onChange({target:{value:'한 병만 수정'}});
    else inputs.slice(1).forEach((input,index)=>input.props.onChange({target:{value:`수정 와인 ${index+1}`}}));
    tree=app.render();byType(tree,'form').props.onSubmit({preventDefault});await settle();
    assert.equal(submitted.expectedVersion,'base-version');
    if(change==='title-only')assert.deepEqual(submitted.names,[]);
    else if(change==='one-name')assert.deepEqual(submitted.names,[{id:'wine-50',name:'한 병만 수정'}]);
    else assert.equal(submitted.names.length,101);
    assert.equal(record.version,'updated-version');
  }finally{app.close();restore()}
});

test('normal polls never render an empty saved-record section or create an archive',async()=>{
  const restore=environment();const requests=[];
  globalThis.fetch=async(path,init)=>{requests.push([path,init.method]);return Response.json({records:[]})};
  const app=mount(VoteHistory);
  try{assert.equal(app.render(),null);await settle();assert.equal(app.render(),null);assert.deepEqual(requests,[['/api/admin/history','GET']]);}
  finally{app.close();restore()}
});

test('all old snapshots remain selectable after a reset, and deleting one retains the others',async()=>{
  const restore=environment();const records=[savedRecord(),{...savedRecord(),id:'older/id',title:'이전 기록'}];
  globalThis.fetch=async(path)=>Response.json(path.endsWith('/admin/history')?{records}:{record:records.find(row=>path.endsWith(encodeURIComponent(row.id)))});
  const app=mount(VoteHistory);
  try{
    app.render();await settle();let tree=app.render();assert.equal(nodes(tree).filter(node=>node.props?.className==='history-entry').length,2);
    assert.ok(JSON.stringify(tree).includes('저장된 기록'));assert.ok(!JSON.stringify(tree).includes('지난 투표'));
    nodes(tree).find(node=>node.props?.id==='history-entry-older/id').props.onClick();app.render();await settle();tree=app.render();let detail=byName(tree,'VoteHistoryDetail');assert.equal(detail.props.record.title,'이전 기록');
    detail.props.onDeleted('older/id');tree=app.render();assert.equal(nodes(tree).filter(node=>node.props?.className==='history-entry').length,1);
    nodes(tree).find(node=>node.props?.id==='history-entry-saved/id').props.onClick();app.render();await settle();tree=app.render();assert.equal(byName(tree,'VoteHistoryDetail').props.record.id,'saved/id');
  }finally{app.close();restore()}
});

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

test('admin results contain saved snapshots within the poll and reset explicitly describes permanent current-result loss',async()=>{
  const restore=environment();const previousLocation=globalThis.location;globalThis.location={origin:'https://vote.test',pathname:'/admin/p/one'};
  const state=liveState('closed');globalThis.fetch=async()=>Response.json(state);
  const app=mount(()=>Admin({member:{id:'member',email:'m@example.test',role:'member',status:'approved',workspaceSlug:'one'},pollSlug:'one'}));let progress;
  try{
    app.render();await settle();let tree=app.render();const tabs=nodes(tree).find(node=>node.type==='nav');assert.deepEqual(nodes(tabs).filter(node=>node.type==='button').map(node=>node.props.children),['투표 진행','제출 현황','후보 등록','투표 결과']);assert.equal(byName(tree,'VoteHistory'),undefined);
    button(tree,'투표 결과').props.onClick();tree=app.render();assert.ok(byName(tree,'RankedResponses'));assert.ok(byName(tree,'VoteHistory'));assert.ok(!JSON.stringify(tree).includes('지난 투표'));
    progress=mount(()=>Progress({state,action:async()=>true,busy:false}));const reset=byName(progress.render(),'DestructiveAction');assert.ok(reset.props.request.description.includes('현재 결과를 삭제'));assert.ok(reset.props.request.description.includes('이전에 저장된 기록'));assert.ok(reset.props.request.description.includes('되돌릴 수 없습니다'));assert.ok(!reset.props.request.description.includes('저장하지 않은'));
  }finally{await settle();progress?.close();app.close();globalThis.location=previousLocation;restore()}
});
