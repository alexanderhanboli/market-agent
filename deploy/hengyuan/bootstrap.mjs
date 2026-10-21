import {ANALYZE_PLAYBOOKS} from '../../services/analyze/src/playbook.ts';
import {createAnalyzeTemplate} from '../../services/analyze/src/template-repo.ts';
// Provision real, owner-scoped templates. The frontend's demo template IDs are
// not durable records and cannot be used by the Analyze run API.
export async function ensureAnalyzeTemplates(db,userId){
 for(const playbook of ANALYZE_PLAYBOOKS){
  const existing=await db.query('select template_id from analyze_templates where user_id=$1 and name=$2 and deleted_at is null limit 1',[userId,playbook.name]);
  if(existing.rows.length)continue;
  await createAnalyzeTemplate(db,{user_id:userId,name:playbook.name,prompt_template:playbook.default_instructions,source_categories:playbook.default_source_categories});
 }
}
