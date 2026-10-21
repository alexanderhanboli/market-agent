import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {appendFileSync,mkdirSync,existsSync,readFileSync} from 'node:fs';
import {parseEnv} from 'node:util';
import {fileURLToPath} from 'node:url';
import {gateway,OWNER} from './gateway.mjs';
import {ensureAnalyzeTemplates} from './bootstrap.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
process.loadEnvFile(root+'.env.dev');
const providerFile=root+'.env.providers';
if(existsSync(providerFile))Object.assign(process.env,parseEnv(readFileSync(providerFile,'utf8')));
const env={...process.env,DATABASE_URL:`postgresql://${process.env.DEV_POSTGRES_USER}:${process.env.DEV_POSTGRES_PASSWORD}@127.0.0.1:${process.env.DEV_POSTGRES_PORT}/${process.env.DEV_POSTGRES_DB}`,MA_AUTH_MODE:'trusted_proxy',MA_FLAG_PLACEHOLDER_API:'false',DISCOVERY_ENABLED:'false',FINANCIAL_WORKER_ENABLED:'false',LLM_SETTINGS_ENV_FILE:providerFile,DEV_API_RUNTIME_MODULE:root+'deploy/hengyuan/analyze-runtime.mjs',BLOB_STORE_BACKEND:'memory'};
const ports={chat:14310,resolver:14311,'dev-api':14312,watchlists:14313,market:14321,fundamentals:14322,screener:14323,portfolio:14333,home:14334,evidence:14335,'dev-providers':14336,'analyst-grids':18093};
for(const [name,port]of Object.entries(ports)){const key=name.replaceAll('-','_').toUpperCase();env[key+'_PORT']=String(port);env[key+'_ORIGIN']='http://127.0.0.1:'+port;}
env.DEV_PROVIDERS_BASE_URL=env.DEV_PROVIDERS_ORIGIN;
mkdirSync(root+'.dev/logs',{recursive:true});let stopping=false;const children=new Set();
function launch(name,cmd,args,cwd){
 const child=spawn(cmd,args,{cwd,env,stdio:['ignore','pipe','pipe']});children.add(child);
 for(const stream of [child.stdout,child.stderr])stream.on('data',data=>appendFileSync(root+'.dev/logs/'+name+'.log',data));
 child.on('exit',code=>{children.delete(child);if(!stopping){console.error(name+' exited '+code+'; restarting in 10 seconds');setTimeout(()=>launch(name,cmd,args,cwd),10000);}});
}
for(const name of Object.keys(ports)){
 if(name==='dev-providers'){launch(name,root+'.venv/bin/python',['-m','uvicorn','dev_providers.main:app','--host','127.0.0.1','--port',String(ports[name])],root+'services/dev-providers');continue;}
 launch(name,process.execPath,['--experimental-strip-types','src/dev.ts'],root+'services/'+name);
}
const {Pool}=createRequire(root+'db/package.json')('pg');
const statusPool=new Pool({connectionString:env.DATABASE_URL,max:1});
await ensureAnalyzeTemplates(statusPool,OWNER);
const status=async()=>{
 const values=existsSync(providerFile)?parseEnv(readFileSync(providerFile,'utf8')):{};
 const {rows}=await statusPool.query("select as_of_date::text as as_of from artifact_ingestion_ledger where market='US' and status <> 'failed' order by finished_at desc limit 1");
 return {modelConfigured:!!values.LLM_DEEPSEEK_API_KEY?.trim(),polygonConfigured:!!values.POLYGON_API_KEY?.trim(),referenceAsOf:rows[0]?.as_of??null};
};
const server=gateway({token:env.HENGYUAN_BRIDGE_TOKEN,secret:env.MA_AUTH_PROXY_SECRET,ports,status});server.listen(14300,'127.0.0.1',()=>console.log('Authenticated research gateway listening on loopback:14300'));
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{stopping=true;server.close();for(const child of children)child.kill('SIGTERM');setTimeout(()=>process.exit(),1000);});
