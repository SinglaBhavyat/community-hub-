import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getAuth, GoogleAuthProvider } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { getStorage } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-storage.js";

// ─── Firebase Configuration ────────────────────────────────────────────────
// Replace all values below with your own Firebase project credentials.
// Find them in: Firebase Console → Project Settings → Your Apps → SDK setup.
// NEVER commit real credentials to version control.
const firebaseConfig = {
   apiKey: "%%FIREBASE_API_KEY%%",
  authDomain: "community-45e72.firebaseapp.com",
  projectId: "community-45e72",
  storageBucket: "community-45e72.appspot.com",
  messagingSenderId: "%%FIREBASE_SENDER_ID%%",
  appId: "%%FIREBASE_APP_ID%%"
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();
export const db = getFirestore(app);
export const storage = getStorage(app);