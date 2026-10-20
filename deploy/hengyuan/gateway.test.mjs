import test from 'node:test';import assert from 'node:assert/strict';
import {routeService,authorized,gateway} from './gateway.mjs';
import {createServer} from 'node:http';
import {readAuthenticatedUserId} from '../../services/shared/src/request-auth.ts';
test('API route boundaries and evidence inspector precedence',()=>{assert.equal(routeService('/v1/evidence/inspect/x'),'dev-api');assert.equal(routeService('/v1/chatty'),undefined);assert.equal(routeService('/v1/chat/threads'),'chat');assert.equal(authorized('Bearer correct','correct'),true);assert.equal(authorized('Bearer bad','correct'),false);});
test('gateway rejects anonymous and overwrites forged identity with signed owner',async()=>{
 let actual;const upstream=createServer((req,res)=>{actual=readAuthenticatedUserId(req,{mode:'trusted_proxy',trustedProxySecret:'test-secret'});res.setHeader('Content-Type','application/json');res.end('{}');});
 await new Promise(r=>upstream.listen(0,'127.0.0.1',r));const server=gateway({token:'test-token',secret:'test-secret',ports:{chat:upstream.address().port}});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{const base='http://127.0.0.1:'+server.address().port;assert.equal((await fetch(base+'/v1/chat/threads')).status,401);assert.equal((await fetch(base+'/v1/chat/threads',{headers:{Authorization:'Bearer test-token','x-user-id':'attacker','x-authenticated-user-id':'attacker'}})).status,200);assert.equal(actual,'00000000-0000-4000-8000-000000000001');}finally{server.closeAllConnections();upstream.closeAllConnections();await Promise.all([new Promise(r=>server.close(r)),new Promise(r=>upstream.close(r))]);}
});
