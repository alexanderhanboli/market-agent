-- SEC acceptance metadata for filing sources (#199), kept apart from
-- publication proof. The SEC says acceptance may precede first availability on
-- sec.gov, so nothing reads this table to decide whether a fact was public at a
-- cutoff. Rows are append-only: a value that differs from one seen before for
-- the same accession is a new row that records the conflict.
create table sec_filing_acceptances (
  acceptance_id uuid primary key default gen_random_uuid(),
  source_id uuid not null references sources(source_id) on delete cascade,
  accession text not null check (accession ~ '^[0-9]{10}-[0-9]{2}-[0-9]{6}$'),
  -- The value exactly as the submissions feed gave it.
  raw_value text not null,
  -- Null while the feed's time zone is unestablished (sec-acceptance.ts), or
  -- when the value conflicts with another seen for the accession.
  parsed_at timestamptz,
  timing_precision text check (timing_precision in ('instant', 'date')),
  source_timezone text check (source_timezone is null or length(btrim(source_timezone)) > 0),
  evidence_ref text not null check (length(btrim(evidence_ref)) > 0),
  evidence_hash text not null check (evidence_hash ~ '^[0-9a-f]{64}$'),
  -- Every other value seen for this accession, in this feed or recorded before.
  conflicts jsonb not null default '[]'::jsonb check (jsonb_typeof(conflicts) = 'array'),
  -- The insert's own time, not its transaction's: a writer that waited on the
  -- filing's lock inserts after the one it waited for (sec-acceptance.ts).
  recorded_at timestamptz not null default clock_timestamp(),
  constraint sec_filing_acceptances_parsed check ((parsed_at is null) = (timing_precision is null) and (parsed_at is null) = (source_timezone is null)),
  constraint sec_filing_acceptances_conflicts check (jsonb_array_length(conflicts) = 0 or parsed_at is null)
);
create index sec_filing_acceptances_accession_idx on sec_filing_acceptances(accession, recorded_at desc);
create trigger sec_filing_acceptances_append_only
before update on sec_filing_acceptances
for each row execute function prevent_financial_record_update();
