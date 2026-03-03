import { NetworkProvider } from '@ton/blueprint';
import { JettonMinter } from '../wrappers/03_notcoin/JettonMinter';
import { formatTon, parseAddress, parseTon, requireEnv, requireEnvOneOf } from './utils';

function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function run(provider: NetworkProvider) {
    const sender = provider.sender();
    if (!sender.address) {
        throw new Error('Wallet address not found');
    }

    const { name: envName, value: jettonMinterAddressRaw } = requireEnvOneOf(['JETTON_MINTER_ADDRESS', 'JETTON_MASTER_ADDRESS']);
    const jettonMinterAddress = parseAddress(jettonMinterAddressRaw, envName);
    const jettonMinter = provider.open(JettonMinter.createFromAddress(jettonMinterAddress));

    const nextAdminRaw = requireEnv('NEXT_ADMIN_ADDRESS');
    const nextAdminAddress = parseAddress(nextAdminRaw, 'NEXT_ADMIN_ADDRESS');

    const value = parseTon(process.env.VALUE_TON ?? process.env.VALUE ?? '0.1', 'VALUE_TON');

    const currentNextAdmin = await jettonMinter.getNextAdminAddress();
    if (currentNextAdmin && currentNextAdmin.equals(nextAdminAddress)) {
        console.log('\nAlready set.');
        console.log('JettonMinter.next_admin:', currentNextAdmin.toString());
        return;
    }

    console.log('\n=== JettonMinter: set next admin ===\n');
    console.log('Network:          ', provider.network());
    console.log('Sender wallet:    ', sender.address.toString());
    console.log('JettonMinter:     ', jettonMinter.address.toString());
    console.log('Current next admin:', currentNextAdmin?.toString() ?? 'null');
    console.log('Next admin:       ', nextAdminAddress.toString());
    console.log('Attached value:   ', formatTon(value));

    await sender.send({
        to: jettonMinter.address,
        value,
        body: JettonMinter.changeAdminMessage(nextAdminAddress),
    });

    console.log('\nTransaction sent. Waiting for JettonMinter state update...');

    const attempts = Number(process.env.WAIT_ATTEMPTS ?? '20');
    const sleepMs = Number(process.env.WAIT_SLEEP_MS ?? '2000');
    if (!Number.isFinite(attempts) || attempts <= 0) {
        throw new Error('WAIT_ATTEMPTS must be a positive number');
    }
    if (!Number.isFinite(sleepMs) || sleepMs <= 0) {
        throw new Error('WAIT_SLEEP_MS must be a positive number');
    }

    for (let i = 1; i <= attempts; i++) {
        const nextAdminNow = await jettonMinter.getNextAdminAddress();
        if (nextAdminNow && nextAdminNow.equals(nextAdminAddress)) {
            console.log('\nConfirmed.');
            console.log('JettonMinter.next_admin:', nextAdminNow.toString());
            return;
        }
        console.log(`Not yet (attempt ${i}/${attempts}). next_admin:`, nextAdminNow?.toString() ?? 'null');
        await sleep(sleepMs);
    }

    const nextAdminNow = await jettonMinter.getNextAdminAddress();
    console.log('\nWarning: next_admin was not confirmed in time.');
    console.log('JettonMinter.next_admin:', nextAdminNow?.toString() ?? 'null');
}
