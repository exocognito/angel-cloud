-- Better Auth names a verification row after the token's own hash, so asking
-- "which links does this address have outstanding?" reads the address out of
-- the row's JSON. That is the question O4 clause 5 makes us ask on every
-- sign-in request, and without this it is a full scan of the table.
create index "verification_email_idx" on "verification" (json_extract("value", '$.email'));
