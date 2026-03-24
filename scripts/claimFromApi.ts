import { Cell, Address } from '@ton/core';
import { NetworkProvider } from '@ton/blueprint';

import { MintKeeper } from '../wrappers/MintKeeper';
import { formatTon } from './utils';

/**
 * Deploy MintKeeper + send ClaimMint using data from the backend API.
 *
 * Required env vars (all from the API response):
 *   MINT_KEEPER_ADDRESS   — MintKeeper address
 *   STATE_INIT_BOC_HEX    — state_init BOC hex
 *   BODY_BOC_HEX          — ClaimMint body BOC hex
 *   VALUE_NANOTON          — required TON value in nanotons
 */
export async function run(provider: NetworkProvider) {
    const sender = provider.sender();
    if (!sender.address) {
        throw new Error('Wallet address not found');
    }

    const mintKeeperAddress = process.env.MINT_KEEPER_ADDRESS;
    const stateInitHex = process.env.STATE_INIT_BOC_HEX;
    const bodyHex = process.env.BODY_BOC_HEX;
    const valueNanoton = process.env.VALUE_NANOTON;

    if (!mintKeeperAddress || !stateInitHex || !bodyHex || !valueNanoton) {
        throw new Error(
            'Missing env vars. Required: MINT_KEEPER_ADDRESS, STATE_INIT_BOC_HEX, BODY_BOC_HEX, VALUE_NANOTON'
        );
    }

    const keeperAddress = Address.parse(mintKeeperAddress);
    const stateInit = Cell.fromBoc(Buffer.from(stateInitHex, 'hex'))[0];
    const body = Cell.fromBoc(Buffer.from(bodyHex, 'hex'))[0];
    const value = BigInt(valueNanoton);

    // Parse state_init to get code and data cells
    const siSlice = stateInit.beginParse();
    siSlice.loadBit(); // split_depth
    siSlice.loadBit(); // special
    const code = siSlice.loadMaybeRef();
    const data = siSlice.loadMaybeRef();

    if (!code || !data) {
        throw new Error('Invalid state_init: missing code or data');
    }

    console.log('\n=== Claim from API ===\n');
    console.log('Sender:           ', sender.address.toString());
    console.log('MintKeeper:       ', keeperAddress.toString());
    console.log('Value:            ', formatTon(value));

    await sender.send({
        to: keeperAddress,
        value,
        init: { code, data },
        body,
    });

    console.log('\nTransaction sent. Waiting for MintKeeper deployment...');
    await provider.waitForDeploy(keeperAddress);

    const openedKeeper = provider.open(MintKeeper.createFromAddress(keeperAddress));
    const isClaimed = await openedKeeper.getIsMintClaimed();

    console.log('\nMintKeeper deployed.');
    console.log('is_mint_claimed:', isClaimed);
    if (!isClaimed) {
        console.log('Warning: mint not claimed. Check for bounce/refund.');
    }
}
