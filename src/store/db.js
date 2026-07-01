import { db } from '../config/firebase.js';
import { doc, getDoc, setDoc, updateDoc, arrayUnion, arrayRemove, deleteDoc, collection, addDoc, increment } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

export let currentUser = null;

// ── Auth-state subscribers ──────────────────────────────────────────────────
// Modules that render UI based on `currentUser` (e.g. Lost & Found) need to
// know the moment the user logs in/out or their role changes, even if they
// already have an open Firestore onSnapshot listener. Without this, a feed
// rendered while signed out (or as a non-admin) would never refresh its
// owner/admin-only buttons until something else forced a re-render.
const _userListeners = new Set();

export const onCurrentUserChange = (cb) => {
    if (typeof cb !== 'function') return () => {};
    _userListeners.add(cb);
    return () => _userListeners.delete(cb); // unsubscribe handle
};

export const setCurrentUser = (user) => {
    currentUser = user;
    // Ensure arrays exist in local state
    if (currentUser && !currentUser.savedPosts) currentUser.savedPosts = [];
    if (currentUser && !currentUser.following) currentUser.following = [];
    if (currentUser && !currentUser.followers) currentUser.followers = [];

    for (const cb of _userListeners) {
        try { cb(currentUser); } catch (e) { console.error('[db] user listener error:', e); }
    }
};

export const getUserFromDB = async (email) => {
    try {
        const docSnap = await getDoc(doc(db, 'users', email));
        return docSnap.exists() ? docSnap.data() : null;
    } catch (error) {
        console.error("Error getting user:", error);
        return null;
    }
};

export const saveUserToDB = async (email, userData) => {
    try {
        await setDoc(doc(db, 'users', email), userData, { merge: true });
    } catch (error) {
        console.error("Error saving user:", error);
    }
};

export const addDocument = async (collectionName, data) => {
    try {
        const docRef = await addDoc(collection(db, collectionName), data);
        return docRef.id;
    } catch (error) {
        console.error(`Error adding to ${collectionName}:`, error);
        throw error;
    }
};

export const deleteDocument = async (collectionName, docId) => {
    try {
        await deleteDoc(doc(db, collectionName, docId));
    } catch (error) {
        console.error(`Error deleting from ${collectionName}:`, error);
        throw error;
    }
};

// ==========================================
// NEW: SOCIAL GRAPH LOGIC (FOLLOW SYSTEM)
// ==========================================
export const toggleFollowUser = async (targetEmail) => {
    if (!currentUser || currentUser.email === targetEmail) return;

    const isFollowing = currentUser.following?.includes(targetEmail);
    const myRef = doc(db, 'users', currentUser.email);
    const targetRef = doc(db, 'users', targetEmail);

    try {
        if (isFollowing) {
            // Unfollow
            currentUser.following = currentUser.following.filter(e => e !== targetEmail);
            await updateDoc(myRef, { following: arrayRemove(targetEmail) });
            await updateDoc(targetRef, { followers: arrayRemove(currentUser.email) });
        } else {
            // Follow
            currentUser.following.push(targetEmail);
            await updateDoc(myRef, { following: arrayUnion(targetEmail) });
            await updateDoc(targetRef, { followers: arrayUnion(currentUser.email) });
        }
        return !isFollowing; // Returns true if now following
    } catch (error) {
        console.error("Follow error:", error);
        throw error;
    }
};