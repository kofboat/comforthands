# Finance portal: Google setup

This connects the finance portal to a Google Sheet and a Drive folder so that you and Abigail see the same data on any device. Skip it to use local mode (data stays in one browser, protected by a PIN).

The portal page never touches your Sheet or Drive directly. It signs you in with Google and sends requests to a small script (`Code.gs`) that runs as you. The script only answers the owner's account and the people on its Users tab.

## One-time setup (about 10 minutes)

1. **Create the Sheet.** In Google Sheets, create a blank spreadsheet named "Comfort Hands finance". Do not share it with anyone. The script reads and writes it for the owners.
2. **Add the script.** In that Sheet, open Extensions, then Apps Script. Delete the sample code and paste in everything from `Code.gs`.
3. **Set the Client ID.** At the top of the script, replace `PASTE_YOUR_GOOGLE_CLIENT_ID_HERE` with the same Google Client ID your nurse app uses. Check that `ALLOWED_EMAILS` shows `abigail@comforthands.net` (she becomes an Owner the first time the script runs). Save.
4. **Deploy.** Choose Deploy, then New deployment, then the gear icon and Web app. Set **Execute as: Me** and **Who has access: Anyone**. Select Deploy, then approve the permissions Google asks for (Sheets, Drive, and external requests). Copy the web app URL, which ends in `/exec`.
5. **Allow the page address.** In Google Cloud Console, open the Client ID you reused and add the address where the portal is hosted to Authorized JavaScript origins. Sign-in will not work from a file opened directly from your computer.
6. **Connect the portal.** Open the portal. On the sign-in screen, choose "Connect Google for shared storage", paste the Client ID and the web app URL, and save. Then choose Sign in with Google.
7. **Abigail** repeats step 6 on her device with the same two values, then signs in with her `@comforthands.net` account. Anyone else you add on the Users tab does the same.

## Client counts on the Dashboard (optional)

The Dashboard can show active clients, admissions, discharges and churn by year, read from the admin portal's data sheet. Only counts are read, never client names.

1. In Google Drive, open the sheet named "Comfort Hands Operations Data (restricted)". Its web address looks like `docs.google.com/spreadsheets/d/LONG-ID/edit`.
2. Copy the `LONG-ID` part and paste it between the quotes after `ADMIN_SHEET_ID` at the top of `Code.gs`.
3. Redeploy: Deploy, Manage deployments, edit, new version. Google will ask you to approve the script again.

The Google account that owns the finance script must be able to open that sheet. Admissions use the start of care date, discharges use the discharge date, and churn is discharges divided by clients served that year (clients at the start of the year plus new admissions). If the admin sheet is not connected, owners see a short note on the Dashboard instead.

## Users and roles

The first time the script runs it creates a **Users** tab in the Sheet and adds the emails in `ALLOWED_EMAILS` as Owners. The Google account that owns the script is always an Owner. After that, manage people from the **Users** tab in the portal (visible to Owners only).

| | Owner | Bookkeeper | Viewer |
|---|---|---|---|
| Claims, statements, bills, receipts, payroll cost | Edit | Edit | View |
| Reports | View | View | View |
| Owner draws | Edit | Hidden | Hidden |
| Users, activity log, backups | Edit | Hidden | Hidden |

Roles are enforced by the script on every request, so a hidden tab cannot be read by calling the script directly. Removing someone takes effect on their next request. A bookkeeper can still see claims (patient names and member IDs) and bank transactions, including transfers to owners.

## Activity log

Owners can open the **Activity log** on the Users tab (also stored in a `Log` tab of the Sheet). It records sign-ins, refused sign-ins, saves, receipt uploads and deletions, and user changes, with who and when. For saves it records counts such as "Bills: 1 added; Txns: 12 changed", never the contents. Edit the Sheet directly and you can change the log, so treat it as a convenience record, not tamper-proof evidence.

## Good to know

- **Why "Anyone"?** It only means the web address needs no Google login to reach. Every request must still include a valid Google sign-in for someone on the Users tab, or it is refused.
- **Receipts** go into a Drive folder called "Comfort Hands finance receipts", created on the first upload and shared as viewer with everyone on the Users tab.
- **Changing the script later:** after any edit to `Code.gs`, choose Deploy, then Manage deployments, then edit the deployment and select a new version. The URL stays the same.
- **Adding someone:** use the Users tab. They connect the portal as in step 6.
- **Patient information:** the Sheet holds patient names and member IDs. Keep it unshared and make sure your Google Workspace has a signed HIPAA business associate agreement.
