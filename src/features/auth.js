import { db } from '../config/firebase.js';
import { currentUser, setCurrentUser, getUserFromDB, saveUserToDB } from '../store/db.js';
import { sanitize } from '../ui/templates.js';
import { uploadToCloudinary } from '../utils/storage.js';
import {
    collection, doc, setDoc, addDoc, query, orderBy, onSnapshot,
    serverTimestamp, getDocs, limit, where, deleteDoc, updateDoc,
    arrayUnion, arrayRemove, getDoc
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { auth, googleProvider } from '../config/firebase.js';
import {
    onAuthStateChanged, signInWithPopup, signInWithRedirect, getRedirectResult, signOut
} from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js';
import { updateAuthUI } from '../ui/navigation.js';

// ============================================================
//  AUTH SETUP — Google login, sign-out, onAuthStateChanged
// ============================================================
export function setupAuth() {
    // Google sign-in button
    const googleBtn = document.getElementById('google-login-btn');
    const loginError = document.getElementById('login-error');
    const logoutBtn = document.getElementById('logout-btn');

    if (googleBtn) {
        googleBtn.addEventListener('click', async () => {
            googleBtn.disabled = true;
            if (loginError) loginError.classList.add('hidden');
            try {
                await signInWithPopup(auth, googleProvider);
            } catch (err) {
                if (err.code === 'auth/popup-blocked') {
                    // Browser blocked the popup — redirect flow instead.
                    // Page will reload after Google redirects back;
                    // getRedirectResult() below will pick up the result.
                    try {
                        await signInWithRedirect(auth, googleProvider);
                    } catch (redirectErr) {
                        console.error('Login error (redirect fallback):', redirectErr);
                        if (loginError) {
                            loginError.textContent = 'Sign-in failed. Please allow pop-ups or try again.';
                            loginError.classList.remove('hidden');
                        }
                        googleBtn.disabled = false;
                    }
                    return; // page will navigate away
                }
                console.error('Login error:', err);
                if (loginError) {
                    loginError.textContent = 'Sign-in failed. Please try again.';
                    loginError.classList.remove('hidden');
                }
            } finally {
                googleBtn.disabled = false;
            }
        });
    }

    // Sign-out button
    if (logoutBtn) {
        logoutBtn.addEventListener('click', async () => {
            try {
                await signOut(auth);
            } catch (err) {
                console.error('Logout error:', err);
            }
        });
    }

    // Handle redirect result (fallback path when popup was blocked)
    getRedirectResult(auth).catch(err => {
        // Silently ignore — errors here are rare and non-critical (e.g.
        // the user cancelled the Google redirect, or there was no pending
        // redirect at all). onAuthStateChanged below handles the success case.
        if (err.code !== 'auth/no-auth-event') {
            console.warn('Redirect sign-in result error:', err);
        }
    });

    // React to auth state changes
    onAuthStateChanged(auth, async (firebaseUser) => {
        if (firebaseUser) {
            // Load or create user record in Firestore
            let userData = await getUserFromDB(firebaseUser.email);
            if (!userData) {
                userData = {
                    email: firebaseUser.email,
                    name: firebaseUser.displayName || firebaseUser.email.split('@')[0],
                    picture: firebaseUser.photoURL || '',
                    role: 'member',
                    savedPosts: [],
                    following: [],
                    followers: [],
                    joinedAt: Date.now(),
                };
                await saveUserToDB(firebaseUser.email, userData);
            }
            setCurrentUser(userData);
        } else {
            setCurrentUser(null);
        }
        updateAuthUI();
    });
}

// Dead module-level state and helper functions removed.
// These were stale copies of chat.js internals — all chat state
// lives in chat.js. Only setupAuth() is exported from this file.