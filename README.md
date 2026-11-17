# Comfort Hands Home Healthcare: portals

- `Code.gs`: Google Apps Script backend (paste into the script; keep your own CONFIG values)
- `apply/`: public job application and new-hire page
- `portal/`: admissions and admin portal (with `hr-pdf/` I-9 and W-4 templates)
- `staff/`: aide portal
- `SETUP.md`: deployment steps
- `comfort_hands_onboarding.html`: single-file source of `portal/index.html`

Never commit real CONFIG values (SHARED_SECRET, PASSWORD_SALT, USERS, file IDs).
