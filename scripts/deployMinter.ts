import { toNano } from '@ton/core';
import { MintMaster } from '../wrappers/MintMaster';
import { compile, NetworkProvider } from '@ton/blueprint';
import path from 'path';
import { displayPublicKeyInfo, formatTon, getOrCreateKeyPair, parseAddress, parseBigInt, requireEnv, publicKeyToBigInt } from './utils';

export async function run(provider: NetworkProvider) {
    const adminAddress = provider.sender().address;
    if (!adminAddress) {
        throw new Error('Wallet address not found');
    }

    const jettonMinterAddressRaw = requireEnv('JETTON_MINTER_ADDRESS');
    const jettonMinterAddress = parseAddress(jettonMinterAddressRaw, 'JETTON_MINTER_ADDRESS');

    const isMintEnabled = process.env.MINT_ENABLED !== 'false';

    let servicePublicKey: bigint;
    const servicePublicKeyRaw = process.env.SERVICE_PUBLIC_KEY?.trim();
    if (servicePublicKeyRaw) {
        servicePublicKey = parseBigInt(servicePublicKeyRaw, 'SERVICE_PUBLIC_KEY');
    } else {
        const keysPath = path.resolve(process.cwd(), '.local/keys/service.keys.json');
        const keys = await getOrCreateKeyPair(keysPath);
        servicePublicKey = publicKeyToBigInt(keys.publicKey);

        console.log('\nSERVICE_PUBLIC_KEY is not set. Using local service keypair.');
        console.log('Key file:', keysPath);
        displayPublicKeyInfo(keys);
        console.log('\nKeep this file private. Do not commit it.');
    }

    console.log('\n=== Deploy MintMaster ===\n');
    console.log('Admin address:        ', adminAddress.toString());
    console.log('JettonMinter address: ', jettonMinterAddress.toString());
    console.log('Mint enabled:         ', isMintEnabled);
    console.log('Service public key:   ', `0x${servicePublicKey.toString(16)}`);

    const mintMasterCode = await compile('MintMaster');
    const mintMaster = provider.open(MintMaster.createFromConfig({
        isMintEnabled,
        servicePublicKey,
        jettonMinterAddress,
        adminAddress,
    }, mintMasterCode));

    const deployValue = toNano(process.env.DEPLOY_VALUE_TON ?? '0.5');

    console.log('\nMintMaster address:', mintMaster.address.toString());
    console.log('Deploy value:     ', formatTon(deployValue));

    await mintMaster.sendDeploy(provider.sender(), deployValue);
    await provider.waitForDeploy(mintMaster.address);

    console.log('\n=== Deployment Complete ===');
    console.log('MintMaster deployed at:', mintMaster.address.toString());
    console.log('\nExports:');
    console.log(`  export MINT_MASTER_ADDRESS="${mintMaster.address.toString()}"`);
}
