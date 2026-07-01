// src/utils/storage.js

const CLOUD_NAME     = 'dqipn2dty';
const UPLOAD_PRESET  = 'app1234';

// Cloudinary requires the resource_type endpoint to roughly match the file —
// images and videos get their own pipelines (thumbnails, transformations),
// everything else (voice notes, pdfs, docs, zips, etc.) goes through 'raw'.
function resourceTypeFor(file) {
    const type = file?.type || '';
    if (type.startsWith('image/')) return 'image';
    if (type.startsWith('video/')) return 'video';
    return 'raw';
}

/**
 * Generic Cloudinary uploader used by the chat module (and anything else)
 * for images, videos, voice notes, and arbitrary file attachments. This
 * exists because Firebase Storage isn't available on the Spark/free plan —
 * everything goes through Cloudinary instead.
 *
 * @param {File|Blob} file
 * @param {string} folder - subfolder under community_hub/, e.g. 'chats'
 * @param {{ fileName?: string, onProgress?: (pct:number)=>void }} [opts]
 * @returns {Promise<string>} secure_url of the uploaded asset
 */
export async function uploadToCloudinary(file, folder = 'uploads', opts = {}) {
    if (!file) return null;
    const { fileName, onProgress } = opts;
    const resourceType = resourceTypeFor(file);
    const url = `https://api.cloudinary.com/v1_1/${CLOUD_NAME}/${resourceType}/upload`;

    const formData = new FormData();
    // Cloudinary rejects some Blobs (e.g. recorded audio) without a filename —
    // always pass one explicitly as the third arg.
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
            try {
                data = JSON.parse(xhr.responseText);
            } catch {
                reject(new Error('Invalid response from Cloudinary'));
                return;
            }
            if (xhr.status >= 200 && xhr.status < 300 && data.secure_url) {
                onProgress?.(100);
                resolve(data.secure_url);
            } else {
                reject(new Error(data.error?.message || `Upload failed (${xhr.status})`));
            }
        };

        xhr.onerror = () => reject(new Error('Network error during upload'));
        xhr.send(formData);
    });
}

/**
 * Backward-compatible image-only helper (used elsewhere in the app, e.g.
 * Lost & Found photos). Internally delegates to uploadToCloudinary.
 */
export async function uploadImage(file, folder = 'uploads') {
    if (!file) return null;

    let fileToUpload = file;
    if (typeof window !== 'undefined' && window.imageCompression) {
        try {
            fileToUpload = await window.imageCompression(file, {
                maxSizeMB: 1,
                maxWidthOrHeight: 1920,
                useWebWorker: true
            });
        } catch (error) {
            console.warn("Compression failed, using original file.");
        }
    }

    try {
        return await uploadToCloudinary(fileToUpload, folder, { fileName: file.name });
    } catch (error) {
        console.error("Cloudinary Upload Error:", error);
        alert(`🚨 CLOUDINARY ERROR: ${error.message || 'Upload failed'}`);
        throw error;
    }
}