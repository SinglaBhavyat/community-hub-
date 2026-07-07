import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getAuth, GoogleAuthProvider } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { getStorage } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-storage.js";

const isLocal = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";

const firebaseConfig = {
  apiKey:            isLocal ? "AIzaSyChCuuv9sv4IArEuIIjyQa-9CfzqCvZywA" : "%%FIREBASE_API_KEY%%",
  authDomain:        "community-45e72.firebaseapp.com",
  projectId:         "community-45e72",
  storageBucket:     "community-45e72.appspot.com",
  messagingSenderId: isLocal ? "852110945704" : "%%FIREBASE_SENDER_ID%%",
  appId:             isLocal ? "1:852110945704:web:920c59cc27c9493517c19d" : "%%FIREBASE_APP_ID%%"
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();
export const db = getFirestore(app);
export const storage = getStorage(app);