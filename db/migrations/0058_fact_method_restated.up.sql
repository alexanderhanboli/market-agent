-- A later filing's changed value for an earlier period (#321). Its own method
-- keeps it out of every reader of as-reported facts (method = 'reported').
alter type fact_method add value if not exists 'restated';
