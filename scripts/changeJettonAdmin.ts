import { NetworkProvider } from '@ton/blueprint';
import { MintMaster } from '../wrappers/MintMaster';
import { formatTon, parseAddress, parseBigInt, parseTon, requireEnv, requireEnvOneOf } from './utils';

export async function run(provider: NetworkProvider) {
    const { name: envName, value: mintMasterAddressRaw } = requireEnvOneOf(['MINT_MASTER_ADDRESS', 'MINTER_ADDRESS']);
    const mintMasterAddress = parseAddress(mintMasterAddressRaw, envName);
    const mintMaster = provider.open(MintMaster.createFromAddress(mintMasterAddress));

    const newAdminAddressRaw = requireEnv('NEW_ADMIN_ADDRESS');
    const newAdminAddress = parseAddress(newAdminAddressRaw, 'NEW_ADMIN_ADDRESS');

    const queryId = process.env.QUERY_ID ? parseBigInt(process.env.QUERY_ID, 'QUERY_ID') : 0n;
    const value = parseTon(process.env.VALUE_TON ?? process.env.VALUE ?? '0.2', 'VALUE_TON');

    console.log('\n=== Change Jetton Admin ===\n');
    console.log('MintMaster address: ', mintMaster.address.toString());
    console.log('New admin address:  ', newAdminAddress.toString());
    console.log('QueryId:            ', queryId.toString());
    console.log('Attached value:     ', formatTon(value));

    await mintMaster.sendChangeJettonAdmin(provider.sender(), value, newAdminAddress, queryId);

    console.log('\nTransaction sent.');
}

