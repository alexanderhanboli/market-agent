-- A restated fact names the original it restates, and one filing restates a
-- period's metric once.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'facts_restated_supersedes') then
    alter table facts add constraint facts_restated_supersedes
      check (method <> 'restated' or supersedes is not null);
  end if;
end $$;
create unique index if not exists facts_active_restated_identity_idx
  on facts(subject_kind, subject_id, metric_id, period_kind, fiscal_year, fiscal_period, source_id)
  where method = 'restated'
    and invalidated_at is null
    and superseded_by is null;
