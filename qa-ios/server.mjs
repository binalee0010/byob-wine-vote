import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createApp, client, TEST_PASSWORD } from '../tests/harness.mjs';

const { mf } = await createApp({ bindings: { SUPERADMIN_EMAIL: 'qa@example.test' } });
const owner = client(mf);
const login = await owner('/api/members/login', 'POST', { email: 'qa@example.test', password: TEST_PASSWORD });
assert.equal(login.status, 200);
const host = (path, method, body) => owner(path, method, body, { headers: { 'x-member-csrf': login.body.csrfToken } });
const poll = await host('/api/members/polls', 'POST', { title: 'iPhone drag check', requestId: crypto.randomUUID() });
assert.equal(poll.status, 201);
const root = '/v/' + poll.body.poll.slug, api = root + '/api';
const wines = [];
for (const name of ['Alpha', 'Bravo', 'Charlie']) {
  const r = await host(api+'/admin/candidates', 'POST', { name, revision: 0, requestId: crypto.randomUUID() });
  assert.equal(r.status, 200); wines.push(r.body.candidate);
}
assert.equal((await host(api+'/admin/settings','PATCH',{activities:[{id:'byob',revision:0,votingMethod:'custom',rankPoints:[3,2,1]}]})).status,200);
assert.equal((await host(api+'/admin/activities/byob/state','POST',{action:'open',revision:0})).status,200);
// Keep this single, isolated fixture session inside the local Worker so the simulator can use HTTP loopback.
const participant = client(mf);
const join = await participant(api+'/session','POST',{name:'Safari'});
assert.equal(join.status,200);
assert.equal((await participant(api+'/activities/byob/answer','PUT',{ranking:wines.map(w=>w.id),revision:0,expectedParticipantId:join.body.participant.id})).status,200);
const dist = new URL('../dist/', import.meta.url);
createServer(async (req, res) => {
  try {
    const path = new URL(req.url, 'http://localhost').pathname;
    res.setHeader('Cache-Control', 'no-store');
    if (path === '/start') {res.writeHead(302, {Location: root}); return res.end();}
    if (path === '/ready') return res.end('ready');
    if (path === '/proof') {
      const {body} = await host(api+'/admin/state');
      res.setHeader('content-type','application/json');
      return res.end(JSON.stringify({ submitted:body.submittedCount, points:Object.fromEntries(body.byobResults.map(w=>[w.name,w.points])) }));
    }
    if (path.startsWith(api+'/')) {
      let raw=''; for await (const data of req) raw+=data;
      const r = await participant(path, req.method, raw?JSON.parse(raw):undefined);
      res.writeHead(r.status, {'content-type':'application/json'}); return res.end(JSON.stringify(r.body));
    }
    const file = path === '/startup.js' || /^\/assets\/[-.\w]+$/.test(path) ? path.slice(1) : 'index.html';
    res.setHeader('content-type',file.endsWith('.html')?'text/html; charset=utf-8':file.endsWith('.css')?'text/css':'text/javascript');
    res.end(await readFile(new URL(file,dist)));
  } catch (e) { console.error(e); res.writeHead(500); res.end('fixture error'); }
}).listen(8765,'127.0.0.1',()=>console.log('Isolated vote ready.'));
