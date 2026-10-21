import test from 'node:test';import assert from 'node:assert/strict';
import {enrichMissingCik} from '../src/enrich-cik.ts';
import type {QueryExecutor} from '../src/lookup.ts';
import type {DiscoveredListing} from '../src/discovery.ts';
const row={ticker:'AAPL',mic:'XNAS',cik:'0000320193'} as DiscoveredListing;
const input={issuerId:'33333333-3333-4333-a333-333333333333',ticker:'AAPL',mic:'XNAS'};
test('fills only a missing CIK from one exact ticker and venue identity',async()=>{
 let args:unknown[]|undefined;const db={query:async(sql:string,values:unknown[])=>{args=values;assert.match(sql,/cik is null/);assert.match(sql,/not exists/);return {rows:[{issuer_id:input.issuerId}]}}} as QueryExecutor;
 assert.equal(await enrichMissingCik(db,input,{discoverTicker:async()=>[row,{...row,ticker:'OTHER',cik:'123'}]}),true);assert.deepEqual(args,[input.issuerId,'320193']);
});
test('preserves existing identity and rejects ambiguous or wrong-venue references',async()=>{
 const db={query:async()=>{throw Error('must not write')}} as unknown as QueryExecutor;
 assert.equal(await enrichMissingCik(db,{...input,cik:'320193'},{discoverTicker:async()=>{throw Error('must not fetch')}}),false);
 assert.equal(await enrichMissingCik(db,input,{discoverTicker:async()=>[row,{...row,cik:'123'}]}),false);
 assert.equal(await enrichMissingCik(db,input,{discoverTicker:async()=>[{...row,mic:'XNYS'}]}),false);
});
