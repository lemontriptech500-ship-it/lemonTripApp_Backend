# Migration order notes (for review)



Checked on 2026-10-06 with read-only SELECT on production schema_migrations.



- 001 to 005: same names in my repo and production.

- 006: my repo has 006_shared_website_catalog_auth. Production has 006_visa_applications and 006_shared_catalog_reconciliation. Not sure if the second one replaces mine.

- 007: my repo has 007_notifications_profile. Production has 007_visa_s3_documents. Clash.

- 008: my repo has 008_google_account_sync. Production has 008_visa_submission_retries. Clash.

- 009: my repo has 009_password_reset. Not in production.



My files 007, 008, 009 are not applied on production. The tables notifications, device_tokens and password_reset_tokens are missing there.



Proposal, needs a decision from Manpreet: renumber mine after the production visa files (for example 009, 010, 011). I will not rename anything until it is approved.



My own runner uses the ledger table lemontrip_mobile_schema_migrations. Production uses schema_migrations. So my runner must not be used on production.


Update 7 Oct: renamed my files to 009_notifications_profile, 010_google_account_sync and 011_password_reset to avoid the clash with the production visa files. The list above shows the old names.
