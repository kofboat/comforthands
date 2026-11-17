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
- Run `installReminder` once from the editor. It sends a reminder every Sunday at 8 pm to the office and to each assigned aide who has an unsubmitted sheet.
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
3. The applicant opens the link, gets a 6-digit code by email, and sees their list: forms to sign on screen (Agreement of Standards, job description for Companion / PCA, background investigation forms, reference release), the signed contract to upload, and ID uploads (Social Security card, I-9 List A, or List B plus List C chosen from drop-downs, physical exam). Name, address, phone, email and date of birth are already filled in. Signed forms are filed as PDFs; uploads go to the restricted HR folder.
4. You tick the remaining steps (W-4, I-9 completed with the office, license, references, background, physical, in-service, competency, Homebase, HHAeXchange), then press **Create aide login**.

One-time setup
1. Paste the new `Code.gs`, keeping your own CONFIG values. Add these keys: `APPLY_URL` (the address where you put the Apply page), `FCRA_SUMMARY_URL` (link to the Fair Credit Reporting Act rights summary; your screening company can give you theirs, or use https://files.consumerfinance.gov/f/201504_cfpb_summary_your-rights-under-fcra.pdf).
2. Run `upgrade` once from the editor. It creates the restricted HR folder and adds the new Onboarding columns. Then **Deploy > Manage deployments > edit > New version**.
3. Upload `apply/index.html` to your site in a folder named `apply` (so the address is for example https://comforthands.net/apply/). The Apply page already points at your script address. Check it is the same one used by the portal.
4. Before going live, open `apply/index.html` and replace the placeholder consent wording, EEO statement and the Terms and Privacy links with the exact text from your current careers page, then set `DRAFT=false`. While `DRAFT=true` the page shows a "preview only" notice.
5. Point your Careers page button at the new Apply page when you are ready. Test with your own email first.

Notes
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
