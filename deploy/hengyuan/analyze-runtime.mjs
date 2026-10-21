import {createRequire} from 'node:module';
import {analystToolRuntime, sealResearchBlocks} from '../../services/chat/src/local-runtime.ts';
import {createThread} from '../../services/chat/src/threads-repo.ts';
import {createChatSseSequencer} from '../../services/chat/src/sse.ts';
import {chooseBundleIdForSubjectKind} from '../../services/chat/src/bundle-routing.ts';
import {hydrateSubjectRef} from '../../services/resolver/src/flow.ts';
export * from '../../services/dev-api/src/local-runtime.ts';

const {Pool}=createRequire(new URL('../../db/package.json',import.meta.url))('pg');
let database;
const db=()=>database??=new Pool({connectionString:process.env.DATABASE_URL});

// Reuse the real analyst, source bindings and inference judge, rather than the
// development adapter's concatenated prompt placeholder. The private thread
// provides durable ownership for tool-call logs and stays out of the chat list.
export async function runAnalyzeWorkflow(input){
 if (!input.subjectRefs.length) throw new Error("Select a research subject before generating a memo");
 const thread=await createThread(db(),input.userId,{title:input.playbookName??input.template.name,primary_subject_ref:input.subjectRefs[0]});
 await db().query('update chat_threads set archived_at=now() where thread_id=$1',[thread.thread_id]);
 const subjects=await Promise.all(input.subjectRefs.map(async ref=>{
  const handoff=await hydrateSubjectRef(db(),ref);
  return {status:'resolved',input_text:handoff.display_label,...handoff,handoff};
 }));
 const context={threadId:thread.thread_id,runId:crypto.randomUUID(),userId:input.userId};
 const sequencer=createChatSseSequencer(context);
 const result=await analystToolRuntime({...context,
  userIntent:input.playbookPrompt??input.instructions,
  subjectText:subjects.map(s=>s.display_label).join(', '),
  subjectPreResolution:subjects[0],subjectPreResolutions:subjects,
  bundleId:chooseBundleIdForSubjectKind(subjects[0]?.subject_ref.kind),
  emit:(type,payload)=>sequencer.next(type,payload),
 });
 if (!result.answered_by) throw new Error('Analyze requires a configured model response');
 const judged=result.judging?await result.judging.done:result;
 if (judged.blocks.some(block=>Array.isArray(block.segments)&&block.segments.some(segment=>segment.text==='No written answer is available for this question; try asking again.'))){
  throw new Error('The model did not produce a complete verified answer; retry the analysis');
 }
 return {blocks:judged.blocks.map(block=>({...block,snapshot_id:input.snapshotId}))};
}

export async function buildAnalyzeRunSeals(input){
 return {blocks:input.memoBlocks,sealSnapshot:()=>sealResearchBlocks({
  snapshotId:input.snapshotId,userId:input.userId,blocks:input.memoBlocks,
 })};
}

export async function sealAnalyzeSnapshot(input){
 return sealResearchBlocks({snapshotId:input.snapshotId,userId:input.userId,blocks:input.blocks});
}
