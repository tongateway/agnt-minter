import { NetworkProvider } from '@ton/blueprint';
import { MintMaster } from '../wrappers/MintMaster';
import { formatTon, parseAddress, parseBigInt, parseBoolean, parseTon, requireEnv, requireEnvOneOf } from './utils';

export async function run(provider: NetworkProvider) {
    const { name: envName, value: mintMasterAddressRaw } = requireEnvOneOf(['MINT_MASTER_ADDRESS', 'MINTER_ADDRESS']);
    const mintMasterAddress = parseAddress(mintMasterAddressRaw, envName);
    const mintMaster = provider.open(MintMaster.createFromAddress(mintMasterAddress));

    const enableMint = parseBoolean(requireEnv('MINT_ENABLED'), 'MINT_ENABLED');
    const queryId = process.env.QUERY_ID ? parseBigInt(process.env.QUERY_ID, 'QUERY_ID') : 0n;
    const value = parseTon(process.env.VALUE_TON ?? process.env.VALUE ?? '0.05', 'VALUE_TON');

    console.log('\n=== Toggle Mint ===\n');
    console.log('MintMaster address:', mintMaster.address.toString());
    console.log('Enable mint:      ', enableMint);
    console.log('QueryId:          ', queryId.toString());
    console.log('Attached value:   ', formatTon(value));

    await mintMaster.sendToggleMint(provider.sender(), value, enableMint, queryId);

    console.log('\nTransaction sent.');
}

