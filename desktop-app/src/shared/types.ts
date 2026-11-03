/** Job lifecycle states (spec 4.3 / 4.5). Queue logic is implemented in step B4. */
export type JobState =
    | 'waiting'
    | 'transcoding'
    | 'thumbnail'
    | 'storyboard'
    | 'uploading'
    | 'registering'
    | 'done'
    | 'failed'
    | 'cancelled'
    | 'interrupted'
    /** Files are on R2 but the site register call failed; retry finishes it without re-uploading. */
    | 'register_failed'
    /** Like register_failed, but the site rejected the token; retried automatically after sign-in. */
    | 'needs_sign_in';

/** Result of a successful `POST /api/app/videos`. */
export interface RegisteredRecord {
    id: number;
    public_id: string;
    embed_url: string;
}

/** Details shown in the "View details" dialog of a failed job. Text is already redacted. */
export interface JobErrorDetail {
    /** Pipeline step that failed. */
    step: JobState;
    exitCode: number | null;
    /** Last ~200 lines of ffmpeg stderr. */
    stderrTail: string[];
}

export interface JobRecord {
    id: string;
    sourcePath: string;
    /** Source file size in bytes, recorded when the job was added. */
    sizeBytes: number;
    state: JobState;
    publicId: string | null;
    prefix: string | null;
    errorMessage: string | null;
    errorDetail: JobErrorDetail | null;
    /** ISO 8601 timestamps. */
    createdAt: string;
    updatedAt: string;
    startedAt: string | null;
    finishedAt: string | null;
    /**
     * Origin (`https://host`) of the site this job was started for. Missing on records written
     * by older versions (those are not bound to a site).
     */
    siteOrigin?: string;
    /** Body for POST /api/app/videos, kept so register can be retried without re-uploading. */
    registerPayload?: RegisterPayloadRecord | null;
    /** Set when the job is done. */
    registered: RegisteredRecord | null;
}

/** Persisted copy of the register body (see main/pipeline/register.ts `RegisterPayload`). */
export interface RegisterPayloadRecord {
    public_id: string;
    title: string;
    original_filename: string;
    original_size_bytes: number;
    disk_prefix: string;
    playlist_path: string;
    thumbnail_path: string | null;
    storyboards: Record<string, { path: string }> | null;
    duration: number | null;
    output_width: number | null;
    output_height: number | null;
    output_fps: number | null;
    output_bitrate_kbps: number | null;
    output_codec: string | null;
}

export interface AppSettings {
    siteUrl: string;
    tmpRoot: string;
    /** Concurrent jobs, 1..2. */
    maxConcurrent: number;
    /** Name of the signed-in user (not a secret); lets the UI show it after a restart. */
    username?: string;
}

/** Shape of the persisted JSON file. */
export interface AppData {
    schemaVersion: number;
    settings: AppSettings;
    jobs: JobRecord[];
}
