import { NetworkProvider } from '@ton/blueprint';
import { MintMaster } from '../wrappers/MintMaster';
import { formatTon, parseAddress, parseTon, requireEnvOneOf } from './utils';

export async function run(provider: NetworkProvider) {
    const { name: envName, value: mintMasterAddressRaw } = requireEnvOneOf(['MINT_MASTER_ADDRESS', 'MINTER_ADDRESS']);
    const mintMasterAddress = parseAddress(mintMasterAddressRaw, envName);
    const mintMaster = provider.open(MintMaster.createFromAddress(mintMasterAddress));

    const value = parseTon(process.env.VALUE_TON ?? process.env.VALUE ?? '0.05', 'VALUE_TON');

    console.log('\n=== TopUp TONs ===\n');
    console.log('MintMaster address:', mintMaster.address.toString());
    console.log('Attached value:   ', formatTon(value));

    await mintMaster.sendTopUpTons(provider.sender(), value);

    console.log('\nTransaction sent.');
}

