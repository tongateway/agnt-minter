import { NetworkProvider } from '@ton/blueprint';
import { MintMaster } from '../wrappers/MintMaster';
import { formatTon, parseAddress, requireEnvOneOf } from './utils';

export async function run(provider: NetworkProvider) {
    const { name: envName, value: mintMasterAddressRaw } = requireEnvOneOf(['MINT_MASTER_ADDRESS', 'MINTER_ADDRESS']);

    const mintMasterAddress = parseAddress(mintMasterAddressRaw, envName);
    const mintMaster = provider.open(MintMaster.createFromAddress(mintMasterAddress));

    console.log('\n=== MintMaster Info ===\n');
    console.log('MintMaster address:', mintMaster.address.toString());

    const data = await mintMaster.getMintMasterData();
    console.log('\nState:');
    console.log('  Mint enabled:        ', data.isMintEnabled);
    console.log('  Admin address:       ', data.adminAddress.toString());
    console.log('  JettonMinter address:', data.jettonMinterAddress.toString());
    console.log('  Service public key:  ', `0x${data.servicePublicKey.toString(16)}`);

    const balance = await mintMaster.getBalance();
    const minStorageFee = await mintMaster.getMinStorageFee();

    console.log('\nAccounting:');
    console.log('  Balance:        ', formatTon(balance));
    console.log('  Min storage fee:', formatTon(minStorageFee));
}

