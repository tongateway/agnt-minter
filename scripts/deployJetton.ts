import { beginCell, Cell } from '@ton/core';
import { compile, NetworkProvider } from '@ton/blueprint';

import { JettonMinter, jettonContentToCell } from '../wrappers/03_notcoin/JettonMinter';
import { formatTon, parseAddress, parseTon } from './utils';

function libraryRefFromCode(code: Cell): Cell {
    const prep = beginCell().storeUint(2, 8).storeBuffer(code.hash()).endCell();
    return new Cell({ exotic: true, bits: prep.bits, refs: prep.refs });
}

export async function run(provider: NetworkProvider) {
    const sender = provider.sender();
    if (!sender.address) {
        throw new Error('Wallet address not found');
    }

    const walletCodeMode = (process.env.JETTON_WALLET_CODE_MODE ?? 'library').trim().toLowerCase();
    if (walletCodeMode !== 'library' && walletCodeMode !== 'raw') {
        throw new Error('JETTON_WALLET_CODE_MODE must be "library" or "raw"');
    }

    const jettonContentUri = process.env.JETTON_CONTENT_URI?.trim() || 'ipfs://jetton-metadata';
    const deployValue = parseTon(process.env.DEPLOY_VALUE_TON ?? '2', 'DEPLOY_VALUE_TON');

    const adminAddress = (() => {
        const raw = process.env.JETTON_ADMIN_ADDRESS?.trim();
        if (raw) {
            return parseAddress(raw, 'JETTON_ADMIN_ADDRESS');
        }
        return sender.address!;
    })();

    console.log('\n=== Deploy JettonMinter (03_notcoin) ===\n');
    console.log('Network:           ', provider.network());
    console.log('Deployer wallet:   ', sender.address.toString());
    console.log('Jetton admin:      ', adminAddress.toString());
    console.log('Wallet code mode:  ', walletCodeMode);
    console.log('Jetton content URI:', jettonContentUri);

    const jettonWalletCodeRaw = await compile('03_notcoin/JettonWallet');
    const jettonWalletCode = walletCodeMode === 'library'
        ? libraryRefFromCode(jettonWalletCodeRaw)
        : jettonWalletCodeRaw;

    console.log('JettonWallet code hash:', jettonWalletCodeRaw.hash().toString('hex'));
    if (walletCodeMode === 'library') {
        console.log('Note: "library" mode requires this code hash to be available as a public library on-chain.');
    }

    const jettonMinterCode = await compile('03_notcoin/JettonMinter');
    const jettonMinter = provider.open(JettonMinter.createFromConfig(
        {
            admin: adminAddress,
            nextAdmin: null,
            wallet_code: jettonWalletCode,
            jetton_content: jettonContentToCell({ uri: jettonContentUri }),
        },
        jettonMinterCode,
    ));

    console.log('\nJettonMinter address:', jettonMinter.address.toString());
    console.log('Deploy value:       ', formatTon(deployValue));

    await jettonMinter.sendDeploy(sender, deployValue);
    await provider.waitForDeploy(jettonMinter.address);

    const adminNow = await jettonMinter.getAdminAddress();
    console.log('\nDeployed.');
    console.log('JettonMinter admin:', adminNow?.toString() ?? 'null');

    console.log('\nExports:');
    console.log(`  export JETTON_MINTER_ADDRESS="${jettonMinter.address.toString()}"`);
}
