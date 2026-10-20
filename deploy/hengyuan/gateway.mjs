import {createServer, request as httpRequest} from 'node:http';
import {timingSafeEqual} from 'node:crypto';
import {signTrustedUserId} from '../../services/shared/src/request-auth.ts';
export const OWNER='00000000-0000-4000-8000-000000000001';
export const routes=[['/v1/evidence/inspect','dev-api'],['/v1/subjects','resolver'],['/v1/chat','chat'],['/v1/run-activities','chat'],['/v1/analyze','dev-api'],['/v1/agents','dev-api'],['/v1/dev','dev-api'],['/v1/themes','dev-api'],['/v1/watchlists','watchlists'],['/v1/market','market'],['/v1/fundamentals','fundamentals'],['/v1/screener','screener'],['/v1/portfolios','portfolio'],['/v1/home','home'],['/v1/evidence','evidence'],['/v1/analyst-grids','analyst-grids']];
export function routeService(path){return routes.find(([p])=>path===p||path.startsWith(p+'/'))?.[1]}
export function authorized(actual,token){const a=Buffer.from(actual||''),b=Buffer.from('Bearer '+token);return !!token&&a.length===b.length&&timingSafeEqual(a,b)}
export function gateway({token,secret,ports}){return createServer((req,res)=>{
 const json=(status,data)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(data));};
 if(!authorized(req.headers.authorization,token))return json(401,{error:'Authentication required'});
 const path=new URL(req.url,'http://localhost').pathname;
 if(path==='/health')return json(200,{ok:true,mode:'live',frozen:false,modelConfigured:!!process.env.LITELLM_MODEL});
 const service=routeService(path);if(!service)return json(404,{error:'Unknown research API'});
 const headers={'x-authenticated-user-id':OWNER,'x-authenticated-user-signature':signTrustedUserId(OWNER,secret)};
 for(const key of ['content-type','accept','last-event-id','idempotency-key'])if(req.headers[key])headers[key]=req.headers[key];
 const upstream=httpRequest({hostname:'127.0.0.1',port:ports[service],path:req.url,method:req.method,headers},response=>{
  const out={'cache-control':'no-store'};for(const key of ['content-type','x-request-id'])if(response.headers[key])out[key]=response.headers[key];
  res.writeHead(response.statusCode,out);response.pipe(res);
 });
 upstream.on('error',()=>{if(!res.headersSent)json(503,{error:'Research service temporarily unavailable'});else res.end();});
 upstream.setTimeout(180000,()=>upstream.destroy());req.on('aborted',()=>upstream.destroy());res.on('close',()=>upstream.destroy());req.pipe(upstream);
});}
