-- Operating cash flow is certified only from the total
-- NetCashProvidedByUsedInOperatingActivities, the scope capex covers. SEC
-- ingestion recorded financial contexts for OCF facts mapped from
-- NetCashProvidedByUsedInOperatingActivitiesContinuingOperations, which leaves
-- out discontinued operations; without a context such a fact stays a named gap
-- instead of certifying as OCF.
delete from fact_financial_contexts c
 using facts f, metrics m
 where c.fact_id = f.fact_id
   and m.metric_id = f.metric_id
   and m.metric_key = 'operating_cash_flow'
   and c.context_version = 'sec_companyfacts_context.v1'
   and c.source_context_ref not like '%#NetCashProvidedByUsedInOperatingActivities|%';
