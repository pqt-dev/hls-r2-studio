import type { RegisterFailure } from './register';

/** Error a RegisterClient throws: either no HTTP response or a status (+ error code). */
export class RegisterRequestError extends Error {
    readonly failure: RegisterFailure;

    constructor(failure: RegisterFailure, message?: string) {
        super(message ?? (failure.kind === 'network' ? 'network error' : `HTTP ${failure.status}`));
        this.name = 'RegisterRequestError';
        this.failure = failure;
    }
}

/** Anything that is not a RegisterRequestError is treated as a (retryable) network failure. */
export function toRegisterFailure(error: unknown): RegisterFailure {
    return error instanceof RegisterRequestError ? error.failure : { kind: 'network' };
}
