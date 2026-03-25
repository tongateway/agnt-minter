import { NetworkProvider } from '@ton/blueprint';
import { MintMaster } from '../wrappers/MintMaster';
import { formatTon, parseAddress, parseBigInt, parseTon, requireEnv } from './utils';

function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function run(provider: NetworkProvider) {
    const sender = provider.sender();
    if (!sender.address) {
        throw new Error('Wallet address not found');
    }

    const mintMasterAddressRaw = requireEnv('MINT_MASTER_ADDRESS');
    const mintMasterAddress = parseAddress(mintMasterAddressRaw, 'MINT_MASTER_ADDRESS');
    const mintMaster = provider.open(MintMaster.createFromAddress(mintMasterAddress));

    const nextAdminRaw = requireEnv('NEXT_ADMIN_ADDRESS');
    const nextAdminAddress = parseAddress(nextAdminRaw, 'NEXT_ADMIN_ADDRESS');

    const queryId = process.env.QUERY_ID ? parseBigInt(process.env.QUERY_ID, 'QUERY_ID') : 0n;
    const value = parseTon(process.env.VALUE_TON ?? process.env.VALUE ?? '0.1', 'VALUE_TON');

    const currentNextAdmin = await mintMaster.getNextAdminAddress();
    if (currentNextAdmin && currentNextAdmin.equals(nextAdminAddress)) {
        console.log('\nAlready set.');
        console.log('MintMaster.next_admin:', currentNextAdmin.toString());
        return;
    }

    const masterData = await mintMaster.getMintMasterData();

    console.log('\n=== MintMaster: Set Next Admin ===\n');
    console.log('Network:          ', provider.network());
    console.log('Sender wallet:    ', sender.address.toString());
    console.log('MintMaster:       ', mintMaster.address.toString());
    console.log('Current admin:    ', masterData.adminAddress?.toString() ?? 'null');
    console.log('Current next admin:', currentNextAdmin?.toString() ?? 'null');
    console.log('New next admin:   ', nextAdminAddress.toString());
    console.log('QueryId:          ', queryId.toString());
    console.log('Attached value:   ', formatTon(value));

    await mintMaster.sendChangeMintMasterAdmin(sender, value, nextAdminAddress, queryId);

    console.log('\nTransaction sent. Waiting for MintMaster state update...');

    const attempts = Number(process.env.WAIT_ATTEMPTS ?? '20');
    const sleepMs = Number(process.env.WAIT_SLEEP_MS ?? '2000');

    for (let i = 1; i <= attempts; i++) {
        await sleep(sleepMs);
        const nextAdminNow = await mintMaster.getNextAdminAddress();
        if (nextAdminNow && nextAdminNow.equals(nextAdminAddress)) {
            console.log('\nConfirmed.');
            console.log('MintMaster.next_admin:', nextAdminNow.toString());
            return;
        }
        console.log(`Not yet (attempt ${i}/${attempts}). next_admin:`, nextAdminNow?.toString() ?? 'null');
    }

    const nextAdminNow = await mintMaster.getNextAdminAddress();
    console.log('\nWarning: next_admin was not confirmed in time.');
    console.log('MintMaster.next_admin:', nextAdminNow?.toString() ?? 'null');
}
