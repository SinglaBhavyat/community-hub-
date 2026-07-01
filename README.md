# Community Hub

A modern community platform — posts, events, study groups, lost & found, real-time
messaging, an AI help chat, and an admin panel — built as a static, no-build-step
site with vanilla JS ES modules and Firebase (Auth, Firestore, Storage).

## Project structure

```
.
├── index.html                  Single-page app shell (all sections, hidden/shown via JS)
├── style.css                   Global styles
├── firestore.rules             Firestore security rules
├── firebase.json               Firebase CLI config (Firestore + Hosting)
├── .firebaserc                 Firebase project alias
├── .github/workflows/          CI/CD — GitHub Pages & Firebase Hosting deploys
└── src/
    ├── main.js                 App entry point / bootstrap
    ├── config/
    │   └── firebase.js         Firebase SDK init (auth, db, storage)
    ├── store/
    │   └── db.js                Shared in-memory current-user store
    ├── ui/
    │   ├── navigation.js        Page routing, theme toggle
    │   └── templates.js         Reusable HTML-building helpers
    ├── utils/
    │   └── storage.js           Image upload / compression helpers
    └── features/
        ├── auth.js               Sign in / sign up / session handling
        ├── posts.js               Community feed CRUD
        ├── comments.js            Post comments
        ├── eventsAndPolls.js      Events, study groups, polls
        ├── lostFound.js           Lost & Found board
        ├── chat.js                Direct messages & group chat
        ├── aiChat.js              Echo AI assistant
        ├── achievements.js        Achievement badges
        ├── profile.js             User profile editing
        └── admin.js               Admin panel, reports, moderation
```

No bundler, no `npm install` — the browser loads `src/main.js` as a native ES
module directly, and the Firebase SDK is imported from Google's CDN. That
means it can be deployed to any static host as-is.

## Running locally

Because it uses ES modules, you need to serve the files over HTTP (opening
`index.html` directly via `file://` will not work). Any static server works:

```bash
# Python
python3 -m http.server 5500

# or Node
npx serve .

# or the VS Code "Live Server" extension
```

Then open `http://localhost:5500`.

## Deployment

This repo ships with two ready-to-use GitHub Actions workflows. Pick whichever
fits — you can also enable both if you want the site mirrored in two places.

### Option A — GitHub Pages

1. Push this repo to GitHub.
2. In the repo, go to **Settings → Pages** and set **Source** to
   **GitHub Actions**.
3. Push to `main` (or run the workflow manually from the **Actions** tab).
   `.github/workflows/deploy-gh-pages.yml` will build and publish the site.
4. Your site will be live at `https://<username>.github.io/<repo-name>/`.

No secrets are required for this option — it deploys the static files as-is.

### Option B — Firebase Hosting (auto-deploy from GitHub)

This project is already wired to the Firebase project `community-45e72`
(see `.firebaserc` and `firebase.json`).

1. Create a Firebase service account key with the **Firebase Hosting Admin**
   role:
   ```bash
   firebase init hosting:github
   ```
   This command (run locally with the Firebase CLI, `npm i -g firebase-tools`)
   will automatically create the `FIREBASE_SERVICE_ACCOUNT` secret in your
   GitHub repo for you. Alternatively, create the key manually in the
   [Google Cloud Console](https://console.cloud.google.com/iam-admin/serviceaccounts)
   and add it yourself under **Settings → Secrets and variables → Actions** in
   GitHub as `FIREBASE_SERVICE_ACCOUNT`.
2. Push to `main`. `.github/workflows/deploy-firebase.yml` will deploy to the
   live Hosting channel automatically.
3. Deploy Firestore rules whenever you change `firestore.rules`:
   ```bash
   firebase deploy --only firestore:rules
   ```

### Manual deploy (no CI)

```bash
npm i -g firebase-tools
firebase login
firebase deploy
```

## Notes

- The Firebase config in `src/config/firebase.js` (API key, project ID, etc.)
  is safe to expose publicly — it identifies your Firebase project but grants
  no access on its own. Actual access control is enforced by
  `firestore.rules` and Firebase Auth. Double-check those rules before going
  to production.
- If you deploy to a GitHub Pages **project** site (i.e.
  `<username>.github.io/<repo-name>/`), all asset paths in this project are
  already relative, so no base-path changes are needed.
