import { ErrorIcon, SuccessIcon } from './icons';

export interface FeedbackMessage {
    kind: 'success' | 'error';
    text: string;
}

/** Inline result of a save action, announced to screen readers. */
export function Feedback({ message }: { message: FeedbackMessage | null }) {
    if (message === null) return <p className="feedback" role="status" />;

    return (
        <p
            className={`feedback feedback-${message.kind}`}
            role={message.kind === 'error' ? 'alert' : 'status'}
        >
            {message.kind === 'success' ? <SuccessIcon /> : <ErrorIcon />}
            {message.text}
        </p>
    );
}
