import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getAuth, GoogleAuthProvider } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { getStorage } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-storage.js";

const firebaseConfig = {
  apiKey:            "AIzaSyChCuuv9sv4IArEuIIjyQa-9CfzqCvZywA",
  authDomain:        "community-45e72.firebaseapp.com",
  projectId:         "community-45e72",
  storageBucket:     "community-45e72.firebasestorage.app",
  messagingSenderId: "852110945704",
  appId:             "1:852110945704:web:3eceb2e4f71fedfb17c19d"
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();
export const db = getFirestore(app);
export const storage = getStorage(app);