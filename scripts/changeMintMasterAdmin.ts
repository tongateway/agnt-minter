import { NetworkProvider } from '@ton/blueprint';
import { MintMaster } from '../wrappers/MintMaster';
import { formatTon, parseAddress, parseBigInt, parseTon, requireEnv, requireEnvOneOf } from './utils';

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

    const newAdminRaw = requireEnv('NEW_ADMIN_ADDRESS');
    const newAdminAddress = parseAddress(newAdminRaw, 'NEW_ADMIN_ADDRESS');

    const queryId = process.env.QUERY_ID ? parseBigInt(process.env.QUERY_ID, 'QUERY_ID') : 0n;
    const value = parseTon(process.env.VALUE_TON ?? process.env.VALUE ?? '0.1', 'VALUE_TON');

    const masterData = await mintMaster.getMintMasterData();
    const currentNextAdmin = await mintMaster.getNextAdminAddress();

    console.log('\n=== MintMaster: Change Admin (set next + claim) ===\n');
    console.log('Network:          ', provider.network());
    console.log('Sender wallet:    ', sender.address.toString());
    console.log('MintMaster:       ', mintMaster.address.toString());
    console.log('Current admin:    ', masterData.adminAddress?.toString() ?? 'null');
    console.log('Current next admin:', currentNextAdmin?.toString() ?? 'null');
    console.log('New admin:        ', newAdminAddress.toString());
    console.log('QueryId:          ', queryId.toString());
    console.log('Attached value:   ', formatTon(value));

    // Step 1: ChangeMintMasterAdmin — set nextAdminAddress
    const needsStep1 = !(currentNextAdmin && currentNextAdmin.equals(newAdminAddress));

    if (needsStep1) {
        console.log('\n[Step 1/2] Sending ChangeMintMasterAdmin...');
        await mintMaster.sendChangeMintMasterAdmin(sender, value, newAdminAddress, queryId);

        const attempts = Number(process.env.WAIT_ATTEMPTS ?? '20');
        const sleepMs = Number(process.env.WAIT_SLEEP_MS ?? '2000');

        for (let i = 1; i <= attempts; i++) {
            await sleep(sleepMs);
            const nextAdminNow = await mintMaster.getNextAdminAddress();
            if (nextAdminNow && nextAdminNow.equals(newAdminAddress)) {
                console.log('Confirmed. next_admin:', nextAdminNow.toString());
                break;
            }
            console.log(`Not yet (attempt ${i}/${attempts}). next_admin:`, nextAdminNow?.toString() ?? 'null');
            if (i === attempts) {
                console.log('\nError: ChangeMintMasterAdmin was not confirmed in time. Aborting.');
                return;
            }
        }
    } else {
        console.log('\n[Step 1/2] next_admin already set to target. Skipping.');
    }

    // Step 2: ClaimMintMasterAdmin — new admin claims the role
    if (!newAdminAddress.equals(sender.address)) {
        console.log(`\n[Step 2/2] Cannot auto-claim: new admin (${newAdminAddress.toString()}) is not the sender.`);
        console.log('The new admin must run claimMintMasterAdmin separately.');
        return;
    }

    console.log('\n[Step 2/2] Sending ClaimMintMasterAdmin...');
    await mintMaster.sendClaimMintMasterAdmin(sender, value, queryId);

    const attempts = Number(process.env.WAIT_ATTEMPTS ?? '20');
    const sleepMs = Number(process.env.WAIT_SLEEP_MS ?? '2000');

    for (let i = 1; i <= attempts; i++) {
        await sleep(sleepMs);
        const data = await mintMaster.getMintMasterData();
        if (data.adminAddress && data.adminAddress.equals(newAdminAddress)) {
            console.log('\nDone. Admin successfully changed.');
            console.log('MintMaster.admin:', data.adminAddress.toString());
            return;
        }
        console.log(`Not yet (attempt ${i}/${attempts}). admin:`, data.adminAddress?.toString() ?? 'null');
    }

    const finalData = await mintMaster.getMintMasterData();
    console.log('\nWarning: admin change was not confirmed in time.');
    console.log('MintMaster.admin:', finalData.adminAddress?.toString() ?? 'null');
}
