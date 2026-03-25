import { NetworkProvider } from '@ton/blueprint';
import { JettonMinter } from '../wrappers/03_notcoin/JettonMinter';
import { formatTon, parseAddress, parseBigInt, parseTon, requireEnv, requireEnvOneOf } from './utils';

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

    const newAdminRaw = requireEnv('NEW_ADMIN_ADDRESS');
    const newAdminAddress = parseAddress(newAdminRaw, 'NEW_ADMIN_ADDRESS');

    const queryId = process.env.QUERY_ID ? parseBigInt(process.env.QUERY_ID, 'QUERY_ID') : 0n;
    const value = parseTon(process.env.VALUE_TON ?? process.env.VALUE ?? '0.1', 'VALUE_TON');

    const jettonData = await jettonMinter.getJettonData();
    const currentNextAdmin = await jettonMinter.getNextAdminAddress();

    console.log('\n=== JettonMinter: Change Admin (set next + claim) ===\n');
    console.log('Network:          ', provider.network());
    console.log('Sender wallet:    ', sender.address.toString());
    console.log('JettonMinter:     ', jettonMinter.address.toString());
    console.log('Current admin:    ', jettonData.adminAddress?.toString() ?? 'null');
    console.log('Current next admin:', currentNextAdmin?.toString() ?? 'null');
    console.log('New admin:        ', newAdminAddress.toString());
    console.log('QueryId:          ', queryId.toString());
    console.log('Attached value:   ', formatTon(value));

    // Step 1: ChangeMinterAdmin — set nextAdminAddress
    const needsStep1 = !(currentNextAdmin && currentNextAdmin.equals(newAdminAddress));

    if (needsStep1) {
        console.log('\n[Step 1/2] Sending ChangeMinterAdmin...');
        await jettonMinter.sendChangeAdmin(sender, newAdminAddress);

        const attempts = Number(process.env.WAIT_ATTEMPTS ?? '20');
        const sleepMs = Number(process.env.WAIT_SLEEP_MS ?? '2000');

        for (let i = 1; i <= attempts; i++) {
            await sleep(sleepMs);
            const nextAdminNow = await jettonMinter.getNextAdminAddress();
            if (nextAdminNow && nextAdminNow.equals(newAdminAddress)) {
                console.log('Confirmed. next_admin:', nextAdminNow.toString());
                break;
            }
            console.log(`Not yet (attempt ${i}/${attempts}). next_admin:`, nextAdminNow?.toString() ?? 'null');
            if (i === attempts) {
                console.log('\nError: ChangeMinterAdmin was not confirmed in time. Aborting.');
                return;
            }
        }
    } else {
        console.log('\n[Step 1/2] next_admin already set to target. Skipping.');
    }

    // Step 2: ClaimMinterAdmin — new admin claims the role
    if (!newAdminAddress.equals(sender.address)) {
        console.log(`\n[Step 2/2] Cannot auto-claim: new admin (${newAdminAddress.toString()}) is not the sender.`);
        console.log('The new admin must run claimMinterAdmin separately.');
        return;
    }

    console.log('\n[Step 2/2] Sending ClaimMinterAdmin...');
    await jettonMinter.sendClaimAdmin(sender, queryId);

    const attempts = Number(process.env.WAIT_ATTEMPTS ?? '20');
    const sleepMs = Number(process.env.WAIT_SLEEP_MS ?? '2000');

    for (let i = 1; i <= attempts; i++) {
        await sleep(sleepMs);
        const adminNow = await jettonMinter.getAdminAddress();
        if (adminNow && adminNow.equals(newAdminAddress)) {
            console.log('\nDone. Admin successfully changed.');
            console.log('JettonMinter.admin:', adminNow.toString());
            return;
        }
        console.log(`Not yet (attempt ${i}/${attempts}). admin:`, adminNow?.toString() ?? 'null');
    }

    const finalAdmin = await jettonMinter.getAdminAddress();
    console.log('\nWarning: admin change was not confirmed in time.');
    console.log('JettonMinter.admin:', finalAdmin?.toString() ?? 'null');
}
