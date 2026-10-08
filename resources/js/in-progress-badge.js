/**
 * Global floating progress ring for videos that are queued or being processed.
 *
 * Imported once from app.js, so it runs once per hard page load. The ring lives outside <main>, so soft
 * navigation never replaces it and its Echo listener survives page changes.
 *
 * State: `active` (videoId -> progress 0-100) and `completed` (finished videos in the current batch).
 * Batch total N = completed + active.size; the video being processed is k = min(completed + 1, N).
 *
 * The batch only ends after the server confirms nothing is pending/processing (reconcile), then a short hold, then one more
 * confirmation (`finalizing`: while it runs no new hold may be armed, otherwise the batch would never reset). `completed` and the finished ids are kept in sessionStorage so a hard reload mid-batch keeps the counts.
 *
 * Browser-side uploads: files of this browser's Upload page that are not server videos yet (window.__uploadQueueRegistry
 * entries without a videoId, not in error) also count in the batch, at their share of the upload stage. An entry stops
 * counting separately as soon as its video is known (entry.videoId, or a server video with the same upload_id), so the
 * hand-off at /complete neither double counts nor jumps. The Upload page fires `upload-registry:update` on every change.
 */
import { uploadWeight } from './video-progress';

const EVENT = '.video.status-updated';
const DEBOUNCE_MS = 500;
const RENDER_INTERVAL_MS = 250;
const DONE_HOLD_MS = 2500;
const STORAGE_KEY = 'hls_inprogress_batch';
const STORAGE_MAX_AGE_MS = 30 * 60 * 1000;
const LEAVE_MS = 400;
const RADIUS = 30;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export default function initInProgressBadge() {
    const ring = document.querySelector('[data-in-progress-ring]');

    if (!ring) {
        return;
    }

    const countUrl = ring.dataset.countUrl;
    const arc = ring.querySelector('[data-ring-progress]');
    const label = ring.querySelector('[data-ring-label]');
    const status = ring.querySelector('[data-ring-status]');

    let stages = {};

    try {
        stages = JSON.parse(ring.dataset.progressStages || '{}') || {};
    } catch (err) {
        // Malformed constants: uploads fall back to an equal-share weight.
    }

    const active = new Map();
    // upload_id of every server video seen in this session; a registry entry with one of these ids is that video.
    const knownUploadIds = new Set();
    // Every video id that was ever part of the ring state, so a stale registry entry is never adopted a second time.
    const seenVideoIds = new Set();
    const finished = new Set();
    let completed = 0;

    let debounceTimer = null;
    let hideTimer = null;
    let leaveTimer = null;
    let finalizing = false;
    let leaving = false;
    let inFlight = false;
    let inFlightPromise = null;
    let queued = false;
    let renderTimer = null;
    let lastRenderAt = 0;
    let lastLabel = '';
    let lastStatusBucket = null;

    arc.setAttribute('stroke-dasharray', String(CIRCUMFERENCE));

    function clampProgress(value) {
        const number = Number(value);

        return Number.isFinite(number) ? Math.max(0, Math.min(100, number)) : 0;
    }

    function registryEntries() {
        const registry = window.__uploadQueueRegistry;

        return registry && typeof registry === 'object' ? Object.values(registry) : [];
    }

    function hasVideoId(entry) {
        return entry.videoId !== null && entry.videoId !== undefined && entry.videoId !== '';
    }

    // Upload progress of a file that is not a server video yet, in the same overall-percent scale as server videos.
    // Floored like VideoProgress::overall() so the finished upload equals the server's first value (no jump at hand-off).
    function uploadProgress(entry) {
        if (entry.status !== 'uploading') {
            return 0;
        }

        const percent = Math.max(0, Math.min(100, Number(entry.uploadPercent) || 0));

        const weight = uploadWeight(entry.size, stages);

        return Math.min(99, Math.floor(percent >= 100 ? weight : weight * percent / 100));
    }

    // The Upload page set entry.videoId (hand-off at /complete) before any server event/list mentioned the video: count the
    // video now at the same value the upload had, so N and the percent do not dip until the server confirms it.
    function adoptHandedOff() {
        let adopted = false;

        registryEntries().forEach(function (entry) {
            if (!entry || !hasVideoId(entry) || entry.status !== 'pending') {
                return;
            }

            const id = Number(entry.videoId);

            if (!Number.isInteger(id) || seenVideoIds.has(id) || active.has(id) || finished.has(id)) {
                return;
            }

            if (entry.uploadId) {
                knownUploadIds.add(entry.uploadId);
            }

            seenVideoIds.add(id);
            active.set(id, uploadProgress({ size: entry.size, status: 'uploading', uploadPercent: 100 }));
            adopted = true;
        });

        if (adopted) {
            scheduleReconcile();
        }
    }

    // Registry entries that count as batch videos of their own.
    function pendingUploads() {
        return registryEntries().filter(function (entry) {
            return entry && !hasVideoId(entry) && entry.status !== 'error'
                && !(entry.uploadId && knownUploadIds.has(entry.uploadId));
        });
    }

    // Links a server video to the registry entry of the same file so that it is not counted twice. With an upload_id the
    // match is exact; without one (realtime events) the single entry that is finalising (100%, no video yet) is the match.
    function linkRegistry(id, uploadId, allowGuess) {
        const entries = registryEntries();

        if (uploadId) {
            entries.forEach(function (entry) {
                if (entry.videoId === id && entry.uploadId && entry.uploadId !== uploadId) {
                    entry.videoId = null; // an earlier guess was wrong
                }
            });
        }

        if (entries.some(function (entry) { return entry.videoId === id; })) {
            return;
        }

        let match = null;

        if (uploadId) {
            match = entries.find(function (entry) {
                return !hasVideoId(entry) && entry.uploadId === uploadId;
            }) || null;
        } else if (allowGuess) {
            const finalising = entries.filter(function (entry) {
                return !hasVideoId(entry) && entry.status !== 'error' && Number(entry.uploadPercent) >= 100;
            });

            match = finalising.length === 1 ? finalising[0] : null;
        }

        if (match) {
            match.videoId = id;
        }
    }

    // Shares the ring state with other widgets (e.g. the Logs page In Progress card) so their numbers match the ring.
    function publish(total, current, percent, uploads) {
        const state = {
            total: total,
            completed: completed,
            current: current,
            percent: percent,
            active: Array.from(active, function (entry) {
                return { id: entry[0], progress: entry[1], kind: 'video' };
            }).sort(function (a, b) {
                return a.id - b.id;
            }).concat(uploads.map(function (entry) {
                return {
                    id: String(entry.queueId),
                    progress: uploadProgress(entry),
                    kind: 'upload',
                    title: entry.title || '',
                    uploadPercent: entry.status === 'uploading' ? Math.max(0, Math.min(100, Number(entry.uploadPercent) || 0)) : 0,
                };
            })),
        };

        window.__inProgressState = state;
        window.dispatchEvent(new CustomEvent('in-progress:update', { detail: state }));
    }

    function render() {
        renderTimer = null;
        lastRenderAt = Date.now();

        adoptHandedOff();

        const uploads = pendingUploads();
        const total = completed + active.size + uploads.length;

        if (total < 1) {
            // While the fade-out runs the ring stays mounted; leaveTimer re-renders to hide it.
            ring.hidden = !leaving;
            publish(0, 0, 0, []);
            return;
        }

        if (leaving) {
            clearTimeout(leaveTimer);
            leaveTimer = null;
            leaving = false;
        }

        const working = active.size + uploads.length > 0;

        ring.dataset.state = working ? 'active' : 'done';

        let sum = completed * 100;
        active.forEach(function (progress) {
            sum += progress;
        });
        uploads.forEach(function (entry) {
            sum += uploadProgress(entry);
        });

        const percent = Math.round(sum / total);
        const current = Math.min(completed + 1, total);
        const text = current + ' of ' + total;
        const description = !working
            ? 'Processing finished, ' + total + (total === 1 ? ' video' : ' videos') + ' done'
            : 'Processing video ' + current + ' of ' + total + ', ' + percent + '% complete';

        publish(total, current, percent, uploads);

        ring.hidden = false;
        arc.setAttribute('stroke-dashoffset', String(CIRCUMFERENCE * (1 - sum / (total * 100))));
        ring.title = description;

        if (text !== lastLabel) {
            label.textContent = text;
            lastLabel = text;
        }

        // Announce to assistive tech only on batch position changes or every 10%, not on every tick.
        const bucket = text + ':' + Math.floor(percent / 10);

        if (bucket !== lastStatusBucket) {
            status.textContent = description;
            lastStatusBucket = bucket;
        }
    }

    function scheduleRender(immediate) {
        if (renderTimer !== null) {
            return;
        }

        const wait = immediate ? 0 : Math.max(0, RENDER_INTERVAL_MS - (Date.now() - lastRenderAt));

        renderTimer = setTimeout(function () {
            window.requestAnimationFrame(render);
        }, wait);
    }

    function saveBatch() {
        try {
            if (completed > 0) {
                sessionStorage.setItem(STORAGE_KEY, JSON.stringify({
                    completed: completed,
                    finished: Array.from(finished),
                    ts: Date.now(),
                }));
            } else {
                sessionStorage.removeItem(STORAGE_KEY);
            }
        } catch (err) {
            // Best-effort: storage can be unavailable or blocked.
        }
    }

    function restoreBatch() {
        try {
            const data = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || 'null');

            if (!data || !Number.isInteger(data.completed) || data.completed < 1 || !Array.isArray(data.finished)
                || !Number.isFinite(data.ts) || Date.now() - data.ts > STORAGE_MAX_AGE_MS) {
                sessionStorage.removeItem(STORAGE_KEY);
                return;
            }

            completed = data.completed;
            data.finished.forEach(function (id) {
                if (Number.isInteger(id)) {
                    finished.add(id);
                }
            });
        } catch (err) {
            // Best-effort: ignore unreadable or unavailable storage.
        }
    }

    function resetBatch() {
        completed = 0;
        finished.clear();
        lastLabel = '';
        lastStatusBucket = null;
        saveBatch();

        // Fade out first, then hide; a video arriving meanwhile cancels the fade in render().
        leaving = true;
        ring.dataset.state = 'leaving';
        clearTimeout(leaveTimer);
        leaveTimer = setTimeout(function () {
            leaveTimer = null;
            leaving = false;
            scheduleRender(true);
        }, LEAVE_MS);
        scheduleRender(true);
    }

    function cancelHold() {
        clearTimeout(hideTimer);
        hideTimer = null;
    }

    // Hold elapsed: ask the server once more. No new hold may be armed meanwhile (checkDone ignores `finalizing`).
    async function finalize() {
        hideTimer = null;
        finalizing = true;

        try {
            // Wait for a request already in flight (its snapshot may predate the hold), then take a fresh one.
            while (inFlightPromise) {
                await inFlightPromise;
            }

            await reconcile();
        } finally {
            finalizing = false;
        }

        // Also reached when the final reconcile failed (network error): reset locally.
        if (active.size === 0 && completed > 0 && hideTimer === null && pendingUploads().length === 0) {
            resetBatch();
        }
    }

    // `confirmed` is true only when called right after a server snapshot; otherwise ask the server before ending the batch.
    function checkDone(confirmed) {
        if (active.size > 0 || completed < 1 || pendingUploads().length > 0) {
            cancelHold();
            return;
        }

        if (!confirmed) {
            scheduleReconcile();
            return;
        }

        if (finalizing || hideTimer !== null) {
            return;
        }

        hideTimer = setTimeout(finalize, DONE_HOLD_MS);
    }

    function setActive(id, progress, uploadId, allowGuess) {
        if (finished.has(id)) {
            return;
        }

        const isNew = !active.has(id);

        seenVideoIds.add(id);
        active.set(id, progress);

        if (typeof uploadId === 'string' && uploadId !== '') {
            knownUploadIds.add(uploadId);
            linkRegistry(id, uploadId, false);
        } else if (isNew) {
            linkRegistry(id, null, allowGuess === true);
        }
    }

    function finish(id) {
        if (active.delete(id)) {
            completed++;
            finished.add(id);
            saveBatch();
        }
    }

    function applyServerList(videos) {
        const serverIds = new Set();

        videos.forEach(function (video) {
            if (!video || !Number.isInteger(video.id)) {
                return;
            }

            serverIds.add(video.id);
            setActive(video.id, clampProgress(video.progress), video.upload_id, false);
        });

        Array.from(active.keys()).forEach(function (id) {
            if (!serverIds.has(id)) {
                finish(id);
            }
        });

        scheduleRender(true);
        checkDone(true);
    }

    async function reconcile() {
        if (!countUrl) {
            return;
        }

        if (inFlight) {
            queued = true;
            return;
        }

        inFlight = true;
        let resolveInFlight;
        inFlightPromise = new Promise(function (resolve) {
            resolveInFlight = resolve;
        });
        let ok = false;

        try {
            const response = await fetch(countUrl, {
                headers: { 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
                credentials: 'same-origin',
            });

            if (response.ok && !response.redirected) {
                const data = await response.json();

                if (Array.isArray(data.videos)) {
                    ok = true;
                    applyServerList(data.videos);
                }
            }
        } catch (err) {
            // Best-effort: the next event, reconnect or tab focus will reconcile again.
        } finally {
            inFlight = false;
            inFlightPromise = null;
            resolveInFlight();

            // Server unreachable: do not keep the ring stuck, fall back to the local hold.
            if (!ok) {
                checkDone(true);
            }

            if (queued) {
                queued = false;
                scheduleReconcile();
            }
        }
    }

    function scheduleReconcile() {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(reconcile, DEBOUNCE_MS);
    }

    function handleStatusUpdated(e) {
        if (!e || !Number.isInteger(e.videoId)) {
            return;
        }

        let needsReconcile = false;

        if (e.status === 'processing' || e.status === 'pending') {
            needsReconcile = !active.has(e.videoId) && !finished.has(e.videoId);

            const progress = e.progress == null ? (active.get(e.videoId) || 0) : clampProgress(e.progress);

            const hasUploadId = typeof e.uploadId === 'string' && e.uploadId !== '';

            setActive(e.videoId, progress, hasUploadId ? e.uploadId : null, !hasUploadId);
        } else if (e.status === 'ready' || e.status === 'failed') {
            finish(e.videoId);
            needsReconcile = true;
        } else {
            return;
        }

        scheduleRender(false);

        if (needsReconcile) {
            scheduleReconcile();
        }

        checkDone(false);
    }

    let wasConnected = false;

    function handleConnectionStateChange(states) {
        if (states.current === 'connected') {
            if (wasConnected && states.previous !== 'connected') {
                scheduleReconcile();
            }
            wasConnected = true;
        }
    }

    function start() {
        if (!window.Echo) {
            return;
        }

        window.Echo.channel('videos').listen(EVENT, handleStatusUpdated);

        const pusher = window.Echo.connector && window.Echo.connector.pusher;

        if (pusher) {
            pusher.connection.bind('state_change', handleConnectionStateChange);
            wasConnected = pusher.connection.state === 'connected';
        }
    }

    // The Upload page changed its registry: re-render (throttled) and make sure a running hold is cancelled / a finished batch is re-checked.
    window.addEventListener('upload-registry:update', function () {
        scheduleRender(false);
        checkDone(false);
    });

    document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'visible') {
            scheduleReconcile();
        }
    });

    restoreBatch();

    try {
        const initial = JSON.parse(ring.dataset.videos || '[]');

        if (Array.isArray(initial)) {
            initial.forEach(function (video) {
                if (video && Number.isInteger(video.id)) {
                    setActive(video.id, clampProgress(video.progress), video.upload_id, false);
                }
            });
        }
    } catch (err) {
        // Malformed initial data: the first reconcile will fill the state.
    }

    render();
    checkDone(false);

    if (window.Echo) {
        start();
    } else {
        document.addEventListener('DOMContentLoaded', start);
    }
}
