-- A balance is certified only from a 10-K. The statement contract labels every
-- balance FY of its fiscal year, so SEC ingestion stored a 10-Q balance as
-- "FY" at the quarter's end and certified it as the year's closing balance.
-- No table stores the form. A 10-Q balance is a point fact whose filing source
-- holds a first-to-third-quarter fact ending the same day and no fiscal-year
-- fact. A 10-K's source can hold a derived fourth quarter without its year (a
-- fourth-quarter ingest), but never an earlier quarter, and no earlier quarter
-- ends on the year's last day. A restatement cloned from such a balance loses
-- its context too.
with quarter_balances as (
  select p.fact_id
    from facts p
   where p.period_kind = 'point'
     and p.method = 'reported'
     and exists (
       select 1 from facts q
        where q.source_id = p.source_id and q.subject_id = p.subject_id
          and q.period_kind = 'fiscal_q' and q.fiscal_period in ('Q1', 'Q2', 'Q3')
          and q.period_end = p.period_end)
     and not exists (
       select 1 from facts y
        where y.source_id = p.source_id and y.subject_id = p.subject_id and y.period_kind = 'fiscal_y')
)
delete from fact_financial_contexts c
 using facts f
 where c.fact_id = f.fact_id
   and c.context_version = 'sec_companyfacts_context.v1'
   and (f.fact_id in (select fact_id from quarter_balances)
        or (f.method = 'restated' and f.supersedes in (select fact_id from quarter_balances)));
