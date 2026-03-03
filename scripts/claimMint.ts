import { beginCell, toNano } from '@ton/core';
import { compile, NetworkProvider } from '@ton/blueprint';
import { keyPairFromSecretKey, keyPairFromSeed, sign } from '@ton/crypto';
import path from 'path';

import { MintMaster } from '../wrappers/MintMaster';
import { MintKeeper, MintKeeperOpcodes } from '../wrappers/MintKeeper';

import {
    displayPublicKeyInfo,
    formatTon,
    getOrCreateKeyPair,
    hexToBuffer,
    loadKeyPair,
    parseAddress,
    parseBigInt,
    parseTon,
    publicKeyToBigInt,
    requireEnvOneOf,
} from './utils';

export async function run(provider: NetworkProvider) {
    const sender = provider.sender();
    if (!sender.address) {
        throw new Error('Wallet address not found');
    }

    const ownerAddress = sender.address;

    const { name: envName, value: mintMasterAddressRaw } = requireEnvOneOf(['MINT_MASTER_ADDRESS', 'MINTER_ADDRESS']);
    const mintMasterAddress = parseAddress(mintMasterAddressRaw, envName);
    const mintMaster = provider.open(MintMaster.createFromAddress(mintMasterAddress));

    const masterData = await mintMaster.getMintMasterData();

    const serviceKeyPair = (() => {
        const secretKeyRaw = process.env.SERVICE_SECRET_KEY?.trim();
        if (secretKeyRaw) {
            const secretKey = hexToBuffer(secretKeyRaw, 64, 'SERVICE_SECRET_KEY');
            return keyPairFromSecretKey(secretKey);
        }

        const seedRaw = process.env.SERVICE_SEED?.trim();
        if (seedRaw) {
            const seed = hexToBuffer(seedRaw, 32, 'SERVICE_SEED');
            return keyPairFromSeed(seed);
        }

        const keysPath = path.resolve(process.cwd(), '.local/keys/service.keys.json');
        const fromFile = loadKeyPair(keysPath);
        if (fromFile) {
            return fromFile;
        }

        throw new Error('SERVICE_SECRET_KEY or SERVICE_SEED environment variable not set (and no local key file found)');
    })();

    const servicePublicKey = publicKeyToBigInt(serviceKeyPair.publicKey);
    if (servicePublicKey !== masterData.servicePublicKey) {
        throw new Error('Service key mismatch: MintMaster.servicePublicKey differs from provided SERVICE_* key');
    }

    const mintAmount = toNano(process.env.MINT_AMOUNT ?? '1');
    const mintPrice = parseBigInt(process.env.MINT_PRICE ?? '0', 'MINT_PRICE');
    const protocolFee = mintPrice * mintAmount;
    const requiredClaimValue = await mintMaster.getClaimMintRequiredValue(mintPrice, mintAmount);

    let agentPublicKey = process.env.AGENT_WALLET_PUBLIC_KEY
        ? parseBigInt(process.env.AGENT_WALLET_PUBLIC_KEY, 'AGENT_WALLET_PUBLIC_KEY')
        : null;

    if (agentPublicKey === null) {
        const keysPath = path.resolve(process.cwd(), '.local/keys/agent-wallet.keys.json');
        const agentKeys = await getOrCreateKeyPair(keysPath);
        agentPublicKey = publicKeyToBigInt(agentKeys.publicKey);

        console.log('\nAGENT_WALLET_PUBLIC_KEY is not set. Using local AgentWalletV5 keypair.');
        console.log('Key file:', keysPath);
        displayPublicKeyInfo(agentKeys);
        console.log('\nKeep this file private. Do not commit it.');
    }

    const mintKeeperCode = await compile('MintKeeper');
    const mintKeeper = MintKeeper.createFromConfig(
        {
            servicePublicKey,
            mintMasterAddress: mintMasterAddress,
            mintContext: {
                ownerAddress,
                price: mintPrice,
                amount: mintAmount,
                agentPublicKey,
            },
        },
        mintKeeperCode
    );

    const signature = sign(mintKeeper.init!.data.hash(), serviceKeyPair.secretKey);
    const queryId = process.env.QUERY_ID ? parseBigInt(process.env.QUERY_ID, 'QUERY_ID') : 0n;

    const claimBody = beginCell()
        .storeUint(MintKeeperOpcodes.claimMint, 32)
        .storeUint(queryId, 64)
        .storeBuffer(signature)
        .endCell();

    const claimValueOverride = process.env.CLAIM_VALUE_TON ?? process.env.VALUE_TON ?? process.env.VALUE;
    const claimValue = claimValueOverride
        ? parseTon(claimValueOverride, 'CLAIM_VALUE_TON')
        : requiredClaimValue + toNano('0.1');

    console.log('\n=== Claim Mint ===\n');
    console.log('Owner address:     ', ownerAddress.toString());
    console.log('MintMaster address:', mintMaster.address.toString());
    console.log('MintKeeper address:', mintKeeper.address.toString());
    console.log('Service public key:', `0x${servicePublicKey.toString(16)}`);
    console.log('Agent public key:  ', `0x${agentPublicKey.toString(16)}`);
    console.log('');
    console.log('Mint price (raw):  ', mintPrice.toString());
    console.log('Mint amount:       ', mintAmount.toString());
    console.log('Protocol fee:      ', formatTon(protocolFee));
    console.log('Required value:    ', formatTon(requiredClaimValue));
    console.log('Claim value:       ', formatTon(claimValue));

    await sender.send({
        to: mintKeeper.address,
        value: claimValue,
        init: {
            code: mintKeeper.init!.code,
            data: mintKeeper.init!.data,
        },
        body: claimBody,
    });

    console.log('\nTransaction sent. Waiting for MintKeeper deployment...');
    await provider.waitForDeploy(mintKeeper.address);

    const openedKeeper = provider.open(MintKeeper.createFromAddress(mintKeeper.address));
    const isClaimed = await openedKeeper.getIsMintClaimed();

    console.log('\nMintKeeper deployed.');
    console.log('is_mint_claimed:', isClaimed);
    if (!isClaimed) {
        console.log('Warning: mint claim is not marked as claimed. Check for a bounce/refund.');
    }
}
