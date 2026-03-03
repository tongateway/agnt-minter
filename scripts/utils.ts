import { Address, toNano } from '@ton/core';
import { fromNano } from '@ton/ton';
import { getSecureRandomBytes, keyPairFromSeed, KeyPair } from '@ton/crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import path from 'path';

export function formatTon(nanoTon: bigint): string {
    return `${fromNano(nanoTon)} TON (${nanoTon} nanoTON)`;
}

export function publicKeyToBigInt(publicKey: Uint8Array): bigint {
    return BigInt(`0x${Buffer.from(publicKey).toString('hex')}`);
}

export async function createRandomKeyPair(): Promise<KeyPair> {
    return keyPairFromSeed(await getSecureRandomBytes(32));
}

export function saveKeyPair(keys: KeyPair, filepath: string): void {
    mkdirSync(path.dirname(filepath), { recursive: true });
    const data = {
        publicKey: Buffer.from(keys.publicKey).toString('hex'),
        secretKey: Buffer.from(keys.secretKey).toString('hex'),
    };
    writeFileSync(filepath, JSON.stringify(data, null, 2));
}

export function loadKeyPair(filepath: string): KeyPair | null {
    if (!existsSync(filepath)) {
        return null;
    }

    const raw = readFileSync(filepath, 'utf-8');
    const data = JSON.parse(raw) as { publicKey?: string; secretKey?: string };

    if (!data.publicKey || !data.secretKey) {
        throw new Error(`Invalid key file: ${filepath}`);
    }

    return {
        publicKey: Buffer.from(data.publicKey, 'hex'),
        secretKey: Buffer.from(data.secretKey, 'hex'),
    };
}

export async function getOrCreateKeyPair(filepath: string): Promise<KeyPair> {
    const existing = loadKeyPair(filepath);
    if (existing) {
        return existing;
    }

    const created = await createRandomKeyPair();
    saveKeyPair(created, filepath);
    return created;
}

export function displayPublicKeyInfo(keys: KeyPair): void {
    console.log('Public key (hex):   ', Buffer.from(keys.publicKey).toString('hex'));
    console.log('Public key (uint256):', `0x${publicKeyToBigInt(keys.publicKey).toString(16)}`);
}

export function requireEnv(name: string): string {
    const value = process.env[name]?.trim();
    if (!value) {
        throw new Error(`${name} environment variable not set`);
    }
    return value;
}

export function requireEnvOneOf(names: string[]): { name: string; value: string } {
    for (const name of names) {
        const value = process.env[name]?.trim();
        if (value) {
            return { name, value };
        }
    }
    throw new Error(`Missing environment variable (one of: ${names.join(', ')})`);
}

export function parseAddress(raw: string, label: string): Address {
    try {
        return Address.parse(raw);
    } catch {
        throw new Error(`Invalid ${label}: ${raw}`);
    }
}

export function parseTon(raw: string, label: string): bigint {
    try {
        return toNano(raw);
    } catch {
        throw new Error(`Invalid ${label} (TON string): ${raw}`);
    }
}

export function parseBigInt(raw: string, label: string): bigint {
    const value = raw.trim();
    if (!value) {
        throw new Error(`${label} is empty`);
    }

    if (value.startsWith('0x') || value.startsWith('0X')) {
        return BigInt(value);
    }

    if (/^-?[0-9]+$/.test(value)) {
        return BigInt(value);
    }

    throw new Error(`Invalid ${label} (bigint string): ${raw}`);
}

export function parseBoolean(raw: string, label: string): boolean {
    const value = raw.trim().toLowerCase();
    if (value === 'true' || value === '1') {
        return true;
    }
    if (value === 'false' || value === '0') {
        return false;
    }
    throw new Error(`Invalid ${label} (expected true/false): ${raw}`);
}

export function hexToBuffer(raw: string, expectedBytes: number, label: string): Buffer {
    const value = raw.trim().toLowerCase().replace(/^0x/, '');
    if (!/^[0-9a-f]*$/.test(value)) {
        throw new Error(`Invalid ${label} (hex expected)`);
    }

    const buf = Buffer.from(value, 'hex');
    if (buf.length !== expectedBytes) {
        throw new Error(`Invalid ${label} length: expected ${expectedBytes} bytes, got ${buf.length}`);
    }

    return buf;
}
