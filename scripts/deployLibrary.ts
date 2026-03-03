import { beginCell, internal, SendMode, Cell } from '@ton/core';
import { compile, NetworkProvider, sleep } from '@ton/blueprint';
import { mnemonicToPrivateKey } from '@ton/crypto';
import { TonClient4, WalletContractV4, WalletContractV5R1 } from '@ton/ton';

import { Librarian } from '../wrappers/Librarian';
import { JettonMinter } from '../wrappers/03_notcoin/JettonMinter';
import { formatTon, parseAddress, parseTon } from './utils';

function parseLibraryHashFromLibRefCell(libRef: Cell): Buffer {
    const s = libRef.beginParse(true);
    const tag = s.loadUint(8);
    if (tag !== 2) {
        throw new Error(`Unexpected exotic tag for library reference: ${tag} (expected 2)`);
    }
    const hash = s.loadBuffer(32);
    if (s.remainingBits !== 0 || s.remainingRefs !== 0) {
        throw new Error('Invalid library reference cell: trailing data');
    }
    return hash;
}

async function sendDeployFromBlueprintMnemonic(provider: NetworkProvider, params: { to: import('@ton/core').Address; value: bigint; init: import('@ton/core').StateInit }) {
    const mnemonic = process.env.WALLET_MNEMONIC?.trim();
    const walletVersion = process.env.WALLET_VERSION?.trim().toLowerCase();
    if (!mnemonic || !walletVersion) {
        throw new Error('This script requires blueprint mnemonic deployer (WALLET_MNEMONIC + WALLET_VERSION).');
    }

    const { secretKey, publicKey } = await mnemonicToPrivateKey(mnemonic.split(' '));

    const api = provider.api();
    const client = api instanceof TonClient4
        ? api
        : new TonClient4({
            endpoint: provider.network() === 'testnet' ? 'https://testnet-v4.tonhubapi.com' : 'https://mainnet-v4.tonhubapi.com',
        });

    if (walletVersion === 'v5r1') {
        const subwalletNumber = Number.parseInt((process.env.SUBWALLET_NUMBER ?? '0').trim(), 10);
        if (!Number.isFinite(subwalletNumber)) {
            throw new Error('Invalid SUBWALLET_NUMBER');
        }

        const wallet = client.open(WalletContractV5R1.create({
            publicKey,
            walletId: {
                networkGlobalId: provider.network() === 'testnet' ? -3 : -239,
                context: { workchain: 0, subwalletNumber, walletVersion: 'v5r1' },
            },
        }));

        await wallet.sendTransfer({
            seqno: await wallet.getSeqno(),
            secretKey,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            messages: [internal({ to: params.to, value: params.value, bounce: false, init: params.init, body: beginCell().endCell() })],
        });
        return;
    }

    if (walletVersion === 'v4' || walletVersion === 'v4r2' || walletVersion === 'v4r1') {
        const walletIdRaw = process.env.WALLET_ID?.trim();
        const walletId = walletIdRaw ? Number.parseInt(walletIdRaw, 10) : undefined;
        if (walletIdRaw && !Number.isFinite(walletId)) {
            throw new Error('Invalid WALLET_ID');
        }

        const wallet = client.open(WalletContractV4.create({
            workchain: 0,
            publicKey,
            walletId,
        }));

        await wallet.sendTransfer({
            seqno: await wallet.getSeqno(),
            secretKey,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            messages: [internal({ to: params.to, value: params.value, bounce: false, init: params.init, body: beginCell().endCell() })],
        });
        return;
    }

    throw new Error(`Unsupported WALLET_VERSION: ${walletVersion}`);
}

async function promptDeployValueTon(provider: NetworkProvider): Promise<bigint> {
    const raw = process.env.LIBRARY_DEPLOY_VALUE_TON?.trim();
    if (raw) {
        return parseTon(raw, 'LIBRARY_DEPLOY_VALUE_TON');
    }

    const ui = provider.ui();
    // eslint-disable-next-line no-constant-condition
    while (true) {
        const input = (await ui.input('Deploy value (TON): ')).trim();
        try {
            const value = parseTon(input, 'deploy value');
            if (value <= 0n) {
                ui.write('Value must be positive.\n');
                continue;
            }
            return value;
        } catch (e) {
            ui.write((e instanceof Error ? e.message : String(e)) + '\n');
        }
    }
}

export async function run(provider: NetworkProvider) {
    const ui = provider.ui();
    ui.write('This jetton uses JettonWallet code from an on-chain public library.');
    ui.write('Librarian is a helper contract that publishes the library on masterchain and then bricks itself.');
    ui.write('Note: Librarian reserves storage for a very long period (100 years). This can require ~1200 TON+ on masterchain depending on code size.');

    const jettonWalletCodeRaw = await compile('03_notcoin/JettonWallet');
    const librarianCode = await compile('Librarian');

    const tonAmount = await promptDeployValueTon(provider);
    const librarian = provider.open(Librarian.createFromConfig({ code: jettonWalletCodeRaw }, librarianCode));

    ui.write(`\nJettonWallet code hash: ${jettonWalletCodeRaw.hash().toString('hex')}`);
    ui.write(`Librarian address:      ${librarian.address.toString()}`);
    ui.write(`Deploy value:           ${formatTon(tonAmount)}\n`);

    const minterAddressRaw = process.env.JETTON_MINTER_ADDRESS?.trim();
    if (minterAddressRaw) {
        const jettonMinter = provider.open(JettonMinter.createFromAddress(parseAddress(minterAddressRaw, 'JETTON_MINTER_ADDRESS')));
        const { walletCode } = await jettonMinter.getJettonData();

        const expectedHash = walletCode.isExotic ? parseLibraryHashFromLibRefCell(walletCode) : walletCode.hash();
        ui.write(`JettonMinter wallet_code hash: ${expectedHash.toString('hex')}\n`);

        if (!expectedHash.equals(jettonWalletCodeRaw.hash())) {
            throw new Error(
                [
                    'JettonMinter expects a different JettonWallet code hash.',
                    'Publish the exact code version used when deploying JettonMinter, or redeploy JettonMinter with current code.',
                ].join(' '),
            );
        }
    }

    const stateBefore = await librarian.getState();
    const lastLt = stateBefore.last?.lt ?? 0n;
    let emptyCell = new Cell();
    if (stateBefore.state.type === 'active') {
        if (stateBefore.state.code && stateBefore.state.data) {
            const codeCell = Cell.fromBoc(stateBefore.state.code)[0];
            const dataCell = Cell.fromBoc(stateBefore.state.data)[0];
            if (codeCell.equals(emptyCell) && dataCell.equals(emptyCell)) {
                ui.write('Library is already deployed (Librarian is bricked).');
                return;
            }
        }
    }

    ui.write('Sending deploy message (bounce=false)...');
    if (!librarian.init) {
        throw new Error('Librarian init is missing');
    }
    await sendDeployFromBlueprintMnemonic(provider, { to: librarian.address, value: tonAmount, init: librarian.init });

    ui.write('Waiting for the library to be published...');

    let retryCount = 60;

    do {
        await sleep(2000);
        const curState = await librarian.getState();
        const curLt = curState.last?.lt ?? 0n;

        if (curState.state.type === 'active' && curLt > lastLt) {
            if (!curState.state.code || !curState.state.data) {
                ui.write('Unexpected active state without code/data.');
                return;
            }
            const codeCell = Cell.fromBoc(curState.state.code)[0];
            const dataCell = Cell.fromBoc(curState.state.data)[0];

            if (codeCell.equals(emptyCell) && dataCell.equals(emptyCell)) {
                ui.write('Library published successfully!');
                return;
            }

            ui.write('Librarian is deployed but not bricked, so the library was NOT published.');
            ui.write(`Current Librarian balance: ${formatTon(curState.balance)}`);
            ui.write('Increase LIBRARY_DEPLOY_VALUE_TON and rerun this script (funds stay on the Librarian and will be used for the next attempt).');
            return;
        }
    } while(retryCount--);

    throw new Error("Transaction didn't show up on Librarian account during 2 minutes. Something went wrong.");
}
