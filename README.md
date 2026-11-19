# Comfort Hands Home Healthcare: portals

- `Code.gs`: Google Apps Script backend (paste into the script; keep your own CONFIG values)
- `apply/`: public job application and new-hire page
- `portal/`: admissions and admin portal (with `hr-pdf/` I-9 and W-4 templates)
- `staff/`: aide portal
- `finance/`: owners-only finance portal (`index.html`), with `Code.gs` (Apps Script storage backend) and `SETUP.md` (Google setup steps). No data is stored in the repo
- `SETUP.md`: deployment steps
- `comfort_hands_onboarding.html`: single-file source of `portal/index.html`

Never commit real CONFIG values (SHARED_SECRET, PASSWORD_SALT, USERS, file IDs).
