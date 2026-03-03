import { CompilerConfig } from '@ton/blueprint';

export const compile: CompilerConfig = {
    // lang: 'func',
    // targets: ['jetton-wallet-not.fc'],
    lang: 'tolk',
    entrypoint: 'contracts/03_notcoin/jetton-wallet-contract.tolk',
    withSrcLineComments: true,
    withStackComments: true,
};
