-- Capex v1 is cash paid for PP&E (PaymentsToAcquirePropertyPlantAndEquipment).
-- SEC ingestion briefly recorded financial contexts for capex facts mapped from
-- PaymentsToAcquireProductiveAssets, which adds purchased intangibles; without
-- a context such a fact stays a named gap instead of certifying as capex.
delete from fact_financial_contexts c
 using facts f, metrics m
 where c.fact_id = f.fact_id
   and m.metric_id = f.metric_id
   and m.metric_key = 'capex'
   and c.context_version = 'sec_companyfacts_context.v1'
   and c.source_context_ref not like '%#PaymentsToAcquirePropertyPlantAndEquipment|%';
