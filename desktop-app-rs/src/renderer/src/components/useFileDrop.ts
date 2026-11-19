import { useEffect, useRef, useState, type RefObject } from 'react';

/** Whether a drag carries files; drags without type info (the Tauri bridge) count as files. */
function carriesFiles(event: DragEvent): boolean {
    const types = event.dataTransfer?.types;

    return types === undefined || types.length === 0 || Array.from(types).includes('Files');
}

/**
 * Drag-and-drop of files onto ONE target element (`ref` goes on it). Only the target accepts
 * drops: `dragging` is true only while the pointer is actually over it, and a drop anywhere else
 * adds nothing (its default is still prevented so the webview does not open the file).
 *
 * The listeners are on the document (capture) and compute "is the event target inside the
 * target element" on every `dragenter`/`dragover`, instead of counting enter/leave: the Tauri
 * bridge re-dispatches its single `enter` and the following `over` events as DOM events at the
 * element under the pointer (with an empty DataTransfer), and moving off the target never fires a
 * `dragleave` on it. The state also ends on a `dragleave` aimed at body/html (pointer left the
 * window), on any `drop` and on `dragend`. Each handler returns early when the drag has no files.
 */
export function useFileDrop(onFiles: (files: File[]) => void): {
    dragging: boolean;
    ref: RefObject<HTMLDivElement | null>;
} {
    const [dragging, setDragging] = useState(false);
    const ref = useRef<HTMLDivElement>(null);
    const onFilesRef = useRef(onFiles);

    useEffect(() => {
        onFilesRef.current = onFiles;
    });

    useEffect(() => {
        const isOver = (event: Event): boolean =>
            event.target instanceof Node && ref.current?.contains(event.target) === true;

        const onMove = (event: DragEvent): void => {
            if (!carriesFiles(event)) return;

            // Allow the drop (and stop the webview navigating to the file) everywhere.
            event.preventDefault();

            const over = isOver(event);

            if (over && event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
            else if (event.dataTransfer) event.dataTransfer.dropEffect = 'none';

            setDragging(over);
        };
        const onLeave = (event: DragEvent): void => {
            if (event.target === document.body || event.target === document.documentElement) {
                setDragging(false);
            }
        };
        const onDrop = (event: DragEvent): void => {
            if (!carriesFiles(event)) return;

            event.preventDefault();
            setDragging(false);

            if (!isOver(event)) return;

            // Called even with an empty list: the Tauri bridge may hold the paths itself.
            onFilesRef.current(Array.from(event.dataTransfer?.files ?? []));
        };
        const onEnd = (): void => setDragging(false);

        document.addEventListener('dragenter', onMove, true);
        document.addEventListener('dragover', onMove, true);
        document.addEventListener('dragleave', onLeave, true);
        document.addEventListener('drop', onDrop, true);
        document.addEventListener('dragend', onEnd, true);

        return () => {
            document.removeEventListener('dragenter', onMove, true);
            document.removeEventListener('dragover', onMove, true);
            document.removeEventListener('dragleave', onLeave, true);
            document.removeEventListener('drop', onDrop, true);
            document.removeEventListener('dragend', onEnd, true);
        };
    }, []);

    return { dragging, ref };
}
