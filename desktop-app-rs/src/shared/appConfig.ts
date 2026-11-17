/** Response of `GET /api/app/config` (spec 3.5). Lives in RAM only; never sent to the renderer. */
export interface AppConfigR2 {
    access_key_id: string;
    secret_access_key: string;
    bucket: string;
    endpoint: string;
    url: string;
}

export interface AppConfigTranscode {
    resolution: '480' | '720' | '1080';
    segment_seconds: number;
    /** Null keeps the source frame rate. */
    fps: number | null;
}

export interface AppConfig {
    r2: AppConfigR2;
    transcode: AppConfigTranscode;
}
