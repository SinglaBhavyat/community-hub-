
import { db } from '../config/firebase.js';
import { currentUser } from '../store/db.js';
import { collection, query, where, getDocs } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

export function setupAchievements() {
    document.addEventListener('click', async (e) => {
        if (e.target.closest('[data-target="page-achievements"]') && currentUser) {
            const listEl = document.getElementById('achievements-list');
            if(!listEl) return;
            listEl.innerHTML = '<p class="text-slate-500 col-span-full text-center">Calculating your achievements...</p>';
            
            const q = query(collection(db, 'posts'), where('authorEmail', '==', currentUser.email));
            const snapshot = await getDocs(q);
            const postCount = snapshot.size;

            const achievements = [
                { title: 'First Post', desc: 'Shared your first thought.', unlocked: postCount >= 1 },
                { title: 'Community Starter', desc: 'Created 5 posts.', unlocked: postCount >= 5 },
                { title: 'Influencer', desc: 'Created 10 posts.', unlocked: postCount >= 10 }
            ];

            listEl.innerHTML = achievements.map(ach => `
                <div class="p-6 rounded-xl border ${ach.unlocked ? 'border-green-500 bg-green-500/10' : 'border-slate-800 opacity-60'}">
                    <h4 class="font-bold ${ach.unlocked ? 'text-green-400' : 'text-slate-500'} text-lg">${ach.title}</h4>
                    <p class="text-sm text-slate-400">${ach.desc}</p>
                </div>
            `).join('');
        }
    });
}