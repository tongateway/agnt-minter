import { NetworkProvider } from '@ton/blueprint';
import { JettonMinter } from '../wrappers/03_notcoin/JettonMinter';
import { formatTon, parseAddress, parseBigInt, parseTon, requireEnvOneOf } from './utils';

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

    const queryId = process.env.QUERY_ID ? parseBigInt(process.env.QUERY_ID, 'QUERY_ID') : 0n;
    const value = parseTon(process.env.VALUE_TON ?? process.env.VALUE ?? '0.1', 'VALUE_TON');

    const jettonData = await jettonMinter.getJettonData();
    const nextAdmin = await jettonMinter.getNextAdminAddress();

    console.log('\n=== JettonMinter: Claim Admin ===\n');
    console.log('Network:          ', provider.network());
    console.log('Sender wallet:    ', sender.address.toString());
    console.log('JettonMinter:     ', jettonMinter.address.toString());
    console.log('Current admin:    ', jettonData.adminAddress?.toString() ?? 'null');
    console.log('Next admin:       ', nextAdmin?.toString() ?? 'null');
    console.log('QueryId:          ', queryId.toString());
    console.log('Attached value:   ', formatTon(value));

    if (!nextAdmin) {
        console.log('\nError: next_admin is null. Call setJettonNextAdmin first (ChangeMinterAdmin).');
        return;
    }

    if (!nextAdmin.equals(sender.address)) {
        console.log(`\nError: next_admin (${nextAdmin.toString()}) does not match sender (${sender.address.toString()}).`);
        console.log('Only the next_admin can claim the admin role.');
        return;
    }

    await jettonMinter.sendClaimAdmin(sender, queryId);

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
        const currentAdmin = await jettonMinter.getAdminAddress();
        if (currentAdmin && currentAdmin.equals(sender.address)) {
            console.log('\nConfirmed. Admin successfully claimed.');
            console.log('JettonMinter.admin:', currentAdmin.toString());
            return;
        }
        console.log(`Not yet (attempt ${i}/${attempts}). admin:`, currentAdmin?.toString() ?? 'null');
        await sleep(sleepMs);
    }

    const finalAdmin = await jettonMinter.getAdminAddress();
    console.log('\nWarning: admin change was not confirmed in time.');
    console.log('JettonMinter.admin:', finalAdmin?.toString() ?? 'null');
}
