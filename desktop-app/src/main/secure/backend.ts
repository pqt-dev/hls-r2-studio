/** Abstraction over Electron safeStorage so the vault can be tested with a fake. */
export interface SecureBackend {
    isAvailable(): boolean;
    encrypt(plain: string): Buffer;
    decrypt(data: Buffer): string;
}

/** Structural subset of Electron's `safeStorage`. */
export interface SafeStorageLike {
    isEncryptionAvailable(): boolean;
    encryptString(plainText: string): Buffer;
    decryptString(encrypted: Buffer): string;
}

export function createSafeStorageBackend(safeStorage: SafeStorageLike): SecureBackend {
    return {
        isAvailable: () => safeStorage.isEncryptionAvailable(),
        encrypt: (plain) => safeStorage.encryptString(plain),
        decrypt: (data) => safeStorage.decryptString(data),
    };
}
