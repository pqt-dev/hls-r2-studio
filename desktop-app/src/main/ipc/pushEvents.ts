import { IpcEvents } from '../../shared/ipc';
import type { AuthState, JobDto, QueueSummary } from '../../shared/ipc';

export interface PushSources {
    auth: { subscribe(listener: (state: AuthState) => void): () => void };
    queue: {
        subscribe(listener: (jobs: JobDto[]) => void): () => void;
        subscribeSummary(listener: (summary: QueueSummary) => void): () => void;
    };
}

/** Forwards state changes to the renderer. `send` must drop the message if no window exists. */
export function wirePushEvents(
    sources: PushSources,
    send: (channel: string, payload: unknown) => void,
): () => void {
    const unsubscribers = [
        sources.auth.subscribe((state) => send(IpcEvents.authChanged, state)),
        sources.queue.subscribe((jobs) => send(IpcEvents.jobsUpdated, jobs)),
        sources.queue.subscribeSummary((summary) => send(IpcEvents.queueSummary, summary)),
    ];

    return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
}
