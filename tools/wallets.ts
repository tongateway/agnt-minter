import { mnemonicNew, mnemonicToPrivateKey } from '@ton/crypto';
import { WalletContractV4, WalletContractV5R1 } from '@ton/ton';
import { Address } from '@ton/core';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';

type WalletVersion = 'v4' | 'v5r1';

type WalletProfile = {
    mnemonic: string;
    walletVersion: WalletVersion;
    workchain: number;
    walletId?: number;
    subwalletNumber?: number;
};

type WalletStore = {
    version: 1;
    profiles: Record<string, WalletProfile>;
};

const STORE_PATH = path.join(process.cwd(), '.local', 'wallets.json');
const ENV_PATH = path.join(process.cwd(), '.env');

function readJson(filepath: string): unknown {
    return JSON.parse(readFileSync(filepath, 'utf-8'));
}

function writeJson(filepath: string, data: unknown): void {
    mkdirSync(path.dirname(filepath), { recursive: true });
    writeFileSync(filepath, JSON.stringify(data, null, 2));
}

function loadStore(): WalletStore | null {
    if (!existsSync(STORE_PATH)) {
        return null;
    }
    const raw = readJson(STORE_PATH) as Partial<WalletStore>;
    if (raw.version !== 1 || !raw.profiles) {
        throw new Error(`Invalid store format: ${STORE_PATH}`);
    }
    return raw as WalletStore;
}

function saveStore(store: WalletStore): void {
    writeJson(STORE_PATH, store);
}

async function createProfile(params: { walletVersion: WalletVersion; workchain: number; walletId?: number; subwalletNumber?: number }): Promise<WalletProfile> {
    const words = await mnemonicNew(24);
    const mnemonic = words.join(' ');
    return {
        mnemonic,
        walletVersion: params.walletVersion,
        workchain: params.workchain,
        walletId: params.walletId,
        subwalletNumber: params.subwalletNumber,
    };
}

async function profileAddresses(profile: WalletProfile): Promise<{ testnet: Address; mainnet: Address }> {
    const keyPair = await mnemonicToPrivateKey(profile.mnemonic.split(' '));

    if (profile.walletVersion === 'v5r1') {
        const workchain = profile.workchain ?? 0;
        const subwalletNumber = profile.subwalletNumber ?? 0;

        const testnet = WalletContractV5R1.create({
            publicKey: keyPair.publicKey,
            walletId: {
                networkGlobalId: -3,
                context: { workchain, subwalletNumber, walletVersion: 'v5r1' },
            },
        }).address;

        const mainnet = WalletContractV5R1.create({
            publicKey: keyPair.publicKey,
            walletId: {
                networkGlobalId: -239,
                context: { workchain, subwalletNumber, walletVersion: 'v5r1' },
            },
        }).address;

        return { testnet, mainnet };
    }

    const v4 = WalletContractV4.create({
        workchain: profile.workchain ?? 0,
        publicKey: keyPair.publicKey,
        walletId: profile.walletId,
    }).address;

    return { testnet: v4, mainnet: v4 };
}

function formatAddress(address: Address, params: { testOnly: boolean }): string {
    return address.toString({ bounceable: false, testOnly: params.testOnly });
}

function parseArgs(argv: string[]) {
    const args = [...argv];
    const command = args.shift();
    const rest: string[] = [];
    const flags: Record<string, string | true> = {};

    while (args.length > 0) {
        const token = args.shift()!;
        if (token.startsWith('--')) {
            const key = token.slice(2);
            const next = args[0];
            if (next && !next.startsWith('--')) {
                flags[key] = args.shift()!;
            } else {
                flags[key] = true;
            }
        } else {
            rest.push(token);
        }
    }

    return { command, rest, flags };
}

function updateDotEnvFile(params: { set: Record<string, string>; unset: string[] }) {
    const existing = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf-8') : '';
    const lines = existing.length > 0 ? existing.split(/\r?\n/) : [];

    const keysToReplace = new Set(Object.keys(params.set));
    const keysToUnset = new Set(params.unset);
    const replaced = new Set<string>();

    const out: string[] = [];

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) {
            out.push(line);
            continue;
        }

        const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
        if (!m) {
            out.push(line);
            continue;
        }

        const key = m[1];
        if (keysToUnset.has(key)) {
            continue;
        }

        if (keysToReplace.has(key)) {
            out.push(`${key}=${params.set[key]}`);
            replaced.add(key);
            continue;
        }

        out.push(line);
    }

    for (const [key, value] of Object.entries(params.set)) {
        if (!replaced.has(key)) {
            out.push(`${key}=${value}`);
        }
    }

    writeFileSync(ENV_PATH, out.join('\n').replace(/\n+$/, '') + '\n');
}

async function main() {
    const { command, rest, flags } = parseArgs(process.argv.slice(2));

    if (!command || command === 'help') {
        console.log('Usage:');
        console.log('  npx ts-node tools/wallets.ts init [--wallet-version v5r1|v4]');
        console.log('  npx ts-node tools/wallets.ts show');
        console.log('  npx ts-node tools/wallets.ts use <admin|user> [--network testnet|mainnet]');
        console.log('');
        console.log('Notes:');
        console.log(`  - Wallet mnemonics are stored in: ${STORE_PATH}`);
        console.log(`  - Active blueprint mnemonic is written to: ${ENV_PATH}`);
        process.exit(0);
    }

    if (command === 'init') {
        const walletVersion = ((flags['wallet-version'] as string | undefined) ?? 'v5r1').toLowerCase();
        if (walletVersion !== 'v5r1' && walletVersion !== 'v4') {
            throw new Error('--wallet-version must be v5r1 or v4');
        }

        const store: WalletStore = loadStore() ?? { version: 1, profiles: {} };
        if (!store.profiles.admin) {
            store.profiles.admin = await createProfile({ walletVersion, workchain: 0, subwalletNumber: 0 });
        }
        if (!store.profiles.user) {
            store.profiles.user = await createProfile({ walletVersion, workchain: 0, subwalletNumber: 0 });
        }
        saveStore(store);

        console.log('\nWallet profiles created/updated.');
        console.log('Store file:', STORE_PATH);
        console.log('Keep it private. Do not commit it.\n');

        for (const name of ['admin', 'user'] as const) {
            const profile = store.profiles[name];
            const addr = await profileAddresses(profile);
            console.log(`[${name}] ${profile.walletVersion}`);
            console.log('  testnet:', formatAddress(addr.testnet, { testOnly: true }));
            console.log('  mainnet:', formatAddress(addr.mainnet, { testOnly: false }));
        }
        return;
    }

    if (command === 'show') {
        const store = loadStore();
        if (!store) {
            throw new Error(`Store not found: ${STORE_PATH}. Run "init" first.`);
        }

        console.log('');
        for (const [name, profile] of Object.entries(store.profiles)) {
            const addr = await profileAddresses(profile);
            console.log(`[${name}] ${profile.walletVersion}`);
            console.log('  testnet:', formatAddress(addr.testnet, { testOnly: true }));
            console.log('  mainnet:', formatAddress(addr.mainnet, { testOnly: false }));
        }
        return;
    }

    if (command === 'use') {
        const profileName = rest[0];
        if (!profileName) {
            throw new Error('Profile name required: use <admin|user>');
        }

        const store = loadStore();
        if (!store) {
            throw new Error(`Store not found: ${STORE_PATH}. Run "init" first.`);
        }

        const profile = store.profiles[profileName];
        if (!profile) {
            throw new Error(`Profile not found: ${profileName}`);
        }

        const addr = await profileAddresses(profile);
        const network = ((flags['network'] as string | undefined) ?? 'testnet').toLowerCase();
        if (network !== 'testnet' && network !== 'mainnet') {
            throw new Error('--network must be testnet or mainnet');
        }

        const set: Record<string, string> = {
            WALLET_VERSION: profile.walletVersion,
            WALLET_MNEMONIC: JSON.stringify(profile.mnemonic),
        };
        const unset: string[] = [];

        if (profile.walletVersion === 'v5r1') {
            set.SUBWALLET_NUMBER = String(profile.subwalletNumber ?? 0);
            unset.push('WALLET_ID');
        } else {
            unset.push('SUBWALLET_NUMBER');
            if (profile.walletId !== undefined) {
                set.WALLET_ID = String(profile.walletId);
            } else {
                unset.push('WALLET_ID');
            }
        }

        updateDotEnvFile({ set, unset });

        console.log('\nBlueprint wallet configured in .env:');
        console.log('  WALLET_VERSION=', profile.walletVersion);
        console.log('  WALLET_MNEMONIC= <saved in .env>');
        if (profile.walletVersion === 'v5r1') {
            console.log('  SUBWALLET_NUMBER=', String(profile.subwalletNumber ?? 0));
        }

        const selectedAddress = network === 'testnet' ? addr.testnet : addr.mainnet;
        console.log('\nFund this address:');
        console.log(`  ${formatAddress(selectedAddress, { testOnly: network === 'testnet' })}`);
        return;
    }

    throw new Error(`Unknown command: ${command}`);
}

main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
});

