# Finance portal: Google setup

This connects the finance portal to a Google Sheet and a Drive folder so that you and Abigail see the same data on any device. Skip it to use local mode (data stays in one browser, protected by a PIN).

The portal page never touches your Sheet or Drive directly. It signs you in with Google and sends requests to a small script (`Code.gs`) that runs as you. The script only answers the owner's account and the emails listed in `ALLOWED_EMAILS`.

## One-time setup (about 10 minutes)

1. **Create the Sheet.** In Google Sheets, create a blank spreadsheet named "Comfort Hands finance". Do not share it with anyone. The script reads and writes it for the owners.
2. **Add the script.** In that Sheet, open Extensions, then Apps Script. Delete the sample code and paste in everything from `Code.gs`.
3. **Set the Client ID.** At the top of the script, replace `PASTE_YOUR_GOOGLE_CLIENT_ID_HERE` with the same Google Client ID your nurse app uses. Check that `ALLOWED_EMAILS` shows `abigail@comforthands.net`. Save.
4. **Deploy.** Choose Deploy, then New deployment, then the gear icon and Web app. Set **Execute as: Me** and **Who has access: Anyone**. Select Deploy, then approve the permissions Google asks for (Sheets, Drive, and external requests). Copy the web app URL, which ends in `/exec`.
5. **Allow the page address.** In Google Cloud Console, open the Client ID you reused and add the address where the portal is hosted to Authorized JavaScript origins. Sign-in will not work from a file opened directly from your computer.
6. **Connect the portal.** Open the portal. On the sign-in screen, choose "Connect Google for shared storage", paste the Client ID and the web app URL, and save. Then choose Sign in with Google.
7. **Abigail** repeats step 6 on her device with the same two values, then signs in with her `@comforthands.net` account.

## Good to know

- **Why "Anyone"?** It only means the web address needs no Google login to reach. Every request must still include a valid Google sign-in for an allowed email, or it is refused.
- **Receipts** go into a Drive folder called "Comfort Hands finance receipts", created on the first upload. The script shares it with the emails in `ALLOWED_EMAILS` as viewers.
- **Changing the script later:** after any edit to `Code.gs`, choose Deploy, then Manage deployments, then edit the deployment and select a new version. The URL stays the same.
- **Adding someone:** add their email to `ALLOWED_EMAILS`, redeploy a new version, and share nothing else. They need to connect the portal as in step 6.
- **Patient information:** the Sheet holds patient names and member IDs. Keep it unshared and make sure your Google Workspace has a signed HIPAA business associate agreement.
