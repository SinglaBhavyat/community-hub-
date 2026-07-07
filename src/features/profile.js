import { db } from '../config/firebase.js';
import { currentUser } from '../store/db.js';
import { sanitize } from '../ui/templates.js';
import { doc, updateDoc, getDoc } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

export function setupProfile() {
    
    // ==========================================
    // 1. UPDATE OWN PROFILE (The Form)
    // ==========================================
    document.getElementById('profile-update-form')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (!currentUser) return;
        
        const btn = e.target.querySelector('button[type="submit"]');
        btn.textContent = 'Saving...'; btn.disabled = true;

        const name = document.getElementById('profile-update-name').value.trim();
        const major = document.getElementById('profile-update-major').value.trim();
        const gradYear = document.getElementById('profile-update-year').value.trim();
        const bio = document.getElementById('profile-update-bio').value.trim();
        
        // New Enhanced Fields
        const skillsRaw = document.getElementById('profile-update-skills')?.value || '';
        const skillsArray = skillsRaw.split(',').map(s => s.trim().toLowerCase()).filter(s => s);
        const github = document.getElementById('profile-update-github')?.value.trim() || '';
        const linkedin = document.getElementById('profile-update-linkedin')?.value.trim() || '';

        try {
            await updateDoc(doc(db, 'users', currentUser.email), {
                name, major, gradYear, bio, 
                skills: skillsArray,
                socialLinks: { github, linkedin }
            });
            
            // Update local state
            currentUser.name = name; currentUser.major = major; currentUser.gradYear = gradYear; 
            currentUser.bio = bio; currentUser.skills = skillsArray; currentUser.socialLinks = { github, linkedin };
            
            const successMsg = document.getElementById('profile-update-success');
            successMsg.textContent = 'Profile updated successfully!';
            successMsg.classList.remove('hidden');
            setTimeout(() => successMsg.classList.add('hidden'), 3000);
            
        } catch (error) {
            console.error("Profile update failed:", error);
            alert("Failed to update profile.");
        } finally {
            btn.textContent = 'Save Changes'; btn.disabled = false;
        }
    });

    // ==========================================
    // 2. VIEWING OTHERS' PROFILES
    // ==========================================
    // Listens for clicks on user names/avatars in the posts feed
    document.addEventListener('click', async (e) => {
        const profileBtn = e.target.closest('.view-user-profile-btn');
        if (profileBtn) {
            const targetEmail = profileBtn.dataset.userEmail;
            if (!targetEmail) return;

            try {
                const targetSnap = await getDoc(doc(db, 'users', targetEmail));
                if (!targetSnap.exists()) return alert("User not found.");
                
                const userData = targetSnap.data();
                const isMe = currentUser && currentUser.email === targetEmail;

                // Build skills chips
                let skillsHTML = '';
                if (userData.skills && userData.skills.length > 0) {
                    skillsHTML = `<div class="mt-4 flex flex-wrap gap-2">` +
                        userData.skills.map(s => `<span class="bg-sky-500/10 text-sky-400 border border-sky-500/20 px-2.5 py-1 rounded-md text-[11px] font-bold uppercase tracking-wide">${sanitize(s)}</span>`).join('') +
                        `</div>`;
                }

                // Build social links
                let socialHTML = '';
                if (userData.socialLinks) {
                    if (userData.socialLinks.github) socialHTML += `<a href="${sanitize(userData.socialLinks.github)}" target="_blank" class="text-slate-400 hover:text-white transition"><svg class="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/></svg></a>`;
                    if (userData.socialLinks.linkedin) socialHTML += `<a href="${sanitize(userData.socialLinks.linkedin)}" target="_blank" class="text-slate-400 hover:text-sky-500 transition"><svg class="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><path d="M19 0h-14c-2.761 0-5 2.239-5 5v14c0 2.761 2.239 5 5 5h14c2.762 0 5-2.239 5-5v-14c0-2.761-2.238-5-5-5zm-11 19h-3v-11h3v11zm-1.5-12.268c-.966 0-1.75-.79-1.75-1.764s.784-1.764 1.75-1.764 1.75.79 1.75 1.764-.783 1.764-1.75 1.764zm13.5 12.268h-3v-5.604c0-3.368-4-3.113-4 0v5.604h-3v-11h3v1.765c1.396-2.586 7-2.777 7 2.476v6.759z"/></svg></a>`;
                }

                // Render profile header into the card container
                const container = document.getElementById('user-profile-page-avatar').parentElement.parentElement;
                container.innerHTML = `
                    <div class="flex flex-col sm:flex-row items-start gap-6 w-full relative">
                        <div class="w-24 h-24 rounded-full bg-gradient-to-br from-sky-500 to-indigo-600 flex items-center justify-center text-4xl text-white font-bold border-4 border-slate-800 shadow-xl flex-shrink-0">${(userData.name || 'U').charAt(0).toUpperCase()}</div>
                        
                        <div class="flex-grow w-full">
                            <div class="flex flex-col sm:flex-row sm:justify-between sm:items-start gap-4">
                                <div>
                                    <h4 class="text-2xl font-bold text-white">${sanitize(userData.name)}</h4>
                                    <p class="text-sky-400 font-medium text-sm mb-2">${sanitize(targetEmail)}</p>
                                    ${userData.major ? `<p class="text-slate-400 text-sm">🎓 ${sanitize(userData.major)}${userData.gradYear ? ' · Class of ' + sanitize(userData.gradYear) : ''}</p>` : ''}
                                    ${userData.bio ? `<p class="text-slate-400 text-sm mt-3 leading-relaxed max-w-xl">${sanitize(userData.bio)}</p>` : ''}
                                    ${skillsHTML}
                                    ${socialHTML ? `<div class="flex gap-3 mt-4">${socialHTML}</div>` : ''}
                                </div>
                                
                                ${!isMe ? `
                                <div class="flex flex-col gap-2 min-w-[140px]">
                                    <button onclick="window.startDirectChat('${targetEmail}', '${sanitize(userData.name)}')" class="w-full py-2 px-4 rounded-full font-bold text-sm bg-indigo-600 hover:bg-indigo-500 text-white transition-all shadow-lg shadow-indigo-500/20">
                                        💬 Message
                                    </button>
                                </div>` : `
                                <div class="flex flex-col gap-2 min-w-[140px]">
                                    <a href="#" data-target="page-profile" class="w-full text-center py-2 px-4 rounded-full font-bold text-sm bg-slate-800 hover:bg-slate-700 text-white transition-all border border-slate-700">Edit Profile</a>
                                </div>`}
                            </div>
                        </div>
                    </div>`;

                document.querySelector('[data-target="page-user-profile"]')?.click();
                
            } catch (error) {
                console.error("Fetch profile error:", error);
            }
        }
    });
}