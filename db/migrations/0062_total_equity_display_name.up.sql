-- total_equity stores us-gaap StockholdersEquity (parent equity). Certified
-- answers call it "Stockholders' equity"; the registry's display name joins
-- them. The seed inserts with "on conflict do nothing", so an existing
-- registry keeps the old name until this runs.
update metrics set display_name = 'Stockholders'' Equity'
 where metric_key = 'total_equity' and display_name = 'Total Equity';
