// src/utils/storage.js

const CLOUD_NAME    = 'dqipn2dty';
const UPLOAD_PRESET = 'app1234';

// ─── Resource type ────────────────────────────────────────────────────────────
function resourceTypeFor(file) {
    const type = file?.type || '';
    if (type.startsWith('image/')) return 'image';
    if (type.startsWith('video/')) return 'video';
    if (type.startsWith('audio/')) return 'video';  // Cloudinary handles audio under the video API for streamable URLs
    return 'raw';
}

// ─── Image compression (uses browser-image-compression CDN lib) ───────────────
async function compressImage(file) {
    if (!window.imageCompression) return file;
    // Skip non-images, animated GIFs (compression flattens animation), and files
    // already below the target size — re-encoding small files wastes CPU and can
    // inflate PNG sizes due to format conversion overhead.
    if (!file?.type?.startsWith('image/') || file.type === 'image/gif') return file;
    if (file.size < 350 * 1024) return file;
    try {
        return await window.imageCompression(file, {
            maxSizeMB:        1,
            maxWidthOrHeight: 1920,
            useWebWorker:     true,
            fileType:         'image/webp',   // smaller than jpeg in most cases
        });
    } catch {
        console.warn('[storage] Image compression failed, using original.');
        return file;
    }
}

// ─── Video compression via canvas frame-sampling ─────────────────────────────
/**
 * Free, client-side video "compression":
 *  - Checks if the file is already under the threshold → skips
 *  - Otherwise extracts the first frame as a poster image for preview
 *  - Sends the original video to Cloudinary with eager transformation params
 *    so Cloudinary re-encodes it server-side on its free tier (quality=auto,
 *    format=auto) — this costs 0 Cloudinary credits on the free plan.
 *
 * True transcoding in the browser (e.g. via ffmpeg.wasm) is 200 MB+ and
 * impractical on a free stack, so we use Cloudinary's server-side pipeline
 * instead, which is included on all plans.
 */
async function getVideoThumbnail(file) {
    return new Promise((resolve) => {
        const video  = document.createElement('video');
        const canvas = document.createElement('canvas');
        const url    = URL.createObjectURL(file);

        let settled = false;
        function done(dataUrl) {
            if (settled) return;
            settled = true;
            URL.revokeObjectURL(url);
            resolve(dataUrl);
        }

        function capture() {
            if (settled) return;
            // Guard against zero-size video (metadata not yet ready)
            if (!video.videoWidth || !video.videoHeight) { done(null); return; }
            canvas.width  = Math.min(video.videoWidth,  480);
            canvas.height = Math.round(canvas.width * (video.videoHeight / video.videoWidth));
            try {
                canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
                done(canvas.toDataURL('image/jpeg', 0.7));
            } catch {
                done(null);
            }
        }

        // Timeout fallback — if events never fire (e.g. unsupported codec) resolve null
        const timeout = setTimeout(() => done(null), 8000);

        video.addEventListener('seeked', () => {
            clearTimeout(timeout);
            capture();
        });

        video.addEventListener('loadedmetadata', () => {
            // Seek to 0.1 s (not 0) so browsers that skip seeking to the
            // already-current position still fire the 'seeked' event.
            // Clamp to duration in case the video is very short.
            video.currentTime = Math.min(0.1, (video.duration || 0) / 2);
        });

        video.addEventListener('error', () => {
            clearTimeout(timeout);
            done(null);
        });

        video.muted      = true;
        video.playsInline = true;
        video.preload    = 'metadata';
        video.src        = url;
        video.load();
    });
}

// ─── Core Cloudinary uploader ─────────────────────────────────────────────────
/**
 * Upload a single file to Cloudinary with XHR progress.
 * Videos get `eager` transformation to auto-quality/format on server (free).
 */
export async function uploadToCloudinary(file, folder = 'uploads', opts = {}) {
    if (!file) return null;
    const { fileName, onProgress } = opts;
    const resourceType = resourceTypeFor(file);
    const url = `https://api.cloudinary.com/v1_1/${CLOUD_NAME}/${resourceType}/upload`;

    const formData = new FormData();
    formData.append('file', file, fileName || file.name || `upload_${Date.now()}`);
    formData.append('upload_preset', UPLOAD_PRESET);
    formData.append('folder', `community_hub/${folder}`);

    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', url);

        xhr.upload.onprogress = (e) => {
            if (e.lengthComputable && onProgress) {
                onProgress(Math.round((e.loaded / e.total) * 100));
            }
        };

        xhr.onload = () => {
            let data;
            try { data = JSON.parse(xhr.responseText); }
            catch { reject(new Error('Invalid response from Cloudinary')); return; }

            if (xhr.status >= 200 && xhr.status < 300 && data.secure_url) {
                onProgress?.(100);
                // For videos, derive a poster thumbnail via Cloudinary's so_0 transform.
                // e.g. /video/upload/v123/file.mp4 → /video/upload/so_0/v123/file.jpg
                let thumbnailUrl = null;
                if (data.resource_type === 'video') {
                    thumbnailUrl = data.secure_url
                        .replace('/video/upload/', '/video/upload/so_0/')
                        .replace(/\.[^.]+$/, '.jpg');
                }
                resolve({ url: data.secure_url, thumbnailUrl });
            } else {
                const uploadErr = new Error(data.error?.message || `Upload failed (${xhr.status})`);
                uploadErr.status = xhr.status;   // propagate so uploadBytesWithRetry can skip retries on 4xx
                reject(uploadErr);
            }
        };

        xhr.onerror = () => reject(new Error('Network error during upload'));
        xhr.send(formData);
    });
}

// ─── Single image helper (backward compat) ────────────────────────────────────
export async function uploadImage(file, folder = 'uploads') {
    if (!file) return null;
    const compressed = await compressImage(file);
    try {
        const { url } = await uploadToCloudinary(compressed, folder, { fileName: file.name });
        return url;
    } catch (err) {
        console.error('[storage] Image upload error:', err);
        throw err;
    }
}

// ─── Multi-file upload (posts) ────────────────────────────────────────────────
/**
 * Upload multiple images/videos, compressing images client-side first.
 * Returns an array of { url, type: 'image'|'video' } objects.
 *
 * @paif (resourceType === 'video')ram {File[]}   files
 * @param {string}   folder
 * @param {(overall: number) => void} [onProgress]  0-100 overall progress
 */
export async function uploadMediaFiles(files, folder = 'posts', onProgress) {
    if (!files?.length) return [];

    const results   = new Array(files.length).fill(null);
    const progArr   = new Array(files.length).fill(0);

    const reportProgress = () => {
        if (!onProgress) return;
        const overall = Math.round(progArr.reduce((a, b) => a + b, 0) / files.length);
        onProgress(overall);
    };

    await Promise.all(files.map(async (file, i) => {
        const isImage = file.type.startsWith('image/');
        const isVideo = file.type.startsWith('video/');

        let toUpload = file;
        if (isImage) toUpload = await compressImage(file);

        try {
            const { url, thumbnailUrl } = await uploadToCloudinary(toUpload, folder, {
                fileName:   file.name,
                onProgress: (pct) => { progArr[i] = pct; reportProgress(); },
            });
            results[i] = { url, type: isImage ? 'image' : isVideo ? 'video' : 'raw', ...(thumbnailUrl && { thumbnailUrl }) };
        } catch (err) {
            console.error(`[storage] Failed to upload file ${i} (${file.name}):`, err);
            results[i] = null;   // skip failed files, don't abort the whole batch
        }
    }));

    return results.filter(Boolean);
}

// ─── Video thumbnail helper (exported for preview UI) ─────────────────────────
export { getVideoThumbnail };