import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getAuth, GoogleAuthProvider } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { getStorage } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-storage.js";

// ─── Firebase Configuration ────────────────────────────────────────────────
// Replace all values below with your own Firebase project credentials.
// Find them in: Firebase Console → Project Settings → Your Apps → SDK setup.
// NEVER commit real credentials to version control.
const firebaseConfig = {
   apiKey: "AIzaSyChCuuv9sv4IArEuIIjyQa-9CfzqCvZywA",
  authDomain: "community-45e72.firebaseapp.com",
  projectId: "community-45e72",
  storageBucket: "community-45e72.appspot.com",
  messagingSenderId: "852110945704",
  appId: "1:852110945704:web:920c59cc27c9493517c19d"
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();
export const db = getFirestore(app);
export const storage = getStorage(app);