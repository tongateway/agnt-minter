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

    const queryId = process.env.QUERY_ID ? parseBigInt(process.env.QUERY_ID, 'QUERY_ID') : 0n;
    const value = parseTon(process.env.VALUE_TON ?? process.env.VALUE ?? '0.1', 'VALUE_TON');

    const masterData = await mintMaster.getMintMasterData();
    const nextAdmin = await mintMaster.getNextAdminAddress();

    console.log('\n=== MintMaster: Claim Admin ===\n');
    console.log('Network:          ', provider.network());
    console.log('Sender wallet:    ', sender.address.toString());
    console.log('MintMaster:       ', mintMaster.address.toString());
    console.log('Current admin:    ', masterData.adminAddress?.toString() ?? 'null');
    console.log('Next admin:       ', nextAdmin?.toString() ?? 'null');
    console.log('QueryId:          ', queryId.toString());
    console.log('Attached value:   ', formatTon(value));

    if (!nextAdmin) {
        console.log('\nError: next_admin is not set. Run setMintMasterNextAdmin first.');
        return;
    }

    if (!nextAdmin.equals(sender.address)) {
        console.log(`\nError: sender (${sender.address.toString()}) is not the next_admin (${nextAdmin.toString()}).`);
        console.log('Only the next_admin can claim the admin role.');
        return;
    }

    await mintMaster.sendClaimMintMasterAdmin(sender, value, queryId);

    console.log('\nTransaction sent. Waiting for MintMaster state update...');

    const attempts = Number(process.env.WAIT_ATTEMPTS ?? '20');
    const sleepMs = Number(process.env.WAIT_SLEEP_MS ?? '2000');

    for (let i = 1; i <= attempts; i++) {
        await sleep(sleepMs);
        const data = await mintMaster.getMintMasterData();
        if (data.adminAddress && data.adminAddress.equals(sender.address)) {
            console.log('\nDone. Admin successfully claimed.');
            console.log('MintMaster.admin:', data.adminAddress.toString());
            return;
        }
        console.log(`Not yet (attempt ${i}/${attempts}). admin:`, data.adminAddress?.toString() ?? 'null');
    }

    const finalData = await mintMaster.getMintMasterData();
    console.log('\nWarning: admin claim was not confirmed in time.');
    console.log('MintMaster.admin:', finalData.adminAddress?.toString() ?? 'null');
}
