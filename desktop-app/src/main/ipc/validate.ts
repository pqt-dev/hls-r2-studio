export class IpcValidationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'IpcValidationError';
    }
}

/** Channels without a payload must be invoked with no arguments. */
export function expectNoArgs(args: readonly unknown[]): void {
    if (args.length !== 0) {
        throw new IpcValidationError('Unexpected arguments');
    }
}

export function expectString(value: unknown, name: string, maxLength = 2048): string {
    if (typeof value !== 'string') {
        throw new IpcValidationError(`${name} must be a string`);
    }
    if (value.length > maxLength) {
        throw new IpcValidationError(`${name} is too long`);
    }
    return value;
}

export function expectPlainObject(value: unknown, name: string): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new IpcValidationError(`${name} must be an object`);
    }
    return value as Record<string, unknown>;
}

export function expectBoolean(value: unknown, name: string): boolean {
    if (typeof value !== 'boolean') throw new IpcValidationError(`${name} must be a boolean`);

    return value;
}

/** Integer within [min, max]. */
export function expectInt(value: unknown, name: string, min: number, max: number): number {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
        throw new IpcValidationError(`${name} must be an integer from ${min} to ${max}`);
    }

    return value;
}

export function expectOneOf<T extends string>(
    value: unknown,
    name: string,
    allowed: readonly T[],
): T {
    if (typeof value !== 'string' || !allowed.includes(value as T)) {
        throw new IpcValidationError(`${name} is not an allowed value`);
    }

    return value as T;
}

export function expectStringArray(
    value: unknown,
    name: string,
    maxItems: number,
    maxLength = 4096,
): string[] {
    if (!Array.isArray(value)) throw new IpcValidationError(`${name} must be an array`);
    if (value.length > maxItems) throw new IpcValidationError(`${name} has too many items`);

    return value.map((item, index) => expectString(item, `${name}[${index}]`, maxLength));
}

const JOB_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function expectJobId(value: unknown, name = 'id'): string {
    const id = expectString(value, name, 64);

    if (!JOB_ID_PATTERN.test(id)) throw new IpcValidationError(`${name} is not valid`);

    return id;
}

/** A single payload argument that must be a plain object with only the allowed keys. */
export function expectSingleObject(
    args: readonly unknown[],
    name: string,
    allowedKeys: readonly string[],
): Record<string, unknown> {
    if (args.length !== 1) throw new IpcValidationError(`${name} expects exactly one argument`);

    const object = expectPlainObject(args[0], name);

    for (const key of Object.keys(object)) {
        if (!allowedKeys.includes(key)) {
            throw new IpcValidationError(`${name} has an unexpected property`);
        }
    }

    return object;
}
