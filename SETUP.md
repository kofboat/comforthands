# Connecting the portal to Google Drive + email

When the patient taps Submit, the portal sends the signed packet to a small Google Apps Script that
(1) builds a PDF, (2) saves it in Drive as `<root folder>/<Last, First>/Admission - Last, First - date.pdf`,
and (3) emails the PDF to the office.

1. In Google Drive, create the folder where admissions should be filed (e.g. "Comfort Hands Admissions").
   Copy its ID from the URL: `drive.google.com/drive/folders/<THIS-PART>`.
2. Go to script.google.com → New project → paste the contents of `Code.gs`.
3. Edit CONFIG at the top: `DRIVE_FOLDER_ID`, `OFFICE_EMAIL`, and long random values for `SHARED_SECRET` and `PASSWORD_SALT` (see Staff sign-in below).
4. Deploy → New deployment → type **Web app** → Execute as **Me** → Who has access **Anyone** → Deploy.
   Approve the Drive and Gmail permissions when asked. Copy the Web app URL (ends in `/exec`).
5. In `comfort_hands_onboarding.html`, near the top of the script, set:
   `const SUBMIT_URL='<your web app URL>';` (there is no secret in the HTML any more).
6. Open the portal, run a test admission, and check the Drive folder and the office inbox.

Notes
- The script runs under your Google account, so the PDF lands in your Drive and the email goes from your Gmail.
- "Anyone" access plus a secret in the HTML is only light protection (anyone with the HTML can read the secret).
  It's fine for testing; before real patients, host the portal behind a login and use a HIPAA-eligible Google
  Workspace account with a signed BAA.
- If a send can't be confirmed, the portal shows a Resend button. Check Drive first to avoid duplicates.
- "＋ New Patient" in the header clears saved data from that browser to start the next admission.

Pre-visit copy
- The admin "Patient Copy" step emails the patient a PDF of the Consents & Rights and Service Agreement through the
  same script (and files a copy in the patient's Drive folder). Re-deploy the web app (Deploy → Manage deployments →
  Edit → New version) after pasting the updated Code.gs.

Extra PDF attachments (NJ Advance Directive + NJ Consumer's Guide to HHA Services)
- Upload both PDFs to Google Drive (outside the patient folders).
- Copy each file ID from its link (`drive.google.com/file/d/<THIS-PART>/view`) and paste them into the two
  `EXTRA_ATTACHMENTS` entries in Code.gs, then redeploy (new version).
- Both are attached to every pre-visit email next to the Consents & Service Agreement PDF.

Welcome letter attachment
- Upload `Welcome_Letter_Comfort_Hands.pdf` to Google Drive, copy its file ID, and paste it into
  `WELCOME_LETTER_FILE_ID` in Code.gs, then redeploy (new version).
- It is attached to the welcome email together with the signed Service Agreement. If the ID is left blank, only the
  signed agreement is attached.

Staff sign-in
- The portal opens on a sign-in screen. The script checks the email and password and returns a 12-hour session; every send needs it.
- For each person: put their email and a password in `makeHash()` (bottom of the sign-in block in Code.gs), select `makeHash`, Run, and copy the
  hash from the Execution log. Then add `{ email, name, hash, roles }` to `CONFIG.USERS`. Roles: `admin`, `nurse`, `patient`. The nurse needs `patient`
  too, because the patient signs on the nurse's phone.
- Do not leave real passwords in the script afterwards. Change the `makeHash()` text back to a placeholder.
- 5 wrong passwords lock that email for 15 minutes. The portal signs out after 15 minutes of inactivity (entries stay on the device until "New Patient").
- Redeploy as a new version after editing Code.gs. Run `testSend` after adding a user.

Faxing the physician order (MetroFax)
- The Physician Order step has a "Send via MetroFax" button. The script emails the order as a PDF to `<fax number>@metrofax.com`, saves a copy in the patient's Drive folder, and emails the office a confirmation.
- In your MetroFax account, make sure the Google account that runs the script (the one that owns the web app) is an allowed sending address.
- Redeploy the web app as a new version after pasting the updated Code.gs. Send one test fax to your own number first.
- The fax cover page uses the email subject and body, which contain no patient details.

Employee portal and weekly aide activity sheets
- Upload `staff/index.html` to a `staff` folder next to your `portal` folder (site address: yourdomain.com/staff/). Replace `portal/index.html` too.
- Paste the new Code.gs (keep your CONFIG and USERS) and deploy a new version. The first time, Google asks you to approve new permissions
  (Sheets, triggers). Approve them. The script then creates a restricted Google Sheet, "Comfort Hands Activity Sheets", in your admissions
  Drive folder. Do not share that Sheet; it holds patient data.
- Project Settings (gear icon) → Time zone: set America/New_York so 8 pm means 8 pm Eastern.
- Run `installReminder` once from the editor (run it again after updating Code.gs). It sets two reminders: Fridays at 9 am and Sundays at 6 pm, sent only to assigned aides who still have an unsubmitted sheet. Aides get a text; if texting is off, the aide has no phone number or opted out, or the text fails, they get an email instead. The Sunday run also emails the office the list of unsubmitted sheets.

- **Notifications tab (broadcast texts to aides).** Columns: Text, Status, Started, Sends, Time. Write the message in Text and set Status to `active`. Run `installTextReminders` once after updating Code.gs; it adds an hourly check. An active row is texted to every active aide who has a phone number and has not opted out, on days 1, 3, 5 and 7 (4 texts), then the Status changes to `done`. Time (e.g. `9:00 AM`) is optional: rows without one get 9 am, 12 pm and 4 pm in row order, and times are kept between 8 am and 8 pm. Set `inactive` to stop a row; setting `active` again starts a fresh run. Started and Sends are filled in by the script. Every text, including "Comfort Hands:" and "Reply STOP to opt out.", must be 300 characters or less, otherwise the row is held with Status `too long`. While texting is off, only dry-run entries are recorded in TextLog.
- **Motivation tab.** Two columns, `Clock in` and `Clock out`, one line per row. The clock-in and clock-out texts get one line each day (the same for every aide, moving down the list and starting over at the end), then "Automated message. Questions? Call 609-277-3032." If a text would pass 300 characters, the motivational line is dropped first, then the automated line. `installTextReminders` creates the tab with a few starter lines if it is missing; paste your own list over it.
- Add each aide to `CONFIG.USERS` with `roles: ['aide']` (same makeHash steps as staff). Aides can only open the employee portal; the script refuses everything else.
- Nurse: on the Activity Sheet step, enter the assigned aide email(s) and press "Publish to aides". Press it again after any care plan change.
- Aides sign in at /staff/, pick the client, fill in each day, then have the client sign and press Submit. The signed PDF is filed in the patient's Drive folder
  and emailed to the office. Submitted sheets are locked.

Accounts and password reset
- Accounts now live in a "Users" tab of the activity Google Sheet (columns: email, name, hash, roles, active, updatedAt). Accounts in `CONFIG.USERS` still work as a
  starting list; a Users-tab row for the same email takes priority.
- To add someone: add a row with their email, name, roles (`aide`, `nurse`, `admin`, `patient`, comma-separated) and active = TRUE. Leave `hash` blank.
  Tell them to open the sign-in page and choose "Forgot password, or signing in for the first time?". They get a 6-digit code by email (valid 15 minutes),
  choose a password (at least 10 characters) and are signed in. No code edits or redeploys.
- To remove someone: set active to FALSE. Their sessions stop working immediately.
- Forgot password: the person uses the same link. Codes allow 5 tries; requests are limited to one per minute and five per hour per email.
  The reply is the same whether or not the email is on file.
- Aides can also change their password from the employee portal home page ("Change my password").
- After pasting the new Code.gs and redeploying, Google asks you to approve the new permissions again. The Users tab is created the first time someone signs in.

## Staff Home: patients, 60-day progress notes, discharge, aide evaluations

After you paste the new `Code.gs` and **deploy a new version** (Deploy → Manage deployments → Edit → New version), do this once:

1. In the Apps Script editor choose `installDueReminders` and press Run (approve the permissions). It installs a Monday 8 am digest email of due and overdue items, and a daily 3 am purge.
2. Upload the new `portal/index.html`. Sign in as admin or nurse and you land on **Staff Home**.

What is stored where
- The Google Sheet gets three new tabs, created automatically: **Patients** (each admission, saved as you type), **Reports** (history of filed notes, discharges and evaluations) and **AideRecords** (first-case date and last evaluation per aide).
- Social Security numbers and signatures are never sent to the Sheet. They stay on the device that entered them.
- Filed PDFs go to the patient's Drive folder, or to a `Staff - <aide name>` folder for aide evaluations, and are emailed to the office.
- 30 days after a discharge, the saved admission data for that patient is erased from the Sheet. The PDFs in Drive are kept.

Due dates
- Patient progress note: 60 days after start of care, then 60 days after each filed note.
- Aide evaluation (new CHHA Performance Evaluation form): 60 days after the aide's first case, then 90 days after the first case, then every 365 days. An aide appears once they have worked a published sheet.
- The Monday email lists names only. It says whether each is due within 10 days or overdue.

Drafts
- Every report has a **Save draft** button. It also saves by itself about 12 seconds after you stop typing, and when you press Close.
- Drafts live in a **Drafts** tab on the Sheet. Any admin or nurse can open and finish one. Signatures are never saved in a draft, so they are added again at filing.
- A draft does not reset any due date or close a patient. Filing the signed report does, and removes the draft.
- Drafts show as a tile on Staff Home and as a "Draft" tag on the patient. The Monday email lists drafts older than 3 days (names only).

Aides appear in the Aides tab when their row in the Users tab includes the `aide` role.

## Admin tasks: new aide onboarding, Homebase and HHAeXchange links

Admin users get an **Admin tasks** tab on Staff Home (nurse-only users do not see it).

- **Homebase and HHAeXchange** are buttons that open the sites in a new tab. Nothing is tracked or stored about payroll processing or data entry. To change a link, edit `ADMIN_LINKS` near the end of `portal/index.html`.
- **New aide onboarding** is a checklist per applicant: application review, onboarding forms sent, license verification, reference check, background check, Homebase signup, HHAeXchange signup, and employee-portal login created. Each step records the date, who did it, and a short note. When every step is done the applicant is marked Hired. The dashboard tile "New hires onboarding" counts applicants still in progress.
- The application itself stays on your website. Add the applicant here when it arrives.
- **Send onboarding forms** emails the forms to the applicant once "Application review" is marked complete. Set up the forms once in `Code.gs`: upload each form to Drive, then in CONFIG fill in `ONBOARDING_FORMS` with its file ID and name (any file type is fine), for example `{ id: 'FILE_ID', name: 'W-4.pdf' }`. Add these keys to your own CONFIG when you paste the new `Code.gs`: `ONBOARDING_FORMS`, and optionally `ONBOARDING_NOTE` (extra line in the email) and `STAFF_PORTAL_URL` (included in the login email).
- **Create aide login** adds the person to the Users tab with the `aide` role and emails them to use "Forgot password" in the employee portal to choose their own password. You never handle a password.
- Do not enter Social Security numbers or background check results in the notes. Keep the results themselves in your background check vendor's system.
- The Monday digest email also lists applicants who have been onboarding for more than a week (names and step counts only).

## Hardening update (after the code review)

Install in this order:
1. Paste the new `Code.gs`, keeping your own CONFIG values, and deploy a **new version**.
2. In the Apps Script editor run **`upgrade`** once and read the Execution log. It prepares the tabs, strengthens stored passwords, moves the Google Sheet out of the shared admissions folder into your own My Drive, turns off link sharing, and lists anyone who still has direct access to the Sheet.
3. Remove from the Sheet anyone on that list who does not need it (open the Sheet, Share). Anyone who can edit the Sheet can create an admin login.
4. Upload the new `portal/index.html` and `staff/index.html`.

Everyone signs in once more after the update. Passwords do not change.

What changed
- **No silent overwrites.** Each patient record has a version number. A save from an out-of-date screen is refused and the nurse is offered the latest copy.
- **Purge erases everything on the Sheet for that patient** 30 days after the discharge is *filed*: admission data, text kept with filed reports, drafts, the care plan and the aides' weekly sheets. Kept: the PDFs in Drive, and the patient's name, date of birth and dates as an index. The Audit tab also keeps its entries. Google's own version history of the Sheet cannot be erased by the script.
- **Refuses to run with placeholder secrets** (`SHARED_SECRET`, `PASSWORD_SALT`).
- **Large admissions** are stored across three cells (about 135,000 characters).
- **Discharged patients** cannot be republished or written to. An admin can **Reopen** a mistaken discharge until it is purged. **Mark active** finishes an admission whose packet was signed on paper.
- **Faster dashboard**, and saving no longer waits behind PDF creation.
- **Duplicates:** the same request sent twice within 10 minutes is filed once. To resend an identical fax, wait 10 minutes.
- **One Drive folder per patient**, remembered by ID. Two patients with the same name get separate folders.
- **Aide hours stay with the aide** even when the office corrects a time.
- **Passwords** are stored in a slower-to-guess form, and changing a password ends older sessions.
- **Audit tab** records who signed in, opened a patient, filed, faxed or changed something, and any errors. It is never trimmed.
- Dates are validated, typed text can never become a spreadsheet formula, signatures must be real images, and page content is cleaned before it becomes a PDF.

Good practice that the code cannot do for you
- Keep a copy of each `Code.gs` you deploy (date in the file name), so you can go back.
- Try a new version with a test login before staff use it.


## Hiring workflow: Apply page, provisional offer, new-hire forms

How it works
1. The applicant fills in the **Apply page** (`apply/index.html`). It has the same questions as your Careers page, including the Social Security number, residency status and criminal-conviction questions (unchanged). The office gets an email and the application PDF is filed to a restricted HR folder in Drive. The applicant gets a confirmation email.
2. In **Admin tasks > New aide onboarding**, open the applicant, review the answers, tick "Application review", then press **Approve and send offer**. The applicant is emailed a provisional offer (employment is subject to a positive background and reference check) with the employment contract attached and a personal link. The contract is built for each applicant as a PDF from the position on their application, with their name and the right rate ($18.00 for Certified Home Health Aide and PCA, $17.00 for Companion), biweekly payroll. No contract file or file ID is needed. A position with no rate (for example RN) blocks the offer until you choose one. To change rates or wording, edit `rateFor_` and `contractPdf_` in Code.gs.
3. The applicant opens the link, gets a 6-digit code by email, and sees their list: forms to sign on screen (the Provisional Employment Agreement, with the start date entered by the applicant; Agreement of Standards; the job description for their position; the four background forms; Criminal History Attestation; one combined Policy and Procedure Guide acknowledgment; reference release), the signed contract to upload, and ID uploads (Social Security card, I-9 List A, or List B plus List C chosen from drop-downs, physical exam). Name, address, phone, email and date of birth are already filled in. Signed forms are filed as PDFs; uploads go to the restricted HR folder.
4. The applicant completes and signs **Form W-4 on screen** on the same page (Social Security number, filing status, Steps 2 to 4, signature). It is stamped onto the official 2026 form, saved as a PDF in their restricted HR folder, and the W-4 step ticks itself. Upload `portal/hr-pdf/w4.pdf`, `pdf-lib.min.js` and `hrfill.js` next to `portal/index.html`, since the Apply page loads them from `../portal/hr-pdf/`. Creating the aide login does not depend on any form being done. You tick the remaining steps (I-9 completed with the office, license, references, background, physical, in-service, competency, Homebase, HHAeXchange), then press **Create aide login**.

One-time setup
1. Paste the new `Code.gs`, keeping your own CONFIG values. Add these keys: `APPLY_URL` (the address where you put the Apply page), `FCRA_SUMMARY_URL` (link to the Fair Credit Reporting Act rights summary; your screening company can give you theirs, or use https://files.consumerfinance.gov/f/201504_cfpb_summary_your-rights-under-fcra.pdf).
2. Run `upgrade` once from the editor. It creates the restricted HR folder and adds the new Onboarding columns. Then **Deploy > Manage deployments > edit > New version**.
3. Upload `apply/index.html` to your site in a folder named `apply` (so the address is for example https://comforthands.net/apply/). The Apply page already points at your script address. Check it is the same one used by the portal.
4. The Apply page already carries your exact consent, background-check and EEO wording and is live (`DRAFT=false`). Replace the SMS consent wording if your text provider requires specific language.
5. Point your Careers page button at the new Apply page when you are ready. Test with your own email first.

Notes
- The background step has four separate forms, each signed on its own because the screening company (C3 Intelligence) requires each to be a standalone document: Disclosure of Background Investigation, Notices Rights and Acknowledgments, Authorization for Background Investigation, and the New Jersey notice. The step completes when all four are signed. The Authorization collects SSN, date of birth and driver's license; these appear only in the signed PDF.
- The Criminal History Attestation has seven Yes/No questions. The Policy Acknowledgments form combines the Code of Conduct, HIPAA/confidentiality, abuse and neglect, infection prevention, emergency preparedness, agency policy and the Policy Guide under one signature.
- Each signed form is filed as its own PDF in the applicant's restricted HR folder.
- **PCA authorizations** (Horizon NJ Health, UnitedHealthcare, Aetna, Wellpoint, HealthPartners): press **PCA** beside a patient (works from the first day of the admission). **New request** fills the insurer's own PDF from the patient record and the agency details, and logs the request as sent (untick the box if you only want the PDF). The agency NPI, Provider ID, TIN, PROMISe ID and contact are typed once and remembered in that browser. Fax the PDF. When the insurer answers, press **Record insurer answer** and enter the approval date, authorization number, total units approved, start and end dates and ICD-10 code(s), or mark it denied. The patient row then shows the authorization end date, the home screen has a tile for **authorizations ending in 45 days**, and the Monday digest lists renewals that are due and not yet sent, requests with no answer after 14 days, and active patients with no authorization on file. Press **Renewal request** to start the next one: it is pre-filled from the current approval and shows as "renewal sent" until the new approval is recorded. The data lives in a **PcaAuth** tab (created automatically; authorization numbers and dates only) and is erased with the patient 30 days after a filed discharge. Needs the new Code.gs deployed. Upload the whole `portal/hr-pdf/` folder, including `pcafill.js` and the `pca/` sub-folder (five PDFs). The agency NPI, TIN and each insurer's provider ID live in `CONFIG.AGENCY` in the script (not in the web page); the portal receives them only after sign-in. Aetna's form takes no provider ID, and the PROMISe ID is blank.
- **Printed application packet** (for applicants without internet): in Admin tasks press **Print application packet**. Pick which job description to include (both, Companion only, or CHHA/PCA only) in the drop-down beside it. A new window opens with a cover page and 16 sections, one per page break, each with a repeating section heading, and the print dialog appears. The W-4 and I-9 pages are images, `portal/hr-pdf/w4.jpg` and `i9.jpg`, so upload those two files too. Allow pop-ups for the site. `Aide_Application_Packet_preview.pdf` shows the layout.
- The Social Security number is stored only inside the application PDF and the background form PDF, never in the Sheet or the portal.
- The job description step shows the Companion description for Companion, or the CHHA description for Certified Home Health Aide, Live-In CHHA and PCA. Other positions skip it until you provide a description.
- Reference answers are entered by the office; the applicant only signs the release.
- Aide evaluations are due 60 days after the first case, then 90 days, then yearly.
- Links expire sign-in after two hours; a new code is needed each visit. Codes can only be requested once an offer has been sent.

## Prefilled I-9 and W-4

- Upload the folder `portal/hr-pdf/` (it holds `i9.pdf`, `w4.pdf`, `pdf-lib.min.js` and `hrfill.js`) next to `portal/index.html`.
- In Admin tasks, open an applicant and press **Prefilled I-9 and W-4**. Two PDFs download. They are built in your browser from the application answers; nothing is uploaded or stored.
- I-9 Section 1 gets name, address, date of birth, email, phone and the citizenship or work-status box from the application. Section 2 gets the agency name and address. The Social Security number, employee signature and date, your review, and first day of employment are left blank.
- W-4 gets first name, last name, address, city, state and ZIP. The Social Security number, filing status and signature are left blank.
- To use an updated government form later, replace `i9.pdf` or `w4.pdf` with the new file. The I-9 must keep the same field names; the W-4 text is placed by position, so check it after replacing.

## Reference checks

In Admin tasks, open an applicant. The **Reference checks** section lists each former employer from the application, plus one additional slot. Call the employer, press **Record**, fill in the form (ratings, comments, strengths, weaknesses, would rehire, who gave it), and **Save and file**. A PDF goes to the applicant's HR folder. The "Reference check" step ticks when two are recorded. The applicant's signed reference release is the authorization on file.

## Aide compliance trackers

Press **Compliance** beside an aide (Aides tab). Admins and nurses can edit. Only dates are stored; nothing is uploaded.

- **CHHA certification** (CHHA positions only): enter the expiration date. 60 days before it is the earliest renewal date, so it shows "renew window" from then and turns red once expired.
- **Background check** and **Physical exam**: enter the date last completed. The next is due 12 months later.
- **Annual CEU training**: all assigned training is due 11 months after the hire date, then each anniversary. Press **Mark completed** (uses the date in the box, or today) or **Mark not completed**.
- Everything is flagged yellow 60 days before it is due and red when overdue. The home screen has two tiles (overdue, due in 60 days), and the Monday digest lists every item.
- **Position, hire date, mobile phone and "agreed to text messages"** are on the same screen. New hires get these automatically when you press **Create aide login** (hire date = that day, SMS consent from the application).
- **Existing aides, one time:** in the script editor run `importAides` once to create the **AideImport** tab, fill one aide per row (email, position, hireDate, certExpiry, bgLast, physLast, ceuDoneAt, phone, smsOk; dates yyyy-mm-dd; position exactly as in the drop-down, e.g. `Certified Home Health Aide`), then run `importAides` again. The aide must already have a login. Re-running updates rows and never duplicates.

## Shift reminder texts

1. Run `upgrade` once. It creates the **Schedule** tab (empty), with drop-downs and notes in the header row, and a **TextLog** tab.
2. The office fills **Schedule**, **one row per aide per patient** (an aide with two clients is two rows; two shifts on the same day for the same patient are two rows). Columns: **aideEmail**, **aideName** (fills itself, do not type), **patient** (office reference only, never sent), then **Mon start, Mon finish … Sun start, Sun finish** (`9:00 AM` or `14:30`; leave a day blank for no shift; a finish earlier than the start is an overnight shift; a start without a finish is flagged), **active** (blank or `yes` sends, `no` pauses), **skip** (one-off dates with no shift for the whole row, `2026-12-25, 12/31/2026`). An older Schedule tab with the "days" column is converted automatically by `upgrade`.
3. Each aide gets a text 15 minutes before the shift starts and one at shift end. Texts never contain a patient name or address, include the clock-in link and "Reply STOP to opt out".
4. Shift reminders are always sent at the shift time, including nights. Compliance texts are never sent between 9 pm and 6 am.
5. Rows the script cannot use (unknown aide, bad day or time, no phone, no text consent) are emailed to the office once a day. Run `checkSchedule` any time to see them in the log, and `shiftPreview` to see today's reminders without sending.
6. The portal cannot see Homebase or HHAeXchange clock events, so everyone scheduled gets the reminder whether or not they already clocked in.

## Text messages (Twilio), last step

Until you switch it on, **nothing is sent**: every text that would go out is only recorded in the **TextLog** tab as `dry-run` (last 4 digits of the number and a status; never the message).

1. In the script's `CONFIG.SMS` fill in `TWILIO_SID`, `TWILIO_TOKEN`, `FROM` (your Twilio number as +1..., or a Messaging Service SID starting MG), `CLOCK_URL` (Homebase or HHAeXchange link), `TEST_TO` (your own mobile). Keep these only in the script, never on GitHub. Leave `ENABLED: false`.
2. US carriers require business texting numbers to be registered with Twilio (A2P 10DLC). Do that in the Twilio console first; approval can take days or weeks.
3. Set `ENABLED: true`, run `sendTestText`, and confirm it arrives. Twilio answers STOP/START replies by itself; an aide who texts STOP stops receiving messages.
4. **Set the project time zone to Eastern.** In Apps Script open Project Settings, tick "Show appsscript.json manifest file in editor", open `appsscript.json` and make sure it contains the line `"timeZone": "America/New_York",` (or use the Time zone drop-down in Project Settings). As a safeguard, if the project is not on `CONFIG.TIMEZONE` (default America/New_York), no texts are sent and the office is emailed.
5. Run `installTextReminders` once. It installs shift reminders every 5 minutes and compliance texts daily at 9 am (script time zone; confirm it is Eastern in Project Settings).
6. **Compliance texts to aides**: 60 days before, 30 days before, on the due date, then weekly until recorded. Only aides with a phone and "agreed to text messages". Optional `OFFICE_PHONES` get a counts-only text with the Monday digest.


## Sheet renames, name columns and existing PCA authorizations
- Run `upgrade` once after pasting this script. It renames the Sheet file to **Comfort Hands Operations Data (restricted)** and the **Plans** tab to **CarePlan** (do not rename tabs by hand; the script looks for the new name). Nothing is lost.
- **aideName** now appears in TextLog (right after email), AideRecords, AideTrack and Schedule, and **patientName** in PcaAuth. They fill themselves and refresh each night and on `upgrade`.
- **Existing PCA authorizations, one time:** in the script editor run `importPca` once to create the **PcaImport** tab, fill one patient per row (firstName, lastName, dob, insurer, authNo, authFrom, authTo; optional units, icd10, hoursWeek; dates yyyy-mm-dd), then run `importPca` again. The patient must already be in the portal (the log lists any that are not). A blank insurer is taken from the patient's record. Each patient keeps one current authorization; re-running updates it and never duplicates.
- **One at a time:** in the portal, open a patient's **PCA** screen and choose **Add existing authorization** (authorization number, start and end date required).

## Faxing PCA requests (MetroFax)
- Works like the Physician Order fax: the filled form is emailed to `<fax number>@metrofax.com` from the script's Google account (already allowed in MetroFax). The email has no patient name; a copy of the PDF is saved in the patient's Drive folder.
- In the portal, open a patient's **PCA** screen, start a request, fill the form, then press **Fax via MetroFax**. The button changes to "Confirm: fax to <insurer> <number>"; press it again to send. The request is logged as sent and the history shows "faxed <date>".
- The insurer fax numbers are in `CONFIG.FAX.NUMBERS` in the script (Horizon, UnitedHealthcare, Aetna, Wellpoint filled in; HealthPartners blank, so that form is downloaded instead). Change a number there and redeploy. A blank `CONFIG.FAX.GATEWAY_DOMAIN` switches PCA faxing off.
- The script only knows the email was handed to MetroFax. Check MetroFax's confirmation email to see whether the fax was delivered.

## reCAPTCHA on the Apply page (optional, recommended)

1. Go to https://www.google.com/recaptcha/admin/create . Label: Comfort Hands Apply. Type: **reCAPTCHA v3**. Domain: `comforthands.net`. Submit.
2. Google shows two keys. The **Site key** is public; the **Secret key** is private.
3. Paste the **Secret key** into `CONFIG.RECAPTCHA_SECRET` in `Code.gs` (Apps Script), then deploy a new version.
4. Paste the **Site key** into `const RECAPTCHA_SITE=''` near the top of the script in `apply/index.html`, and upload the file.
5. Test: submit an application. If real applicants are blocked, lower `RECAPTCHA_MIN_SCORE` (0.5 to 0.3).

Until the secret is set, no check is made. The first time a verification runs, Google may ask you to authorize the script's "connect to an external service" permission (it already does this for texts).

## Bulk patient update (member ID, insurer, address, phone, ICD-10, first day of service)

1. In Apps Script, run `previewPatientUpdate` once. It creates a tab called **PatientUpdate** with headers.
2. Paste your list under the headers. Headers it understands (any order, capital letters don't matter): Member ID, Insurance company, First Day of Service, Admission ID, First Name, Last Name, ICD-10, Address1, Address2, City, County, Home Phone, State, Zip, DOB, Medicaid #. Only First Name and Last Name are required.
3. Run `previewPatientUpdate` again. It changes nothing; open View > Logs to see what it would do for each row.
4. Run `updatePatients` to apply. A **Result** column is added on the tab showing what happened to each row.

Patients are found by first + last name (and DOB when you give one). A blank cell never erases what is already saved. A patient not in the portal is added only if the row has a DOB. Insurance company names are matched to Horizon, UnitedHealthcare, Aetna, Wellpoint or HealthPartners; anything else is reported in the Result column and left alone. You can run it again any time.


## Employee details, requested items and Activity sheets
- **Your details**: on the employee link page every application answer can be corrected or filled in (except Social Security number, email and position, which only the office changes). Each change is logged with the old and new value on the employee's onboarding record.
- **Request items**: on an onboarding record, tick only the items the person should see (W-4, SSN card, I-9 documents, contract, any signed form, physical, details) and press Send link. Send again resends only what is still missing.
- **Add existing employee**: on the New hires screen, pick someone from the aide tracker and the items you need. These people are not counted as new hires on the home screen.
- **Activity sheets** (admin home): attach aides to a sheet the nurse published, then Publish, Update or Unpublish.

## Portal home update
- **Patient #**: each patient gets a 3-digit number starting at 100 (never reused; 4 digits after 999). Existing patients are numbered once, oldest start of care first, the first time the portal home loads after you deploy.
- **Insurance ID** column shows the member ID (Medicaid # if none) with the insurer under it; it refreshes whenever the patient form is saved.
- **Staff home line**: add column C "Staff home" to the Motivation tab (one line per row). One line shows under the date each day; built-in lines are used if the column is empty.
- Lists show 10 at a time, A to Z by last name. Status filter defaults to Active; the search box finds name, Patient # or Insurance ID.
- Lilac theme applied to all pages (upload every page folder).
